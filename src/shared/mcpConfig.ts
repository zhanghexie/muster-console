import type { AppConfig, McpConfig, McpServerConfig, McpTransportKind } from './types';
import { t } from './i18n';

export type McpScope = 'user' | 'workspace';

/** 模块级常量保持原文，渲染点（IntegrationsPane）现场 t() 翻译 */
export const MCP_JSON_HINT =
  '支持直接粘贴 {"server-name": {...}} 或 {"mcpServers": {"server-name": {...}}}。';

/** Shared by runtime and explicit connection diagnostics before any log/UI output. */
export function redactMcpDiagnostic(message: string, server: McpServerConfig): string {
  let out = message;
  for (const secret of [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(secret).join('***');
  // Transport failures may contain a full URL with query credentials.
  return out.replace(/https?:\/\/[^\s)"']+/g, '[MCP URL]').slice(0, 2000);
}

function stringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (kv): kv is [string, string] => typeof kv[1] === 'string'
    )
  );
  return Object.keys(out).length ? out : undefined;
}

function looksLikeServerEntry(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.command === 'string' ||
    typeof e.url === 'string' ||
    e.type === 'http' ||
    e.type === 'sse' ||
    e.type === 'stdio'
  );
}

/** 把 Cursor / 工作台 JSON 里的单条 entry 转成 McpServerConfig */
export function parseMcpServerEntry(name: string, entry: unknown): McpServerConfig | null {
  const trimmed = name.trim();
  if (!trimmed || !looksLikeServerEntry(entry)) return null;
  const e = entry as Record<string, unknown>;
  const type = typeof e.type === 'string' ? e.type : undefined;
  const hasUrl = typeof e.url === 'string' && e.url.length > 0;
  const isHttp = type === 'http' || type === 'sse' || (hasUrl && !e.command);

  if (isHttp) {
    return {
      name: trimmed,
      enabled: e.disabled !== true,
      transport: 'http',
      url: typeof e.url === 'string' ? e.url : '',
      headers: stringRecord(e.headers)
    };
  }

  if (typeof e.command === 'string') {
    const args = Array.isArray(e.args)
      ? e.args.filter((a): a is string => typeof a === 'string')
      : undefined;
    return {
      name: trimmed,
      enabled: e.disabled !== true,
      transport: 'stdio',
      command: e.command,
      args,
      env: stringRecord(e.env),
      cwd: typeof e.cwd === 'string' ? e.cwd : undefined
    };
  }

  return null;
}

/** 从 `{ mcpServers }` 或 `{ "name": entry }` 解析服务器列表 */
export function parseMcpServersObject(raw: unknown): McpServerConfig[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const map =
    obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
      ? (obj.mcpServers as Record<string, unknown>)
      : obj;
  const out: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(map)) {
    const parsed = parseMcpServerEntry(name, entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseMcpJsonText(
  text: string
): { ok: true; servers: McpServerConfig[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: t('JSON 为空') };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed) as unknown;
  } catch (e) {
    return { ok: false, error: t('JSON 无效：{{msg}}', { msg: (e as Error).message }) };
  }
  const servers = parseMcpServersObject(raw);
  if (!servers.length) {
    return {
      ok: false,
      error: t('未识别到 MCP 服务器（需要 {"name": {...}} 或 {"mcpServers": {...}}）')
    };
  }
  return { ok: true, servers };
}

export function toMcpJsonEntry(s: McpServerConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (!s.enabled) entry.disabled = true;
  if (s.transport === 'http') {
    entry.type = 'http';
    if (s.url) entry.url = s.url;
    if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers;
  } else {
    if (s.command) entry.command = s.command;
    if (s.args?.length) entry.args = s.args;
    if (s.env && Object.keys(s.env).length) entry.env = s.env;
    if (s.cwd) entry.cwd = s.cwd;
  }
  return entry;
}

export function serializeMcpJson(servers: McpServerConfig[]): string {
  const map: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    const name = s.name.trim() || 'my-mcp-server';
    map[name] = toMcpJsonEntry(s);
  }
  return JSON.stringify(map, null, 2);
}

export function emptyMcpJsonTemplate(
  name = 'my-mcp-server',
  transport: McpTransportKind = 'http'
): string {
  return serializeMcpJson([
    transport === 'http'
      ? { name, enabled: true, transport: 'http', url: '' }
      : { name, enabled: true, transport: 'stdio', command: 'npx', args: [] }
  ]);
}

/** 工作区同名覆盖用户级 */
export function mergeMcpServers(
  user: McpServerConfig[],
  workspace: McpServerConfig[] | undefined
): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const s of user) {
    const n = s.name.trim();
    if (n) byName.set(n, s);
  }
  for (const s of workspace ?? []) {
    const n = s.name.trim();
    if (n) byName.set(n, s);
  }
  return [...byName.values()];
}

export function resolveEffectiveMcp(
  mcp: McpConfig,
  workspaceServers: McpServerConfig[] | undefined
): McpConfig {
  return {
    enabled: mcp.enabled,
    servers: mergeMcpServers(mcp.servers, workspaceServers)
  };
}

export function resolveEffectiveMcpFromApp(cfg: AppConfig, workspaceId?: string, targetId?: string): McpConfig {
  const id = (workspaceId ?? cfg.activeWorkspaceId).trim();
  const merged = resolveEffectiveMcp(cfg.mcp, cfg.mcpByWorkspace?.[id]);
  return targetId ? { ...merged, servers: merged.servers.filter(server => server.targetIds === undefined || server.targetIds.includes(targetId)) } : merged;
}

export function sanitizeMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
  const compact = (map?: Record<string, string>): Record<string, string> | undefined => {
    if (!map) return undefined;
    const out = Object.fromEntries(
      Object.entries(map).filter(([k, v]) => k.trim().length > 0 && v.length > 0)
    );
    return Object.keys(out).length ? out : undefined;
  };
  return servers
    .map((s) => ({
      ...s,
      name: s.name.trim(),
      args: s.args?.filter(Boolean),
      env: compact(s.env),
      headers: compact(s.headers)
    }))
    .filter((s) => s.name.length > 0);
}
