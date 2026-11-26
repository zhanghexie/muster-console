import type { AppContext } from '../../context';
import { currentAgentSessionId, currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { sanitizeSuggestedReplies } from '../../../shared/guiWorker';

/** Only the trusted caller's current interactive assistant may receive suggestions. */
export const suggestedRepliesHost = {
  'ui.suggestReplies': (ctx: AppContext, args: { replies?: unknown }) => {
    if (!Array.isArray(args.replies) || args.replies.length < 1 || args.replies.length > 3 ||
        args.replies.some(reply => typeof reply !== 'string' || reply.length > 300)) {
      throw new Error('Provide 1–3 reply strings, each at most 300 characters.');
    }
    const replies = sanitizeSuggestedReplies(args.replies);
    if (!replies.length) throw new Error('At least one non-empty reply is required.');
    const sessionId = currentAgentSessionId();
    if (sessionId) {
      if (!ctx.agentSessions?.setSuggestedReplies(sessionId, replies) &&
          !ctx.sessions?.setCliSuggestedReplies?.(sessionId, replies)) {
        throw new Error('The calling session has no active assistant or CLI available for suggestions.');
      }
    } else {
      const workspaceId = currentAgentWorkspaceId();
      if (!isSchedulerInvocation() || !workspaceId || !ctx.orchestrator?.setSuggestedReplies(workspaceId, replies)) {
        throw new Error('No active interactive scheduler conversation is available for suggestions.');
      }
    }
    return { count: replies.length };
  }
};
