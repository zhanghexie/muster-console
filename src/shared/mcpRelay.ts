/**
 * MCP 中转公共投影（capability-delivery B1）：常驻简单工具 `mcp.search` / `mcp.call` 的
 * schema、英文文案与纯分页逻辑。第三方 MCP 一律经宿主中转（mcpHub 唯一出口），引擎会话
 * 不直连第三方 server；本文件保持零主进程依赖（catalog 定义面与 stdioEntry 子进程同图可用）。
 * 执行体在 main/agent/mcpProxy.ts（对 hub 结构化取数后调用此处的纯函数）。
 */

/** hub 侧工具条目的最小结构（mcpHub 的 McpToolInfo 满足此形状；测试替身同构） */
export interface McpRelayToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema?: unknown;
}

/** mcpHub 对连接失败 server 产出的占位条目名（据此从工具列表中拆出告警） */
export const MCP_RELAY_CONNECT_ERROR = '(connect-error)';

/** 搜索页字符预算：与 catalog 目录查询同口径——给 executor 的 12k 结果上限留出信封余量 */
export const MCP_SEARCH_PAGE_MAX_CHARS = 9_000;

/**
 * mcp.call 结果信封预算：executor 的 serializeResult（capabilities/executor.ts
 * `RESULT_MAX_CHARS = 12_000`）对最终序列化形态做上限检查，超限会把成功结果整体改写成
 * ok:false 并丢弃正文（假失败）。mcpHub 的 20k 截断（`MCP_RESULT_MAX_CHARS`）大于该上限，
 * 所以 call 侧必须先按「包装 + JSON 转义后的最终长度」预截。取 11.5k：低于 12k 上限
 * 留安全余量（与 mcp.search 的 9k 信封约定同思路）。
 */
export const MCP_CALL_RESULT_MAX_CHARS = 11_500;
const MCP_RESULT_PATHS_MAX = 12;
// A pointer may expand to seven characters per code point across both JSON encodings.
// Keep even a result containing only missing/omitted pointers within the call envelope.
const MCP_RESULT_PATH_MAX_LENGTH = 128;
const MCP_RESULT_PATH_PATTERN = '^/(?:[^~]|~[01])*$';
const mcpResultPathPattern = new RegExp(MCP_RESULT_PATH_PATTERN);

function callEnvelopeLength(text: string): number {
  return JSON.stringify({ ok: true, result: text }).length;
}

/**
 * 把 mcp.call 结果预截到序列化信封内，保住「成功 + 截断标注」语义。executor 会把
 * handler 返回值包成 `{"ok":true,"result":"…"}` 再做 12k 上限检查，而 JSON 转义会膨胀
 * （引号/换行/反斜杠各变 2 字符，控制字符最多 6 字符），所以必须按最终信封长度收缩，
 * 不能按裸字符数 slice。截断保留头部并附英文标注（模型面文本），告知原长与收缩建议。
 */
export function fitMcpRelayCallResult(raw: string): string {
  if (callEnvelopeLength(raw) <= MCP_CALL_RESULT_MAX_CHARS) return raw;
  const note = (kept: number): string =>
    `\n[mcp.call: result truncated to ${kept} of ${raw.length} chars to fit the tool-result budget; narrow the query or paginate]`;
  // 信封长度随前缀单调不减：二分找最大可保留前缀（标注里 kept 位数变化只差几位）
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (callEnvelopeLength(raw.slice(0, mid) + note(mid)) <= MCP_CALL_RESULT_MAX_CHARS) lo = mid;
    else hi = mid - 1;
  }
  let kept = lo;
  let out = raw.slice(0, kept) + note(kept);
  while (kept > 0 && callEnvelopeLength(out) > MCP_CALL_RESULT_MAX_CHARS) {
    kept -= 1;
    out = raw.slice(0, kept) + note(kept);
  }
  return out;
}

