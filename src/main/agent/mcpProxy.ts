/**
 * MCP 中转**唯一**执行实现：调度（piProvider 注册的 catalog 常驻工具，经
 * capabilities/hosts/mcp.ts 走 executeTool）与 GUI Worker（tools/mcpBridge，宿主工具）
 * 共用本文件，各自只负责包 schema。拆两份实现会漂移——曾经调度侧 list 不过滤连接
 * 错误、无多语言、描述不列 server 名。
 *
 * 中转两工具（capability-delivery B1 定稿形态）：`runMcpSearch` / `runMcpCall` 服务常驻
 * `mcp.search` / `mcp.call`（全角色一个形态，文案全英文，分页约定与 catalog 目录查询同款，
 * schema/纯逻辑在 shared/mcpRelay.ts）。legacy 单工具 `runMcpProxy`（四 action）随 B2
 * 停用用户直注后已无消费者，B4 删除。
 */
import { buildMcpSearchPage, fitMcpRelayCallResult, parseMcpResultPaths, type McpRelayToolInfo, type McpSearchPage } from '../../shared/mcpRelay';

/**
 * 中转执行体的 hub 结构契约：McpHub 满足此形状；测试替身按同构实现，
 * 不需要拉起真实连接（mcpHub 的连接管理——并行建连/15s 预算/冷却/断线摘除/SSE 回落——不动）。
 */
export interface McpRelayHub {
  enabledServers(): Array<{ name: string }>;
  listAllTools(): Promise<McpRelayToolInfo[]>;
  describeTool(server: string, tool: string): Promise<McpRelayToolInfo | null>;
  callTool(server: string, tool: string, args: Record<string, unknown>, resultPaths?: readonly string[]): Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// B1 中转两工具执行体：mcp.search / mcp.call（全角色一个形态；host 侧错误全英文可纠正）
// ─────────────────────────────────────────────────────────────────────────────

/** mcp.search：列已配置 server 及工具清单；未配置返回空清单不报错 */
export async function runMcpSearch(hub: McpRelayHub, params: Record<string, unknown>): Promise<McpSearchPage> {
  const tools = hub.enabledServers().length ? await hub.listAllTools() : [];
  const servers = hub.enabledServers().map((s) => s.name);
  return buildMcpSearchPage({
    servers,
    tools: tools.filter(tool => servers.includes(tool.server)),
    query: params.query,
    server: params.server,
    includeSchema: params.includeSchema,
    limit: params.limit,
    offset: params.offset
  });
}

/**
 * mcp.call 的 args 解析：schema 声明对象，但模型常见三种变体——JSON 字符串、双重转义
 * 字符串、legacy `arguments_json` / `arguments` 键。全部收下；非对象拒绝（英文可纠正）。
 */
export function parseMcpRelayCallArgs(params: Record<string, unknown>): Record<string, unknown> {
  const raw =
    params.args ?? params.arguments_json ?? params.arguments ?? undefined;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `mcp.call "args" is not valid JSON: ${(e as Error).message}. Pass an object per the tool's inputSchema (see mcp.search with includeSchema=true).`
    );
  }
  if (typeof parsed === 'string') {
    // 双重转义（"{\"a\":1}" 被再包一层）：再解一次
    try {
      const inner = JSON.parse(parsed);
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
    } catch {
      /* fall through to the type error below */
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `mcp.call "args" must be a JSON object; received ${Array.isArray(parsed) ? 'an array' : typeof parsed}. Pass an object per the tool's inputSchema (see mcp.search with includeSchema=true).`
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * mcp.call：经 mcpHub 执行；host 侧错误抛出（executor 转成给模型的英文错误文本）。
 * 结果经 fitMcpRelayCallResult 预截：mcpHub 的 20k 截断大于 executor serializeResult
 * 的 12k 序列化上限，不预截的话超限结果会被改写成 ok:false 并丢正文（假失败）。
 */
export async function runMcpCall(
  hub: McpRelayHub,
  params: Record<string, unknown>
): Promise<string> {
  const server = typeof params.server === 'string' ? params.server.trim() : '';
  const tool = typeof params.tool === 'string' ? params.tool.trim() : '';
  if (!server || !tool) {
    throw new Error('mcp.call requires both "server" and "tool" (exact names come from mcp.search).');
  }
  const servers = hub.enabledServers().map((s) => s.name);
  if (!servers.length) {
    throw new Error(
      'No MCP servers are configured for this workspace; mcp.search returns an empty list. Add servers in Settings → Capability management → MCP.'
    );
  }
  if (!servers.includes(server)) {
    throw new Error(
      `Unknown MCP server "${server}". Configured servers: ${servers.join(', ')}. Use mcp.search to list their tools.`
    );
  }
  const args = parseMcpRelayCallArgs(params);
  const resultPaths = parseMcpResultPaths(params.resultPaths);
  let known: McpRelayToolInfo | null;
  try {
    known = await hub.describeTool(server, tool);
  } catch (e) {
    throw new Error(
      `MCP server "${server}" connection failed: ${(e as Error).message}. The server may be starting up or misconfigured; verify it in Settings → Capability management → MCP, then retry.`
    );
  }
  if (!known) {
    throw new Error(
      `Server "${server}" has no tool "${tool}". Call mcp.search with {"server":"${server}","includeSchema":true} to list its tools.`
    );
  }
  return fitMcpRelayCallResult(await hub.callTool(server, tool, args, resultPaths));
}
