import type { ToolDef } from './types';
import {
  MCP_CALL_DESCRIPTION,
  MCP_CALL_PARAMETERS,
  MCP_SEARCH_DESCRIPTION,
  MCP_SEARCH_PARAMETERS
} from '../../../shared/mcpRelay';

/**
 * B1 中转两工具（capability-delivery）：第三方 MCP 不进引擎原生工具清单，统一经
 * mcp.search（查）→ mcp.call（调）走宿主中转；执行体在 agent/mcpProxy.ts，
 * hub 连接管理在 agent/mcpHub.ts（本文件只放定义，保持 SDK 依赖不进 catalog 图）。
 */
export const MCP_TOOL_DEFS: ToolDef[] = [
  {
    name: 'mcp.search',
    description: MCP_SEARCH_DESCRIPTION,
    dangerous: false,
    parameters: MCP_SEARCH_PARAMETERS
  },
  {
    name: 'mcp.call',
    description: MCP_CALL_DESCRIPTION,
    dangerous: false,
    parameters: MCP_CALL_PARAMETERS
  }
];
