import crypto from 'node:crypto';
import type { AppConfig, McpServerConfig } from '../../shared/types';
import type { ManagedMcpEntry, McpManagementScope, McpManagementInventory, McpSaveInput, McpRemoveInput, McpImportInput, McpConnectionTestResult } from '../../shared/mcpManagement';
import { parseMcpJsonText, sanitizeMcpServers } from '../../shared/mcpConfig';
import { testMcpConnection, validateManagedMcp } from './mcpConnectionTest';
import { t } from '../../shared/i18n';

/**
 * Third-party MCP reaches engines only through the host relay (mcp.search /
 * mcp.call, capability-delivery B1). This service now manages the server list
 * only: stdio/HTTP entries with credentials, plus connection tests whose result
 * semantics follow the MCP master switch — relay-disabled (no handshake) when
 * the switch is off; a direct initialize + tools/list handshake verifying the
 * server configuration when it is on.
 * The per-engine deployment subsystem (native discovery / adoption / ownership
 * ledgers / drift observation / targetIds routing) was retired in B4; legacy
 * data files (mcp-native-origins.json / mcp-native-ownership.json /
 * mcp-native-status.json) stay on disk untouched and are no longer displayed.
 */
export interface McpManagementDeps {
  getConfig: () => AppConfig;
  updateConfig: (patch: Partial<AppConfig>) => unknown | Promise<unknown>;
  workspaceRoot: (workspaceId: string) => string | undefined;
  testConnection?: typeof testMcpConnection;
}

type Identity = { scope: McpManagementScope; workspaceId?: string; name: string };
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const identityId = (value: Identity): string => `mcp:${Buffer.from(JSON.stringify({ scope: value.scope, ...(value.scope === 'project' ? { workspaceId: value.workspaceId } : {}), name: value.name })).toString('base64url')}`;
const fingerprint = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function parseIdentity(id: string): Identity {
  if (!id.startsWith('mcp:')) throw new Error(t('MCP 条目 id 无效'));
  let value: Identity;
  try { value = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8')); } catch { throw new Error(t('MCP 条目 id 无效')); }
  if (!value || !['global', 'project'].includes(value.scope) || typeof value.name !== 'string' || !value.name.trim() || (value.scope === 'project' && !value.workspaceId)) throw new Error(t('MCP 条目 id 无效'));
  return value;
}

function masked(server: McpServerConfig): McpServerConfig {
  const hide = (map?: Record<string, string>) => map ? Object.fromEntries(Object.entries(map).map(([key, value]) => [key, value ? '***' : ''])) : undefined;
  return { ...structuredClone(server), env: hide(server.env), headers: hide(server.headers) };
}

function secretMap(incoming: Record<string, string> | undefined, previous: Record<string, string> | undefined): Record<string, string> | undefined {
  if (incoming === undefined) return previous ? { ...previous } : undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!key.trim() || typeof value !== 'string') continue;
    if (value === '***') {
      if (!previous || !has(previous, key)) throw new Error(t('凭证 {{key}} 没有已保存的值，请填写真实内容', { key }));
      Object.defineProperty(result, key, { value: previous[key], enumerable: true, configurable: true, writable: true });
    } else if (value) Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return Object.keys(result).length ? result : undefined;
}

