/**
 * MCP 中转两工具的 catalog 执行侧（B1）：`mcp.search` / `mcp.call` 唯一 handler。
 * mcpHub 保持第三方 server 的唯一出口（并行建连/15s 预算/冷却/断线摘除/SSE 回落不动）；
 * 本文件按「生效配置指纹」缓存共享 hub，配置变化即关旧建新。执行体（分页/校验/英文
 * 错误文案）在 agent/mcpProxy.ts + shared/mcpRelay.ts，GUI（catalogHostTools）、调度
 * （piProvider 常驻注册）、PTY/ACP（/v1/tool 网关 → executeTool）三面同源到此处。
 */
import { McpHub } from '../../agent/mcpHub';
import { runMcpCall, runMcpSearch, type McpRelayHub } from '../../agent/mcpProxy';
import { currentAgentSessionId } from '../../agent/agentScope';
import type { AppContext } from '../../context';
import { capabilityUsageAllowed } from '../../capabilityManagement/usage';
import { fitMcpRelayCallResult } from '../../../shared/mcpRelay';

/** workspaceId → { 配置指纹, hub }；同步读取+同步置换，无并发窗口 */
const relayHubs = new Map<string, { key: string; hub: McpHub }>();

/** 调用链工作区解析：优先令牌绑定的会话所属工作区，再落当前气泡工作区 */
export function resolveMcpRelayWorkspaceId(ctx: AppContext): string | undefined {
  const sid = currentAgentSessionId();
  if (sid) {
    try {
      const ws = ctx.sessions.get(sid)?.workspaceId;
      if (ws && ws.trim()) return ws;
    } catch {
      /* 会话已消失则走气泡工作区 */
    }
  }
  try {
    return ctx.resolveBubbleWorkspaceId() || ctx.config.get().activeWorkspaceId || undefined;
  } catch {
    return ctx.config.get().activeWorkspaceId || undefined;
  }
}

/**
 * 取当前生效配置对应的共享 hub；未启用/未配置返回 null（search 走空清单，call 报可纠正错误）。
 * Shared connections remain workspace-owned; per-caller usage is checked in a facade.
 */
function relayHubFor(ctx: AppContext): McpHub | null {
  const workspaceId = resolveMcpRelayWorkspaceId(ctx) ?? '';
  let mcp;
  try {
    mcp = ctx.config.effectiveMcp(workspaceId || undefined);
  } catch {
    return null;
  }
  if (!mcp.enabled) return null;
  const key = JSON.stringify(mcp);
  const cached = relayHubs.get(workspaceId);
  if (cached) {
    if (cached.key === key) return cached.hub;
    // 配置变化：关旧建新（在途调用会收到「MCP 已关闭」类错误，模型可重试）
    void cached.hub.close().catch(() => {
      /* 关闭失败不影响新 hub */
    });
  }
  const hub = new McpHub(mcp);
  relayHubs.set(workspaceId, { key, hub });
  return hub;
}

/** Capture trusted identity once; reevaluate policy/config at every asynchronous boundary. */
function policyHubFor(ctx: AppContext): McpRelayHub | null {
  const sessionId = currentAgentSessionId();
  const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  if (sessionId && !session) throw new Error('Caller session no longer exists.');
  const context = { workspaceId: resolveMcpRelayWorkspaceId(ctx), runtimeId: session?.runtime };
  const hub = relayHubFor(ctx);
  if (!hub) return null;
  const allowed = (name: string): boolean => {
    if (sessionId && !ctx.sessions.get(sessionId)) return false;
    const cfg = ctx.config.get();
    const current = ctx.config.effectiveMcp(context.workspaceId);
    return current.enabled && current.servers.some(server => server.name === name && server.enabled) &&
      cfg.mcp.servers.find(server => server.name === name)?.enabled !== false && capabilityUsageAllowed('mcp', name, context);
  };
  const assertAllowed = (name: string): void => { if (!allowed(name)) throw new Error('MCP server is disabled by capability usage settings.'); };
  return {
    enabledServers: () => hub.enabledServers().filter(server => allowed(server.name)),
    listAllTools: async () => {
      const names = new Set(hub.enabledServers().filter(server => allowed(server.name)).map(server => server.name));
      return (await hub.listAllTools(names)).filter(tool => allowed(tool.server));
    },
    describeTool: async (server, tool) => { assertAllowed(server); const result = await hub.describeTool(server, tool); assertAllowed(server); return result; },
    callTool: async (server, tool, args, resultPaths) => {
      assertAllowed(server);
      const result = await hub.callToolResult(server, tool, args, () => assertAllowed(server), resultPaths);
      if (result.isError) throw new Error(fitMcpRelayCallResult(result.text));
      return result.text;
    }
  };
}

/** 关闭全部共享 hub（退出前清理；best-effort） */
export function closeAllMcpRelayHubs(): void {
  for (const { hub } of relayHubs.values()) {
    void hub.close().catch(() => {
      /* ignore */
    });
  }
  relayHubs.clear();
}

{
  // 退出清理：MCP stdio 子进程由宿主持有，退出前 best-effort 关闭（无 electron 环境静默跳过）
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      app?: { once: (event: string, fn: () => void) => void };
    };
    electron.app?.once('will-quit', () => closeAllMcpRelayHubs());
  } catch {
    /* 测试/无头环境无 electron：子进程随宿主退出 */
  }
}

export const mcpHost = {
  'mcp.search': async (
    ctx: AppContext,
    args: Record<string, unknown>
  ): Promise<unknown> => {
    const hub = policyHubFor(ctx);
    // hub 为 null（未配置）时传结构相同的空 hub 走同一执行体：空清单不报错
    return runMcpSearch(
      hub ?? {
        enabledServers: () => [],
        listAllTools: async () => [],
        describeTool: async () => null,
        callTool: async () => ''
      },
      args
    );
  },
  'mcp.call': async (
    ctx: AppContext,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<string> => {
    if (options?.signal?.aborted) throw new Error('Cancelled');
    const hub = policyHubFor(ctx);
    if (!hub) {
      throw new Error(
        'No MCP servers are configured for this workspace; mcp.search returns an empty list. Add servers in Settings → Capability management → MCP.'
      );
    }
    return runMcpCall(hub, args);
  }
};
