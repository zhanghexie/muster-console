import type { AppContext } from '../../context';
import { currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { canonicalMailboxId } from '../../messages/deliver';
import { watchedSession } from '../../messages/watch';
import { normalizeWaitCondition } from '../../resumeWait/service';
import { refreshResumeWait } from '../../resumeWait/runtime';
import { assertApprovedSubscribeKinds } from './awareness';
import { resolveActorWorkspaceId, resolveToolActor } from './actors';

export const resumeWaitHost = {
  waitFor: (ctx: AppContext, args: Record<string, unknown>) => {
    if (args.subject !== undefined || args.owner !== undefined || args.target !== undefined || args.sessionId !== undefined)
      throw new Error('waitFor can arm only the calling session');
    const actor = resolveToolActor(args);
    const workspaceId = isSchedulerInvocation() ? currentAgentWorkspaceId() : resolveActorWorkspaceId(ctx, args);
    if (!workspaceId) throw new Error('waitFor requires a bound workspace');
    const owner = isSchedulerInvocation() ? `orchestrator:${workspaceId}` : actor.role === 'worker' ? actor.id : '';
    if (!owner || !ctx.resumeWait) throw new Error('waitFor requires a managed session and a running continuation service');
    let condition = normalizeWaitCondition(args.condition);
    if (condition.kind === 'event' && condition.source === 'fact')
      assertApprovedSubscribeKinds(ctx, { ...args, workspaceId, kinds: condition.types });
    if (condition.kind === 'mail' && condition.from)
      condition = { ...condition, from: canonicalMailboxId(condition.from, workspaceId) };
    if (condition.kind === 'session') {
      const sessionId = canonicalMailboxId(condition.sessionId, workspaceId);
      if (watchedSession(ctx, sessionId).missing) throw new Error('waitFor session target does not exist');
      condition = { ...condition, sessionId };
    }
    const wait = ctx.resumeWait.arm(owner, workspaceId, { condition, note: args.note, priority: args.priority, deadlineMs: args.deadlineMs });
    refreshResumeWait(ctx);
    return { ok: true, id: wait.id, condition: wait.condition, priority: wait.priority, deadlineAt: wait.deadlineAt,
      message: 'Wait armed; continue working. The continuation is delivered when the condition fires.' };
  }
};
