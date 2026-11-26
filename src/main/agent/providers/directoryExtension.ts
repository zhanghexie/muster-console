import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { WorkspaceExecutionContext } from '../../../shared/workspaceExecutionContext';
import type { AppContext } from '../../context';
import { isConfirmed } from '../../../shared/confirmDialog';
import { decideToolCallPermission } from '../../agentSession/tools/policy';
import { assertWorkspaceExecutionContextCurrent } from '../../workspaceExecutionContext';
import { resolvePiToolPath } from '../piToolPaths';
import { canReadDiscoveredSkill, type ReadableSkill } from '../skillReadAccess';
import { t } from '../../../shared/i18n';

/** Directory/rule and safety guard for native tools; mode extension still owns readonly deny. */
export function createSchedulerDirectoryExtension(ctx: AppContext, context: WorkspaceExecutionContext, getSkills?: () => readonly ReadableSkill[]) {
  return (api: ExtensionAPI) => {
    api.on('tool_call', async event => {
      if (!['read', 'write', 'edit', 'grep', 'find', 'ls', 'apply_patch', 'bash', 'powershell', 'execute'].includes(event.toolName)) return;
      try { assertWorkspaceExecutionContextCurrent(ctx.config.get(), context); }
      catch (error) { return { block: true, reason: (error as Error).message }; }
      const decision = decideToolCallPermission({ mode: 'default', planExecuting: false,
        engineToolName: event.toolName, input: event.input as Record<string, unknown>, cwd: context.cwd,
        workspaceContext: context, resolveFilePath: candidate => resolvePiToolPath(event.toolName, candidate, context.cwd),
        allowSkillRead: candidate => canReadDiscoveredSkill(candidate, getSkills?.() ?? []),
        hostToolIds: [], hostClassOf: () => 'edit' });
      if (decision.decision === 'deny') return { block: true, reason: decision.ruleReason ?? t('用户拒绝了本次工具调用') };
      if (decision.decision === 'prompt') {
        const confirmed = isConfirmed(await ctx.ui.confirm(t('调度'), `${event.toolName}\n${JSON.stringify(decision.updatedInput)}`));
        if (!confirmed) return { block: true, reason: t('用户拒绝了本次工具调用') };
        // An approval await cannot preserve a removed or retargeted source folder.
        try { assertWorkspaceExecutionContextCurrent(ctx.config.get(), context); }
        catch (error) { return { block: true, reason: (error as Error).message }; }
      }
      if (decision.updatedInput !== event.input) {
        for (const key of Object.keys(event.input)) delete (event.input as Record<string, unknown>)[key];
        Object.assign(event.input, decision.updatedInput);
      }
    });
  };
}
