import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionManifest } from '../../shared/extensionManifest';

const SYSTEM_PROMPT_MAX_BYTES = 64 * 1024;
const RESOURCE_MAX_BYTES = 256 * 1024;

export type ExtensionMcpTrust = 'untrusted' | 'trusted-once' | 'trusted-persistent';

export interface ExtensionAgentResourceFile {
  relativePath: string;
  absolutePath: string;
}

export interface ExtensionAgentResourceMount {
  sessionId: string;
  extensionId: string;
  extensionInstanceId: string;
  packageFingerprint: string;
  systemPrompt?: string;
  skills: ExtensionAgentResourceFile[];
  mcp: ExtensionAgentResourceFile[];
  trust: ExtensionMcpTrust;
}

export interface MountExtensionAgentResourcesInput {
  packageRoot: string;
  manifest: ExtensionManifest;
  sessionId: string;
  extensionInstanceId: string;
  packageFingerprint: string;
  mcpTrust?: ExtensionMcpTrust;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readPackageFile(root: string, relativePath: string, maxBytes: number): Promise<ExtensionAgentResourceFile> {
  const packageRoot = await fs.promises.realpath(root);
  const candidate = path.resolve(packageRoot, ...relativePath.split('/'));
  if (!inside(packageRoot, candidate)) throw new Error(`扩展 Agent 资源越过包根：${relativePath}`);
  const stat = await fs.promises.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`扩展 Agent 资源不是普通文件：${relativePath}`);
  const real = await fs.promises.realpath(candidate);
  if (!inside(packageRoot, real)) throw new Error(`扩展 Agent 资源真实路径越过包根：${relativePath}`);
  if (stat.size > maxBytes) throw new Error(`扩展 Agent 资源过大：${relativePath}`);
  return { relativePath, absolutePath: real };
}

async function readSystemPrompt(root: string, relativePath: string | undefined): Promise<string | undefined> {
  if (!relativePath) return undefined;
  const file = await readPackageFile(root, relativePath, SYSTEM_PROMPT_MAX_BYTES);
  return fs.promises.readFile(file.absolutePath, 'utf8');
}

async function resourceFiles(root: string, paths: readonly string[], maxBytes: number): Promise<ExtensionAgentResourceFile[]> {
  return Promise.all(paths.map(relativePath => readPackageFile(root, relativePath, maxBytes)));
}

/**
 * Validated per-session resource mounts for extension Extension Agent sessions.
 *
 * This object deliberately does not mutate global MCP configuration or execute
 * extension modules. The caller that owns the Pi connection uses the returned
 * descriptors to register the resources in that one session. MCP descriptors
 * are only returned after an explicit trust decision.
 */
export class ExtensionAgentResourceManager {
  private readonly mounts = new Map<string, ExtensionAgentResourceMount>();

  async mount(input: MountExtensionAgentResourcesInput): Promise<ExtensionAgentResourceMount> {
    if (!input.sessionId.trim() || !input.extensionInstanceId.trim() || !input.packageFingerprint.trim()) {
      throw new Error('扩展 Agent 资源挂载缺少会话或包身份');
    }
    if (input.manifest.surface.kind !== 'sidebar' || !input.manifest.agent) {
      throw new Error('只有声明 agent 的 sidebar 扩展可以挂载 Agent 资源');
    }
    const trust = input.mcpTrust ?? 'untrusted';
    const existing = this.mounts.get(input.sessionId);
    if (existing) {
      if (existing.extensionInstanceId !== input.extensionInstanceId || existing.packageFingerprint !== input.packageFingerprint) {
        throw new Error('扩展 Agent 会话已绑定其他包');
      }
      return existing;
    }
    const mcpPaths = input.manifest.agent.mcp;
    if (mcpPaths.length && !input.manifest.permissions.includes('agent.mcp')) {
      throw new Error('扩展 Agent MCP 未声明 agent.mcp 权限');
    }
    if (mcpPaths.length && trust === 'untrusted') {
      throw new Error('扩展 Agent MCP 需要显式信任');
    }
    if (!input.manifest.agent.skills.every(item => item.length <= 512) || !mcpPaths.every(item => item.length <= 512)) {
      throw new Error('扩展 Agent 资源路径过长');
    }
    const mount: ExtensionAgentResourceMount = {
      sessionId: input.sessionId,
      extensionId: input.manifest.id,
      extensionInstanceId: input.extensionInstanceId,
      packageFingerprint: input.packageFingerprint,
      systemPrompt: await readSystemPrompt(input.packageRoot, input.manifest.agent.systemPrompt),
      skills: await resourceFiles(input.packageRoot, input.manifest.agent.skills, RESOURCE_MAX_BYTES),
      mcp: await resourceFiles(input.packageRoot, mcpPaths, RESOURCE_MAX_BYTES),
      trust
    };
    this.mounts.set(input.sessionId, mount);
    return mount;
  }

  get(sessionId: string): ExtensionAgentResourceMount | undefined {
    return this.mounts.get(sessionId);
  }

  async readSkill(sessionId: string, relativePath: string, resource?: string): Promise<string> {
    const mount = this.mounts.get(sessionId);
    if (!mount) throw new Error('extension Agent resource session is not mounted');
    const skill = mount.skills.find(item => item.relativePath === relativePath);
    if (!skill) throw new Error('extension Agent skill is not declared for this session');
    if (resource !== undefined) {
      if (!resource || resource.includes('\\') || resource.includes(':') || resource.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid skill resource path');
      const file = await readPackageFile(path.dirname(skill.absolutePath), resource, RESOURCE_MAX_BYTES);
      return fs.promises.readFile(file.absolutePath, 'utf8');
    }
    const stat = await fs.promises.lstat(skill.absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RESOURCE_MAX_BYTES) throw new Error('extension Agent skill is unavailable');
    return fs.promises.readFile(skill.absolutePath, 'utf8');
  }

  release(sessionId: string): void {
    this.mounts.delete(sessionId);
  }

  close(): void {
    this.mounts.clear();
  }
}

/** Prompt material for a Pi session. Skill bodies remain lazy resources. */
export function formatExtensionAgentResourcePrompt(mount: ExtensionAgentResourceMount): string {
  const sections = [
    '这是一个与人共用界面的扩展 Agent。扩展状态不会因人的操作自动发送到本会话，也不会自动触发新一轮模型调用。需要回答当前状态时，先调用当前扩展提供的 state.snapshot 或查询工具；需要改变状态时，只使用当前扩展声明的领域命令工具。',
    mount.systemPrompt?.trim() ?? ''
  ];
  if (mount.skills.length) {
    sections.push(`扩展技能（需要时按路径读取）：\n${mount.skills.map(item => `- ${item.relativePath}: ${item.absolutePath}`).join('\n')}`);
  }
  if (mount.mcp.length) {
    sections.push(`扩展 MCP 资源已按当前会话信任挂载：\n${mount.mcp.map(item => `- ${item.relativePath}`).join('\n')}`);
  }
  return sections.filter(Boolean).join('\n\n');
}
