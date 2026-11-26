import type { AppContext } from '../../context';
import { readMailbox, type ReadMailboxArgs } from '../../messages/read';
import { resolveToolActor, resolveActorWorkspaceId } from './actors';
import { currentAgentSessionId, currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { readMailPresentations } from '../../../shared/mailReadPresentation';
export const mailboxHost = {
  'sessions.readMessages': async (ctx: AppContext, args: ReadMailboxArgs & Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    const actor = resolveToolActor(args);
    const workspaceId = resolveActorWorkspaceId(ctx, args);
    const schedulerWorkspace = isSchedulerInvocation() ? currentAgentWorkspaceId() : undefined;
    const sink = schedulerWorkspace ? ctx.orchestrator?.captureDisplayItemSink?.(schedulerWorkspace)
      : actor.role === 'worker' && currentAgentSessionId() === actor.id ? ctx.agentSessions?.captureDisplayItemSink?.(actor.id) : undefined;
    const result = await readMailbox(ctx, args, { id: actor.id, hostView: actor.role === 'host', workspaceId }, options?.signal);
    if (sink && !options?.signal?.aborted) {
      try {
        const pages = readMailPresentations([{ id: 'host-read', name: 'sessions.readMessages', arguments: '{}', status: 'ok', result: JSON.stringify(result) }]);
        if (pages.length && !sink({ kind: 'mail', pages })) console.warn('[mailbox] display target no longer exists');
      } catch (error) { console.warn('[mailbox] display item failed:', error); }
    }
    return result;
  }
};
