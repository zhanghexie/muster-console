/**
 * CLI 入站 stdio MCP：工具名映射、身份解析、JSON-RPC 处理、引擎配置合并、TOFU 指纹。
 * 工具面 ID 投影自 shared/hostTools（pty-allowlist）；禁止碰 process。
 */
import { WORKER_INBOUND_MCP_SERVER } from './inboundMcpConstants';

export { WORKER_INBOUND_MCP_SERVER };

/** 点号 Catalog 名 → MCP 工具名（sessions.setStatus → sessions_setStatus） */
export function toInboundMcpToolName(dotName: string): string {
  return dotName.replace(/\./g, '_');
}

/** MCP 工具名 → 点号 Catalog 名 */
export function fromInboundMcpToolName(mcpName: string): string {
  return mcpName.replace(/_/g, '.');
}

export type InboundMcpToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type InboundMcpIdentity = {
  token: string;
  statusUrl: string;
  toolUrl: string;
  /**
   * true：stdio 回打单一网关 POST {token,name,arguments}（ACP / 统一回调）。
   * false/缺省：STATUS_URL + TOOL_URL Bearer（pty Shell HTTP / CLI 首条简报）。
   */
  invokeStyle?: boolean;
};

export type InboundMcpPidRecord = InboundMcpIdentity & {
  sessionId: string;
  ptyPid: number;
};

export type InboundMcpLaunch = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type InboundMcpEngineFile = {
  format?: 'json' | 'jsonc' | 'toml' | 'yaml';
  entryStyle?: 'command-array' | 'copilot' | 'stdio-type' | 'stdio-transport' | 'cline-shell' | 'stdio-transport-shell';
  /** Only OpenCode versions require checking for a V1/V2 server-map mismatch. */
  checkOpenCodeLayout?: boolean;
  /** Preserve an explicit engine-wide MCP opt-out. */
  requiresMcpEnabled?: boolean;
  /** Required document envelope fields for an engine, filled only when absent. */
  rootDefaults?: Record<string, unknown>;
  serversKey?: string[];
  id: string;
  /** Registered harness display name. */
  label: string;
  path: string;
};

export type InboundMcpReview = {
  fingerprint: string;
  files: Array<{ id: string; label: string; path: string; action: 'create' | 'update' }>;
  command: string;
  args: string[];
};

/** Actual CLI configuration state, not evidence of a live MCP connection. */
export type InboundMcpSetupStatus = {
  ok: boolean;
  error?: string;
  engines: Array<{
    id: string;
    label: string;
    path: string;
    state: 'configured' | 'error' | 'native' | 'session' | 'unsupported' | 'pending-workspace';
    detail?: string;
    error?: string;
  }>;
};

/** Recognize only the registrar's complete stdio entry shape; preserve unknown entries. */
export function inboundMcpLaunchFromEntry(value: unknown): InboundMcpLaunch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some(key => !['command', 'args', 'env'].includes(key))) return null;
  if (typeof entry.command !== 'string' || !entry.command.trim() || !Array.isArray(entry.args)
    || entry.args.some(arg => typeof arg !== 'string')) return null;
  if (entry.env !== undefined && (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)
    || Object.values(entry.env).some(item => typeof item !== 'string'))) return null;
  return { command: entry.command, args: [...entry.args] as string[],
    ...(entry.env ? { env: { ...entry.env as Record<string, string> } } : {}) };
}

export function sameInboundMcpLaunch(a: InboundMcpLaunch, b: InboundMcpLaunch): boolean {
  const normalize = (launch: InboundMcpLaunch): string => JSON.stringify({ command: launch.command, args: launch.args,
    env: Object.entries(launch.env ?? {}).sort(([a], [b]) => a.localeCompare(b)) });
  return normalize(a) === normalize(b);
}

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

export const INBOUND_MCP_PROTOCOL_VERSION = '2024-11-05';

/** 历史 TOFU 指纹：仅作已有受控安装的迁移证据，新自动配置使用逐引擎身份记录 */
export function inboundMcpFingerprint(launch: InboundMcpLaunch): string {
  return `v1:${launch.command}\n${(launch.args ?? []).join('\n')}`;
}

export function identityFromEnv(env: Record<string, string | undefined>): InboundMcpIdentity | null {
  const invokeToken = String(
    env.MUSTER_HOST_TOOLS_TOKEN ?? env.MUSTER_ACP_TOOLS_TOKEN ?? ''
  ).trim();
  const invokeUrl = String(env.MUSTER_HOST_TOOLS_URL ?? env.MUSTER_ACP_TOOLS_URL ?? '').trim();
  if (invokeToken && invokeUrl) {
    return { token: invokeToken, statusUrl: invokeUrl, toolUrl: invokeUrl, invokeStyle: true };
  }
  const token = String(env.MUSTER_SESSION_TOKEN ?? '').trim();
  const statusUrl = String(env.MUSTER_STATUS_URL ?? '').trim();
  const toolUrl = String(env.MUSTER_TOOL_URL ?? '').trim();
  if (!token || !statusUrl || !toolUrl) return null;
  return { token, statusUrl, toolUrl };
}

