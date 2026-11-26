/**
 * 宿主工具三通道薄适配（定义一律投影 shared/hostTools）。
 *
 * | 通道 | 适配器 | 身份 |
 * | in-process | Pi customTools / Claude createSdkMcpServer（含 askQuestion） | 进程内 sessionId 绑定 |
 * | stdio-mcp | inboundMcp/stdioEntry.mjs（Codex/ACP mcp_servers 问卷同通道） | HOST_TOOLS_TOKEN+URL 或 pid-map→Shell |
 * | http+brief | Shell /v1/status+/v1/tool + CLI 首条简报 | MUSTER_SESSION_TOKEN |
 *
 * 禁止为形式统一把进程内 runtime 改成 stdio 子进程。
 */
export const HOST_TOOL_ADAPTERS = ['in-process', 'stdio-mcp', 'http+brief'] as const;
export type HostToolAdapterId = (typeof HOST_TOOL_ADAPTERS)[number];