export function parseMcpResultPaths(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MCP_RESULT_PATHS_MAX ||
      !Array.from(raw).every(path => typeof path === 'string' &&
        Array.from(path).length <= MCP_RESULT_PATH_MAX_LENGTH && mcpResultPathPattern.test(path))) {
    throw new Error(`mcp.call resultPaths must contain 1–${MCP_RESULT_PATHS_MAX} JSON Pointers starting with / (up to ${MCP_RESULT_PATH_MAX_LENGTH} characters each).`);
  }
  return [...new Set<string>(raw)];
}

function valueAtMcpResultPath(value: unknown, pointer: string): unknown {
  for (const segment of pointer.slice(1).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' ||
        (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) ||
        !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Keep selected values whole. Reserve space for the omitted paths before adding any values. */
export function selectMcpResultPaths(source: object, paths: readonly string[]): string {
  const found = new Map<string, unknown>();
  const missing: string[] = [];
  for (const path of paths) {
    const value = valueAtMcpResultPath(source, path);
    if (value === undefined) missing.push(path);
    else found.set(path, value);
  }

  const values: Record<string, unknown> = {};
  let omitted = [...found.keys()];
  const serialize = (skipped: string[]) => JSON.stringify({
    values,
    ...(missing.length ? { missing } : {}),
    ...(skipped.length ? { omitted: skipped } : {})
  });
  for (const [path, value] of found) {
    const remaining = omitted.filter(candidate => candidate !== path);
    values[path] = value;
    if (callEnvelopeLength(serialize(remaining)) <= MCP_CALL_RESULT_MAX_CHARS) omitted = remaining;
    else delete values[path];
  }
  return serialize(omitted);
}

export const MCP_SEARCH_DESCRIPTION =
  'Discover this workspace\'s third-party MCP tools for mcp.call. Use includeSchema for parameters and nextOffset for more results. No configured servers returns an empty list.';

export const MCP_CALL_DESCRIPTION =
  'Call a third-party MCP tool through the host. Obtain exact names/schema via mcp.search, then reuse them. Use resultPaths to keep only needed JSON values. Large unfiltered results truncate with a note.';

export const MCP_SEARCH_PARAMETERS = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string',
      description: 'Match server/tool name or description; omit for all.'
    },
    server: { type: 'string', description: 'Exact server name filter.' },
    includeSchema: {
      type: 'boolean',
      description: 'Return inputSchema instead of summaries.'
    },
    limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 10.' },
    offset: { type: 'integer', minimum: 0, description: 'Page with nextOffset.' }
  }
};

export const MCP_CALL_PARAMETERS = {
  type: 'object' as const,
  properties: {
    server: { type: 'string', description: 'Exact server name from mcp.search.' },
    tool: { type: 'string', description: 'Exact tool name on that server.' },
    args: {
      type: 'object',
      description: 'Object matching inputSchema; omit or {} when no arguments.'
    },
    resultPaths: {
      type: 'array',
      minItems: 1,
      maxItems: MCP_RESULT_PATHS_MAX,
      items: { type: 'string', maxLength: MCP_RESULT_PATH_MAX_LENGTH, pattern: MCP_RESULT_PATH_PATTERN },
      description: 'Optional host-side JSON Pointers, e.g. ["/tag_name","/items/0/title"]. Returns values by path, plus missing or oversized (omitted) paths. Prefer server field and page options in args when available.'
    }
  },
  required: ['server', 'tool']
};

/** 未配置任何 server 时的固定提示（空清单 + 提示，不报错） */
export const MCP_NO_SERVERS_HINT =
  'No MCP servers are configured for this workspace. Add servers (stdio command or HTTP URL) in Settings → Capability management → MCP; once configured they become callable through mcp.search / mcp.call.';

/** 无匹配时的提示（与 catalog 目录查询的 hint 口径一致） */
export const MCP_NO_MATCH_HINT =
  'No tools matched. Omit query to list the full directory, or filter by server.';