/**
 * 沿 PID 祖先查宿主写入的 pid-map（Claude Code 不向 MCP 子进程传播环境变量）。
 * parentOf(pid) 由平台实现注入，便于单测。
 */
export function resolveIdentityByPidWalk(
  startPid: number,
  startPpid: number,
  lookup: (pid: number) => InboundMcpPidRecord | null,
  parentOf: (pid: number) => number | null,
  maxHops = 32
): InboundMcpPidRecord | null {
  const seen = new Set<number>();
  let pid = startPid;
  let ppid = startPpid;
  for (let i = 0; i < maxHops; i += 1) {
    if (pid <= 0 || seen.has(pid)) break;
    seen.add(pid);
    const hit = lookup(pid);
    if (hit) return hit;
    const parentHit = ppid > 0 ? lookup(ppid) : null;
    if (parentHit) return parentHit;
    const next = parentOf(ppid > 0 ? ppid : pid);
    if (next == null || next <= 0 || next === pid) break;
    pid = ppid > 0 ? ppid : next;
    ppid = next;
  }
  return null;
}

export function resolveInboundIdentity(opts: {
  env: Record<string, string | undefined>;
  pid: number;
  ppid: number;
  lookup: (pid: number) => InboundMcpPidRecord | null;
  parentOf: (pid: number) => number | null;
}): InboundMcpIdentity | null {
  return identityFromEnv(opts.env) ?? resolveIdentityByPidWalk(opts.pid, opts.ppid, opts.lookup, opts.parentOf);
}

/** 把 muster stdio server 写入引擎 JSON（保留其它键与其它 mcpServers） */
export function upsertInboundMcpServerJson(
  existing: unknown,
  launch: InboundMcpLaunch
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const prevServers =
    base.mcpServers && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
      ? { ...(base.mcpServers as Record<string, unknown>) }
      : {};
  const entry: Record<string, unknown> = {
    command: launch.command,
    args: launch.args
  };
  if (launch.env && Object.keys(launch.env).length) entry.env = launch.env;
  prevServers[WORKER_INBOUND_MCP_SERVER] = entry;
  base.mcpServers = prevServers;
  return base;
}

export function listInboundMcpToolsFromCatalog(
  allowlist: readonly string[],
  getDef: (dotName: string) =>
    | { description: string; parameters: InboundMcpToolDef['inputSchema'] }
    | undefined
): InboundMcpToolDef[] {
  const out: InboundMcpToolDef[] = [];
  for (const id of allowlist) {
    const def = getDef(id);
    if (!def) continue;
    out.push({
      name: toInboundMcpToolName(id),
      description: def.description,
      inputSchema: def.parameters
    });
  }
  return out;
}

export function parseHostToolsCatalogJson(raw: unknown): InboundMcpToolDef[] {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { tools?: unknown }) : {};
  const tools = Array.isArray(obj.tools) ? obj.tools : [];
  const out: InboundMcpToolDef[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name.trim()) continue;
    out.push({
      name: rec.name,
      description: typeof rec.description === 'string' ? rec.description : '',
      inputSchema:
        rec.inputSchema && typeof rec.inputSchema === 'object' && !Array.isArray(rec.inputSchema)
          ? (rec.inputSchema as InboundMcpToolDef['inputSchema'])
          : { type: 'object', properties: {} }
    });
  }
  return out;
}

export type InboundMcpCallResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }>;
  isError?: boolean;
};

export type InboundMcpHttp = {
  postJson: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal
  ) => Promise<{ ok: boolean; status: number; text: string }>;
};

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    Authorization: `Bearer ${token}`
  };
}