export class McpManagementService {
  private revisions = new Map<string, { fingerprint: string; token: string }>();
  private tests = new Map<string, { fingerprint: string; result: McpConnectionTestResult }>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: McpManagementDeps) {}

  dispose(): void {
    this.revisions.clear(); this.tests.clear();
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(job);
    this.tail = next;
    return next;
  }

  private revision(key: string, value: unknown): string {
    const current = fingerprint(value);
    const previous = this.revisions.get(key);
    if (previous?.fingerprint === current) return previous.token;
    const token = crypto.randomUUID();
    this.revisions.set(key, { fingerprint: current, token });
    return token;
  }

  private listScope(scope: McpManagementScope, workspaceId?: string): McpServerConfig[] {
    if (scope === 'global') return this.deps.getConfig().mcp.servers;
    if (!workspaceId || !this.deps.workspaceRoot(workspaceId)) throw new Error(t('请先选择有效工作区'));
    return this.deps.getConfig().mcpByWorkspace?.[workspaceId] ?? [];
  }

  private entry(identity: Identity, server: McpServerConfig): ManagedMcpEntry {
    const id = identityId(identity);
    const tested = this.tests.get(id);
    // 测试结果只在与「产出时的总开关状态」一致时展示：relay-disabled 结果只在关闭时
    // 成立，握手结果只在开启时成立。开关切换后旧结果不再代表当前可用性（例如关掉
    // 总开关后不能再展示「握手成功」，开着开关也不能展示「中转未启用」）。
    const switchMatches = tested
      ? (tested.result.status === 'relay-disabled') !== this.deps.getConfig().mcp.enabled
      : false;
    return { id, scope: identity.scope, workspaceId: identity.workspaceId, server: masked(server), revision: this.revision(id, server), ...(tested?.fingerprint === fingerprint(server) && switchMatches ? { test: tested.result } : {}) };
  }

  private find(id: string): { identity: Identity; server: McpServerConfig } {
    const identity = parseIdentity(id);
    const server = this.listScope(identity.scope, identity.workspaceId).find(server => server.name === identity.name);
    if (!server) throw new Error(t('MCP 条目已不存在，请刷新'));
    return { identity, server };
  }

  async get(id: string): Promise<ManagedMcpEntry> {
    const { identity, server } = this.find(id);
    return this.entry(identity, server);
  }

  async list(workspaceId?: string): Promise<McpManagementInventory> {
    const cfg = this.deps.getConfig();
    const project = workspaceId ? this.listScope('project', workspaceId) : [];
    const overrides = new Set(project.map(server => server.name));
    const servers = cfg.mcp.servers.map(server => ({ ...this.entry({ scope: 'global', name: server.name }, server), inherited: !!workspaceId, overridden: overrides.has(server.name) }));
    servers.push(...project.map(server => ({ ...this.entry({ scope: 'project', workspaceId, name: server.name }, server), inherited: false, overridden: false })));
    return { enabled: cfg.mcp.enabled, workspaceId, servers };
  }

  private async saveScope(scope: McpManagementScope, workspaceId: string | undefined, servers: McpServerConfig[]): Promise<void> {
    const cfg = this.deps.getConfig();
    const patch: Partial<AppConfig> = scope === 'global' ? { mcp: { ...cfg.mcp, servers } } : { mcpByWorkspace: { ...cfg.mcpByWorkspace, [workspaceId!]: servers } };
    await this.deps.updateConfig(patch);
  }

  async save(input: McpSaveInput): Promise<ManagedMcpEntry> {
    return this.serial(async () => {
      const current = this.listScope(input.scope, input.workspaceId);
      const old = input.id ? this.find(input.id) : undefined;
      if (old && (old.identity.scope !== input.scope || old.identity.workspaceId !== input.workspaceId)) throw new Error(t('修改作用范围需要新建配置并显式移除原配置'));
      if (old && (await this.get(input.id!)).revision !== input.expectedRevision) throw new Error(t('MCP 配置已被修改，请刷新后再保存'));
      const server = sanitizeMcpServers([{ ...input.server, env: secretMap(input.server.env, old?.server.env), headers: secretMap(input.server.headers, old?.server.headers) }])[0];
      if (!server) throw new Error(t('MCP 名称不能为空'));
      validateManagedMcp(server);
      if (current.some(entry => entry.name === server.name && entry.name !== old?.identity.name)) throw new Error(t('同一作用范围已有同名 MCP，请编辑该条目或使用不同名称'));
      const next = current.filter(entry => entry.name !== old?.identity.name);
      next.push(server);
      await this.saveScope(input.scope, input.workspaceId, next);
      return this.get(identityId({ scope: input.scope, workspaceId: input.workspaceId, name: server.name }));
    });
  }

  async remove(input: McpRemoveInput): Promise<void> {
    return this.serial(async () => {
      const { identity } = this.find(input.id);
      if ((await this.get(input.id)).revision !== input.expectedRevision) throw new Error(t('MCP 配置已被修改，请刷新后再删除'));
      const next = this.listScope(identity.scope, identity.workspaceId).filter(entry => entry.name !== identity.name);
      this.tests.delete(input.id);
      await this.saveScope(identity.scope, identity.workspaceId, next);
    });
  }

  async importJson(input: McpImportInput): Promise<ManagedMcpEntry[]> {
    return this.serial(async () => {
      const parsed = parseMcpJsonText(input.json);
      if (!parsed.ok) throw new Error(parsed.error);
      const raw = JSON.parse(input.json) as Record<string, unknown>;
      const map = raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers as Record<string, unknown> : raw;
      const recognized = new Set(parsed.servers.map(server => server.name));
      const unrecognized = Object.keys(map).filter(name => !recognized.has(name.trim()));
      if (unrecognized.length) throw new Error(t('以下 MCP 条目无法识别，尚未导入：{{names}}', { names: unrecognized.join('、') }));
      const existing = this.listScope(input.scope, input.workspaceId);
      const incoming = sanitizeMcpServers(parsed.servers);
      const names = new Set<string>();
      for (const server of incoming) {
        if (names.has(server.name)) throw new Error(t('导入内容包含重复 MCP 名称'));
        names.add(server.name);
        validateManagedMcp(server);
        const old = existing.find(entry => entry.name === server.name);
        if (old && (await this.get(identityId({ scope: input.scope, workspaceId: input.workspaceId, name: old.name }))).revision !== input.expectedRevisions?.[old.name]) throw new Error(t('{{name}} 已存在，需要先查看该条目并确认替换', { name: server.name }));
        server.env = secretMap(server.env, old?.env);
        server.headers = secretMap(server.headers, old?.headers);
      }
      await this.saveScope(input.scope, input.workspaceId, [...existing.filter(server => !names.has(server.name)), ...incoming]);
      return incoming.map(server => this.entry({ scope: input.scope, workspaceId: input.scope === 'project' ? input.workspaceId : undefined, name: server.name }, server));
    });
  }

  async test(id: string): Promise<McpConnectionTestResult> {
    const server = this.find(id).server;
    const snapshot = structuredClone(server);
    // 总开关关闭时中转不可用：独立握手成功也不能代表可用性（中转链路根本没开），
    // 直接报告 relay-disabled，不启动诊断子进程。
    if (!this.deps.getConfig().mcp.enabled) {
      const result: McpConnectionTestResult = {
        ok: false,
        status: 'relay-disabled',
        tools: [],
        message: t('MCP 总开关未启用：宿主中转不可用，本次未执行握手；开启「启用 MCP」后重新测试。'),
        checkedAt: new Date().toISOString(),
        durationMs: 0
      };
      this.tests.set(id, { fingerprint: fingerprint(snapshot), result });
      return result;
    }
    const result = await (this.deps.testConnection ?? testMcpConnection)(snapshot);
    this.tests.set(id, { fingerprint: fingerprint(snapshot), result });
    return result;
  }
}
