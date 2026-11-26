import fs from 'node:fs';
import path from 'node:path';
import type { McpConfig, McpServerConfig } from '../../shared/types';
import type { ExtensionManifest } from '../../shared/extensionManifest';
import type { ExtensionDomainInstanceIdentity } from '../../shared/extensionDomain';
import type { GuiHostTool, GuiToolExecContext } from '../agentSession/types';
import { McpHub, type McpToolInfo } from '../agent/mcpHub';
import type { ExtensionAgentResourceMount } from './extensionAgentResources';
import { ExtensionIsolatedMcpDescriptorRuntime } from './extensionIsolatedRuntime';

/**
 * A extension MCP descriptor is an extension-package module that returns one regular
 * McpServerConfig. The host owns the client connection; the extension never
 * receives the Pi session or a global MCP configuration object.
 */
export interface ExtensionMcpDescriptorInput {
  identity: ExtensionDomainInstanceIdentity;
  manifest: ExtensionManifest;
  packageRoot: string;
  descriptorPath: string;
  sessionId: string;
}

export type ExtensionMcpDescriptorFactory =
  | McpServerConfig
  | ((input: ExtensionMcpDescriptorInput) => McpServerConfig | Promise<McpServerConfig>);

export interface ExtensionMcpDescriptorModule {
  default?: ExtensionMcpDescriptorFactory;
  mcp?: ExtensionMcpDescriptorFactory;
  createMcpDescriptor?: ExtensionMcpDescriptorFactory;
}

export interface ExtensionMcpHubLike {
  listAllTools(allowed?: ReadonlySet<string>): Promise<McpToolInfo[]>;
  callToolResult(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    beforeCall?: () => void
  ): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export interface ExtensionMcpSessionManagerOptions {
  createHub?: (config: McpConfig) => ExtensionMcpHubLike;
  loadModule?: (file: string, input: ExtensionMcpDescriptorInput, fingerprint: string) => Promise<ExtensionMcpDescriptorFactory>;
  runtimeWorkerFile?: string;
}

interface BoundTool {
  info: McpToolInfo;
  id: string;
}

interface Session {
  identity: ExtensionDomainInstanceIdentity;
  manifest: ExtensionManifest;
  packageRoot: string;
  hub: ExtensionMcpHubLike;
  tools: Map<string, BoundTool>;
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertDescriptorFile(packageRoot: string, file: string): string {
  const root = fs.realpathSync(packageRoot);
  const candidate = path.resolve(file);
  if (!inside(root, candidate)) throw new Error('extension MCP descriptor 越过扩展包根');
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('extension MCP descriptor 不是普通文件');
  const real = fs.realpathSync(candidate);
  if (!inside(root, real) || !real.toLowerCase().endsWith('.mjs')) throw new Error('extension MCP descriptor 路径不合法');
  return real;
}

function stringList(value: unknown, label: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || item.length > 4096)) {
    throw new Error(`extension MCP ${label} 不合法`);
  }
  return [...value] as string[];
}

function validateDescriptor(raw: McpServerConfig, packageRoot: string, fallbackName: string): McpServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('extension MCP descriptor must return an object');
  const name = safeSegment(typeof raw.name === 'string' ? raw.name : '', fallbackName);
  if (name.length > 96) throw new Error('extension MCP server name 过长');
  if (raw.transport !== 'stdio' && raw.transport !== 'http') throw new Error(`extension MCP ${name} transport 不合法`);
  const cfg: McpServerConfig = {
    name,
    enabled: true,
    transport: raw.transport
  };
  if (raw.transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error(`extension MCP ${name} 缺少 stdio command`);
    cfg.command = raw.command.trim();
    cfg.args = stringList(raw.args, 'args', 128) ?? [];
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) throw new Error(`extension MCP ${name} cwd 不合法`);
      const cwd = path.resolve(packageRoot, raw.cwd);
      if (!inside(packageRoot, cwd)) throw new Error(`extension MCP ${name} cwd 越过扩展包根`);
      cfg.cwd = cwd;
    } else {
      cfg.cwd = packageRoot;
    }
    if (raw.env !== undefined) {
      if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) throw new Error(`extension MCP ${name} env 不合法`);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 16 * 1024) {
          throw new Error(`extension MCP ${name} env 不合法`);
        }
        env[key] = value;
      }
      cfg.env = env;
    }
  } else {
    if (typeof raw.url !== 'string' || !raw.url.trim()) throw new Error(`extension MCP ${name} 缺少 url`);
    let url: URL;
    try { url = new URL(raw.url); } catch { throw new Error(`extension MCP ${name} url 不合法`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`extension MCP ${name} 只允许 http(s) url`);
    cfg.url = url.toString();
    if (raw.headers !== undefined) {
      if (!raw.headers || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) throw new Error(`extension MCP ${name} headers 不合法`);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.headers)) {
        if (!key.trim() || typeof value !== 'string' || value.length > 16 * 1024) throw new Error(`extension MCP ${name} headers 不合法`);
        headers[key] = value;
      }
      cfg.headers = headers;
    }
  }
  return cfg;
}

function jsonResult(value: unknown): string {
  try { return JSON.stringify(value); } catch { return JSON.stringify({ ok: false, error: 'MCP result is not serializable' }); }
}

/**
 * One MCP client hub per extension Pi session. It deliberately uses the existing
 * McpHub transport, timeout, redaction and stdio cleanup implementation, but
 * never inserts extension descriptors into the user/global MCP config.
 */