/** sessions.setStatus 走 STATUS_URL；其余走 TOOL_URL（与 CLI 首条简报 HTTP 兜底同语义）。invokeStyle 走单一网关。 */
export async function dispatchInboundMcpTool(
  mcpName: string,
  args: Record<string, unknown>,
  identity: InboundMcpIdentity,
  http: InboundMcpHttp,
  allowlist: readonly string[],
  signal?: AbortSignal
): Promise<InboundMcpCallResult> {
  const matches = allowlist.filter(name => name === mcpName || toInboundMcpToolName(name) === mcpName);
  if (!identity.invokeStyle && matches.length !== 1) {
    return { content: [{ type: 'text', text: `工具 ${mcpName} 不对 Worker 开放` }], isError: true };
  }
  const dotName = matches[0] ?? fromInboundMcpToolName(mcpName);
  if (!identity.invokeStyle && !allowlist.includes(dotName)) {
    return {
      content: [{ type: 'text', text: `工具 ${dotName} 不对 Worker 开放` }],
      isError: true
    };
  }
  try {
    if (identity.invokeStyle) {
      const res = await http.postJson(
        identity.toolUrl,
        { token: identity.token, name: mcpName, arguments: args },
        { 'Content-Type': 'application/json' }, signal
      );
      return invokeJsonResult(res, mcpName);
    }
    if (dotName === 'host.sessions.setStatus') {
      const res = await http.postJson(identity.statusUrl, { ...args, resultView: 'model' }, authHeaders(identity.token), signal);
      return jsonResult(res);
    }
    const res = await http.postJson(
      identity.toolUrl,
      { name: dotName, arguments: args, resultView: 'model' },
      authHeaders(identity.token), signal
    );
    return jsonResult(res);
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
}

function invokeJsonResult(res: { ok: boolean; status: number; text: string }, name: string): InboundMcpCallResult {
  try {
    const parsed = JSON.parse(res.text || '{}') as { isError?: boolean; text?: string; image?: unknown };
    const text = String(parsed.text ?? res.text ?? `HTTP ${res.status}`);
    const isError = !res.ok || !!parsed.isError;
    if (!isError && parsed.image !== undefined) {
      const image = parsed.image as { type?: unknown; mimeType?: unknown; data?: unknown } | null;
      // Only the host desktop capture path may attach an image. Reject rather
      // than silently dropping malformed or unexpected binary content.
      if (!/^(?:host[._])?desktop[._]look$/.test(name) || !image || typeof image !== 'object' || Array.isArray(image) ||
          Object.keys(image).sort().join(',') !== 'data,mimeType,type' || image.type !== 'image' || image.mimeType !== 'image/png' ||
          typeof image.data !== 'string' || image.data.length < 60 || image.data.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 ||
          image.data.length % 4 !== 0 || !image.data.startsWith('iVBORw0KGgo') || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
        return { content: [{ type: 'text', text: 'Desktop screenshot image is invalid.' }], isError: true };
      }
      return { content: [{ type: 'text', text }, { type: 'image', mimeType: 'image/png', data: image.data }] };
    }
    return { content: [{ type: 'text', text }], isError };
  } catch {
    return jsonResult(res);
  }
}

function jsonResult(res: { ok: boolean; status: number; text: string }): InboundMcpCallResult {
  const text = res.text || `HTTP ${res.status}`;
  if (!res.ok) return { content: [{ type: 'text', text }], isError: true };
  try {
    if (JSON.parse(text)?.ok === false) return { content: [{ type: 'text', text }], isError: true };
  } catch { /* A textual response still has content; HTTP status remains authoritative. */ }
  return { content: [{ type: 'text', text }] };
}

export type InboundMcpHandlerContext = {
  tools: InboundMcpToolDef[];
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<InboundMcpCallResult>;
  pendingCalls?: Map<string | number, AbortController>;
  serverVersion?: string;
};

export async function handleInboundMcpMessage(
  raw: unknown,
  ctx: InboundMcpHandlerContext
): Promise<Record<string, unknown> | null> {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as JsonRpcRequest;
  const id = msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (id === undefined || id === null) {
    if (method === 'notifications/cancelled') {
      const requestId = (msg.params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') ctx.pendingCalls?.get(requestId)?.abort();
    }
    return null;
  }
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: INBOUND_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: WORKER_INBOUND_MCP_SERVER,
          version: ctx.serverVersion ?? '0.0.0'
        }
      }
    };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: ctx.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      }
    };
  }
  if (method === 'tools/call') {
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as {
      name?: unknown;
      arguments?: unknown;
    };
    const name = typeof params.name === 'string' ? params.name : '';
    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    if (!name) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'tools/call 需要 name' }
      };
    }
    if (ctx.pendingCalls?.has(id)) return { jsonrpc: '2.0', id, error: { code: -32600, message: '请求 ID 正在执行' } };
    const controller = new AbortController();
    ctx.pendingCalls?.set(id, controller);
    try {
      const result = await ctx.callTool(name, args, controller.signal);
      if (controller.signal.aborted) return null;
      if (!result || !Array.isArray(result.content)) throw new Error('Host tool returned no valid result');
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (controller.signal.aborted) return null;
      const message = error instanceof Error ? error.message : String(error);
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `${name}: ${message}` }] } };
    } finally { ctx.pendingCalls?.delete(id); }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}
