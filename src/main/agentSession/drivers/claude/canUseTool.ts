import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { GuiToolPermissionClass } from '../../../../shared/guiWorkerPolicy';
import type { NativeApprovalChoice } from '../../../../shared/nativeSessionConfig';
import type { WorkspaceExecutionContext } from '../../../../shared/workspaceExecutionContext';
import { evaluateNativeToolBoundary } from '../../tools/policy';
import type { GuiDriverConnectInput } from '../../types';

export const CLAUDE_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface ClaudeCanUseToolContext {
  cwd: string;
  workspaceContext?: WorkspaceExecutionContext;
  hostToolIds: readonly string[];
  hostClassOf(dotName: string): GuiToolPermissionClass;
  getTurnId?(): string | undefined;
  isCurrent?(): boolean;
  requestApproval: GuiDriverConnectInput['requestApproval'];
  timeoutMs?: number;
}

/** Claude invokes this callback after its own permission evaluation requests a decision. */
export function createClaudeCanUseTool(ctx: ClaudeCanUseToolContext): CanUseTool {
  return async (toolName, input, options) => {
    const turnId = ctx.getTurnId?.();
    const isCurrent = () => !options.signal.aborted && (ctx.isCurrent?.() ?? true) &&
      (!ctx.getTurnId || (!!turnId && ctx.getTurnId() === turnId));
    const deny = (message: string): PermissionResult => ({ behavior: 'deny', message, toolUseID: options.toolUseID });
    if (!isCurrent()) return deny('Tool request cancelled.');
    const name = toolName.startsWith('mcp__muster__')
      ? ctx.hostToolIds.find(id => id.replace(/\./g, '_') === toolName.slice('mcp__muster__'.length)) ?? toolName
      : toolName;
    const evaluate = () => evaluateNativeToolBoundary({
      cwd: ctx.cwd, workspaceContext: ctx.workspaceContext, hostToolIds: ctx.hostToolIds,
      hostClassOf: ctx.hostClassOf, engineToolName: name, input
    }, false);
    const policy = evaluate();
    if (policy.decision === 'deny') return deny(policy.ruleReason ?? 'Tool request denied by a host rule.');
    const choices: NativeApprovalChoice[] = [
      { id: 'allow', name: 'Allow', kind: 'allow_once', scope: 'once' },
      { id: 'deny', name: 'Deny', kind: 'reject_once', scope: 'once' }
    ];
    const suggestions = options.suggestions;
    if (suggestions?.length) {
      const destinations = [...new Set(suggestions.map(update => update.destination))];
      const persistent = destinations.some(destination => destination.endsWith('Settings'));
      const description = suggestions.map(update => {
        const change = update.type === 'setMode' ? update.mode
          : 'rules' in update ? update.rules.map(rule => rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName).join(', ')
            : update.directories.join(', ');
        return `${update.destination} · ${update.type} · ${change}`;
      }).join('\n').slice(0, 4096);
      choices.splice(1, 0, { id: 'updatedPermissions', name: persistent ? 'Allow and update permissions' : 'Allow for this session',
        kind: persistent ? 'allow_always' : 'allow_session', scope: persistent ? 'persistent' : 'session', description });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, ctx.timeoutMs ?? CLAUDE_APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      const cancelled = new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
      const outcome = await Promise.race([ctx.requestApproval({
        toolCallId: options.toolUseID, toolName: options.displayName ?? toolName, input: policy.updatedInput,
        reason: [options.title, options.decisionReason, policy.ruleReason].filter(Boolean).join('\n'),
        nativeChoices: choices, nativeSource: 'Claude Code'
      }, controller.signal), cancelled]);
      if (!outcome || !isCurrent() || controller.signal.aborted || JSON.stringify(evaluate()) !== JSON.stringify(policy)) return deny('Tool request cancelled.');
      if (outcome.nativeChoiceId !== 'allow' && !(outcome.nativeChoiceId === 'updatedPermissions' && suggestions?.length)) {
        return deny(outcome.reason ?? 'User denied the tool request.');
      }
      return {
        behavior: 'allow', updatedInput: policy.updatedInput, toolUseID: options.toolUseID,
        ...(outcome.nativeChoiceId === 'updatedPermissions' ? { updatedPermissions: suggestions } : {})
      };
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
    }
  };
}