export class ExtensionMcpSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly createHub: (config: McpConfig) => ExtensionMcpHubLike;
  private readonly loadModuleOverride?: ExtensionMcpSessionManagerOptions['loadModule'];
  private readonly runtimeWorkerFile?: string;

  constructor(options?: ExtensionMcpSessionManagerOptions) {
    this.createHub = options?.createHub ?? (config => new McpHub(config));
    this.loadModuleOverride = options?.loadModule;
    this.runtimeWorkerFile = options?.runtimeWorkerFile;
  }

  async open(input: {
    sessionId: string;
    identity: ExtensionDomainInstanceIdentity;
    manifest: ExtensionManifest;
    packageRoot: string;
    resources: ExtensionAgentResourceMount;
  }): Promise<readonly GuiHostTool[]> {
    const { sessionId, identity, manifest, packageRoot, resources } = input;
    if (!manifest.agent || manifest.surface.kind !== 'sidebar') throw new Error('extension MCP session requires an AI sidebar manifest');
    if (identity.extensionId !== manifest.id || resources.extensionId !== manifest.id || resources.sessionId !== sessionId || resources.extensionInstanceId !== identity.extensionInstanceId || resources.packageFingerprint !== identity.packageFingerprint) {
      throw new Error('extension MCP resource mount identity mismatch');
    }
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.identity.extensionInstanceId !== identity.extensionInstanceId || existing.identity.packageFingerprint !== identity.packageFingerprint || existing.manifest.id !== manifest.id) {
        throw new Error('extension MCP session identity changed');
      }
      return this.toolsForSession(sessionId);
    }
    if (!resources.mcp.length) return [];
    if (!manifest.permissions.includes('agent.mcp')) throw new Error('扩展 Agent MCP 未声明 agent.mcp 权限');
    if (resources.trust === 'untrusted') throw new Error('扩展 Agent MCP 需要显式信任');

    const descriptors: McpServerConfig[] = [];
    for (let index = 0; index < resources.mcp.length; index++) {
      const resource = resources.mcp[index];
      const descriptorFile = assertDescriptorFile(packageRoot, resource.absolutePath);
      const fallbackName = `mcp-${index + 1}-${safeSegment(path.basename(resource.relativePath, path.extname(resource.relativePath)), 'server')}`;
      const inputForModule: ExtensionMcpDescriptorInput = { identity: structuredClone(identity), manifest: structuredClone(manifest), packageRoot, descriptorPath: resource.relativePath, sessionId };
      const factory = this.loadModuleOverride
        ? await this.loadModuleOverride(descriptorFile, inputForModule, identity.packageFingerprint)
        : await this.loadModuleInWorker(inputForModule);
      const raw = typeof factory === 'function' ? await factory(inputForModule) : factory;
      const config = validateDescriptor(raw, packageRoot, fallbackName);
      if (descriptors.some(item => item.name === config.name)) throw new Error(`extension MCP server 名称重复：${config.name}`);
      descriptors.push(config);
    }
    const hub = this.createHub({ enabled: true, servers: descriptors });
    try {
      const infos = await hub.listAllTools();
      const tools = new Map<string, BoundTool>();
      for (const info of infos) {
        if (info.name === '(connect-error)') throw new Error(`extension MCP ${info.server} 连接失败：${info.description}`);
        const serverName = safeSegment(info.server, 'server');
        const toolName = safeSegment(info.name, 'tool');
        if (serverName.length > 96 || toolName.length > 128) throw new Error(`extension MCP 工具名称过长：${info.name}`);
        const id = `ext.${manifest.id}.mcp.${serverName}.${toolName}`;
        if (tools.has(id)) throw new Error(`extension MCP 工具名称冲突：${id}`);
        tools.set(id, { info, id });
      }
      const session: Session = { identity: structuredClone(identity), manifest: structuredClone(manifest), packageRoot, hub, tools };
      this.sessions.set(sessionId, session);
      return this.toolsForSession(sessionId);
    } catch (error) {
      await hub.close().catch(() => {});
      throw error;
    }
  }

  toolsForSession(sessionId: string): GuiHostTool[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return [...session.tools.values()].map(bound => ({
      id: bound.id,
      label: bound.info.name,
      description: bound.info.description || `调用 ${bound.info.server} 的 ${bound.info.name}。`,
      parameters: (bound.info.inputSchema && typeof bound.info.inputSchema === 'object' && !Array.isArray(bound.info.inputSchema))
        ? bound.info.inputSchema as Record<string, unknown>
        : { type: 'object', additionalProperties: true },
      permissionClass: 'mcp' as const,
      resultFormat: 'execute-result-json' as const,
      execute: async (args: Record<string, unknown>, ctx: GuiToolExecContext): Promise<string> => {
        if (ctx.sessionId !== sessionId) throw new Error('extension MCP session identity mismatch');
        if (ctx.signal?.aborted) throw new Error('extension MCP call aborted');
        const result = await session.hub.callToolResult(bound.info.server, bound.info.name, args, () => {
          if (ctx.signal?.aborted) throw new Error('extension MCP call aborted');
        });
        return result.isError ? jsonResult({ ok: false, error: result.text }) : jsonResult({ ok: true, result: result.text });
      }
    }));
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.hub.close();
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const results = await Promise.allSettled(sessions.map(session => session.hub.close()));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'extension MCP session cleanup failed');
  }

  private async loadModuleInWorker(input: ExtensionMcpDescriptorInput): Promise<ExtensionMcpDescriptorFactory> {
    const runtime = new ExtensionIsolatedMcpDescriptorRuntime({
      identity: input.identity,
      manifest: input.manifest,
      packageRoot: input.packageRoot,
      entry: input.descriptorPath,
      ...(this.runtimeWorkerFile ? { workerFile: this.runtimeWorkerFile } : {})
    });
    try {
      return await runtime.load({ descriptorPath: input.descriptorPath, sessionId: input.sessionId }) as ExtensionMcpDescriptorFactory;
    } finally {
      await runtime.close();
    }
  }
}

