/**
 * ACP session/new 的 mcpServers：只装宿主工具 stdio MCP shim（复用 T2.3 工具定义）。
 * 可选附 askQuestion（接到 UserQuestionCard，与 Pi/Cursor/Claude/Codex 同卡）。
 * B2（capability-delivery-mcp-relay-plan）：用户配置的第三方 MCP 不再按 `acp:<presetId>`
 * 过滤注入 session/new——第三方工具经宿主中转（mcp.search/mcp.call）；「占用 muster
 * 名」冲突防护随之移除（不再装配用户 server，无冲突面）。
 */
import { cursorAskQuestionToolDef } from '../../../../shared/cursorAskQuestion';
import type { GuiHostTool } from '../../types';

export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}
export type AcpMcpServer = AcpMcpServerStdio;

export const ACP_HOST_MCP_NAME = 'muster';

export type HostToolsCatalog = {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
};

/** 问卷目录项（stdio MCP / Codex mcp_servers 共用） */
export function askQuestionCatalogEntry(): HostToolsCatalog['tools'][number] {
  const def = cursorAskQuestionToolDef();
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema
  };
}

/**
 * 自愿审批目录项（B1b）：引擎原生权限面缺失/覆盖不全时（如 Codex exec 的
 * approval_policy=never+沙箱），模型在执行有副作用的动作前**主动**请求用户批准——
 * 这是「自愿请求」档（plan r2 §5.1 ①），不是逐调用强制门。
 */
export function requestApprovalCatalogEntry(): HostToolsCatalog['tools'][number] {
  return {
    name: 'host_requestApproval',
    description:
      '在执行有副作用的操作（写文件、跑命令、工作区外访问）之前主动请求用户批准。用户批准返回 approved；拒绝会给出理由，此时必须放弃该操作并改用用户建议。凡是你拿不准是否该做的动作，先调用它。',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: '打算使用的工具名（如 shell / 文件写入）' },
        input: { type: 'object', description: '动作入参（原样给出，如命令行或目标路径）' },
        reason: { type: 'string', description: '为什么需要这个动作（可选）' }
      },
      required: ['toolName']
    }
  };
}

export function hostToolsToCatalog(
  tools: readonly GuiHostTool[],
  opts?: { includeAskQuestion?: boolean; includeRequestApproval?: boolean }
): HostToolsCatalog {
  const aliases = new Map<string, string>();
  for (const tool of tools) {
    const alias = tool.id.replace(/\./g, '_');
    const previous = aliases.get(alias);
    if (previous) throw new Error(`Host tool name collision: ${previous} and ${tool.id} both map to ${alias}`);
    aliases.set(alias, tool.id);
  }
  const listed: HostToolsCatalog['tools'] = tools.map((t) => ({
    name: t.id.replace(/\./g, '_'),
    description: t.description,
    inputSchema: (t.parameters ?? { type: 'object' }) as Record<string, unknown>
  }));
  if (opts?.includeRequestApproval && listed.some((t) => t.name === 'host_requestApproval')) {
    throw new Error('Host tool name collision: host_requestApproval is reserved for the approval bridge');
  }
  if (opts?.includeRequestApproval) {
    listed.push(requestApprovalCatalogEntry());
  }
  return { tools: listed };
}
