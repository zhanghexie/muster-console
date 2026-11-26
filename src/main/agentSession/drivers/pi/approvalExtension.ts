/**
 * Pi 审批扩展：单一 tool_call 钩子，按模式/权限策略放行 / 弹审批 / 直接禁（主进程唯一 writer）。
 * fire-time 热读模式（getPolicyState），切档即时生效。deny 映射为 pi 的 block（工具不执行、
 * 理由回给模型）。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { GuiWorkerMode } from '../../../../shared/types';
import type { GuiToolPermissionClass } from '../../../../shared/guiWorkerPolicy';
import { decideToolCallPermission } from '../../tools/policy';
import type { GuiApprovalDecision } from '../../types';
import type { WorkspaceExecutionContext } from '../../../../shared/workspaceExecutionContext';
import { resolvePiToolPath } from '../../../agent/piToolPaths';
import { canReadDiscoveredSkill, type ReadableSkill } from '../../../agent/skillReadAccess';

export interface PiApprovalContext {
  sessionId: string;
  cwd: string;
  workspaceContext?: WorkspaceExecutionContext;
  getSkills?: () => readonly ReadableSkill[];
  getPolicyState(): { mode: GuiWorkerMode; planExecuting: boolean; allowedPrompts?: string[] } | Promise<{ mode: GuiWorkerMode; planExecuting: boolean; allowedPrompts?: string[] }>;
  requestApproval(req: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    reason?: string;
  }): Promise<GuiApprovalDecision>;
  hostToolIds: readonly string[];
  /** Worker host tools are authorized by the parent's shared gateway. */
  hostGatewayHandlesTools?: boolean;
  hostClassOf(dotName: string): GuiToolPermissionClass | undefined;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

export function createPiApprovalExtension(ctx: PiApprovalContext) {
  return (api: ExtensionAPI) => {
    api.on('tool_call', async (event: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    }) => {
      if (ctx.hostGatewayHandlesTools && ctx.hostToolIds.some(id => id === event.toolName || id.replace(/\./g, '_') === event.toolName)) return;
      const { mode, planExecuting, allowedPrompts } = await ctx.getPolicyState();
      if (!event.input || typeof event.input !== 'object') {
        (event as { input: Record<string, unknown> }).input = {};
      }
      const rawInput = event.input as Record<string, unknown>;
      const { decision, updatedInput, ruleReason } = decideToolCallPermission({
        mode,
        planExecuting,
        allowedPrompts,
        engineToolName: event.toolName,
        input: rawInput,
        cwd: ctx.cwd,
        workspaceContext: ctx.workspaceContext,
        resolveFilePath: candidate => resolvePiToolPath(event.toolName, candidate, ctx.cwd),
        allowSkillRead: candidate => canReadDiscoveredSkill(candidate, ctx.getSkills?.() ?? []),
        hostToolIds: event.toolName === 'core_context' ? [...ctx.hostToolIds, 'core_context'] : ctx.hostToolIds,
        hostClassOf: (dotName) => dotName === 'core_context' ? 'status' : ctx.hostClassOf(dotName) ?? 'status'
      });
      // rewrite：就地写回引擎可见入参（Pi tool_call 无 updatedInput 回传通道）
      if (updatedInput !== rawInput) {
        for (const key of Object.keys(rawInput)) delete rawInput[key];
        Object.assign(rawInput, updatedInput);
      }
      if (decision === 'deny') {
        return {
          block: true,
          reason:
            ruleReason ??
            describeDenyReason(mode, planExecuting, event.toolName, updatedInput)
        };
      }
      if (decision === 'auto') return;
      const reason = describeApprovalReason(mode, event.toolName, ctx.cwd, updatedInput);
      const result = await ctx.requestApproval({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: updatedInput,
        reason
      });
      if (!result.approved) {
        return { block: true, reason: result.reason ?? 'The user declined this tool call' };
      }
      return;
    });
  };
}

/** 模式门控拒绝理由（回给模型；只读语义与调度一致） */
function isShellToolName(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return n === 'bash' || n === 'pwsh' || n === 'shell' || n === 'killbash';
}

export function describeDenyReason(
  mode: GuiWorkerMode,
  planExecuting: boolean,
  toolName: string,
  input: Record<string, unknown>
): string {
  if (mode === 'ask' || (mode === 'plan' && !planExecuting)) {
    const label = mode === 'ask' ? 'ask' : 'plan';
    const escape = mode === 'plan' ? ' or approve the plan for execution' : '';
    if (isShellToolName(toolName)) {
      return `Current mode is ${label} (read-only); only read-only commands are allowed (denied: ${String(input.command ?? '').slice(0, 120)}). Ask the user to switch modes${escape} to make changes.`;
    }
    return `Current mode is ${label} (read-only): ${toolName} is disabled. Ask the user to switch modes${escape} to make changes.`;
  }
  return `${toolName} was denied`;
}

/** 审批卡上的一句话理由 */
export function describeApprovalReason(
  mode: GuiWorkerMode,
  toolName: string,
  cwd: string,
  input: Record<string, unknown>
): string {
  if (mode === 'standard' || mode === 'accept-edits') {
    return `The current permission mode requires confirmation for ${toolName}`;
  }
  if (mode === 'ask' || mode === 'plan') return `Current mode is "${mode === 'ask' ? 'ask' : 'plan'}": ${toolName} needs confirmation`;
  if (isShellToolName(toolName)) return 'A shell command needs confirmation';
  const p = input.path ?? input.file_path ?? input.filePath;
  if (typeof p === 'string' && p.trim()) {
    return `The target path may be outside the workspace (${cwd}): ${String(p).slice(0, 120)}`;
  }
  return `${toolName} needs confirmation`;
}