export interface McpSearchPageArgs {
  /** 已启用 server 名单（展示用；空=未配置） */
  servers: readonly string[];
  /** hub 的原始工具清单（可含连接失败占位条目） */
  tools: readonly McpRelayToolInfo[];
  query?: unknown;
  server?: unknown;
  includeSchema?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface McpSearchPage {
  servers: string[];
  tools: Array<{ server: string; name: string; summary?: string; description?: string; inputSchema?: unknown }>;
  total: number;
  nextOffset?: number;
  connectErrors?: Array<{ server: string; error: string }>;
  hint?: string;
}

/** 把连接失败占位条目从工具清单拆出（不当工具列，但也不静默） */
export function splitMcpRelayTools(
  tools: readonly McpRelayToolInfo[]
): { ok: McpRelayToolInfo[]; errors: McpRelayToolInfo[] } {
  const ok: McpRelayToolInfo[] = [];
  const errors: McpRelayToolInfo[] = [];
  for (const tool of tools) {
    if (tool.name === MCP_RELAY_CONNECT_ERROR) errors.push(tool);
    else ok.push(tool);
  }
  return { ok, errors };
}

function summaryOf(description: string): string {
  const first = description.split(/\r?\n/, 1)[0] || '';
  return first.trim().slice(0, 160);
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,，。/]+/)
        .filter(Boolean)
    )
  ];
}

/**
 * 纯分页投影：过滤（query/server）→ 稳定排序（server、name）→ 条目（摘要或全 schema）
 * → 字符预算截断 + nextOffset。沿用 catalog 目录查询的分页约定：预算内尽量多放、
 * 首条永不落空、未放完给 nextOffset。连接失败以 connectErrors 旁路呈现，不计入 total。
 */
export function buildMcpSearchPage(args: McpSearchPageArgs): McpSearchPage {
  const servers = args.servers.map((s) => s.trim()).filter(Boolean);
  const serverFilter = typeof args.server === 'string' ? args.server.trim() : '';
  const terms = queryTerms(typeof args.query === 'string' ? args.query.trim() : '');
  const limit = Math.max(1, Math.min(20, Math.floor(Number(args.limit) || 10)));
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const includeSchema = args.includeSchema === true;

  const { ok, errors } = splitMcpRelayTools(args.tools);
  const connectErrors = errors.map((e) => ({
    server: e.server,
    error: (e.description || '').trim().slice(0, 300)
  }));

  const rows = ok
    .filter((tool) => !serverFilter || tool.server === serverFilter)
    .map((tool) => ({ tool, text: `${tool.server} ${tool.name} ${tool.description}`.toLowerCase() }))
    .filter((row) => !terms.length || terms.some((term) => row.text.includes(term)))
    .sort((a, b) => a.tool.server.localeCompare(b.tool.server) || a.tool.name.localeCompare(b.tool.name));

  const page: McpSearchPage['tools'] = [];
  let pageChars = 0;
  for (const { tool } of rows.slice(offset, offset + limit)) {
    const entry = includeSchema
      ? {
          server: tool.server,
          name: tool.name,
          description: tool.description,
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {})
        }
      : { server: tool.server, name: tool.name, summary: summaryOf(tool.description) };
    const chars = JSON.stringify(entry).length;
    // Leave room for the envelope under the executor's 12k result limit; never skip the first entry.
    if (page.length && pageChars + chars > MCP_SEARCH_PAGE_MAX_CHARS) break;
    page.push(entry);
    pageChars += chars;
  }

  const out: McpSearchPage = {
    servers,
    tools: page,
    total: rows.length
  };
  if (offset + page.length < rows.length) out.nextOffset = offset + page.length;
  if (connectErrors.length) out.connectErrors = connectErrors;
  if (!servers.length) out.hint = MCP_NO_SERVERS_HINT;
  else if (!rows.length && !connectErrors.length) out.hint = MCP_NO_MATCH_HINT;
  else if (serverFilter && !rows.length && connectErrors.length) {
    out.hint = `Server "${serverFilter}" failed to connect; see connectErrors and verify it in Settings → Capability management → MCP.`;
  }
  return out;
}
