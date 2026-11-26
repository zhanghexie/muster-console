import type { AppContext } from '../../context';
import { currentAgentSessionId, currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { isHeadlessTurn } from '../../agent/turnScope';
import type { SessionReminderTarget } from '../../../shared/sessionReminders';
import { addSessionReminder, completeSessionReminder, listSessionReminders } from '../../sessionReminders/service';

/** Actor identity comes from the host, not arguments or the currently focused UI. */
function currentTarget(ctx: AppContext): { target: SessionReminderTarget; sourceMessageId: string | null } {
  const sessionId = currentAgentSessionId();
  if (sessionId) {
    if (!ctx.sessions.get(sessionId)) throw new Error('The calling session no longer exists.');
    return { target: { kind: 'session', sessionId }, sourceMessageId: ctx.agentSessions?.currentAssistantMessageId(sessionId) ?? null };
  }
  const workspaceId = currentAgentWorkspaceId();
  if (!isSchedulerInvocation() || !workspaceId || isHeadlessTurn() || !ctx.orchestrator) throw new Error('No interactive conversation is available.');
  return { target: { kind: 'scheduler', workspaceId }, sourceMessageId: ctx.orchestrator.currentAssistantMessageId(workspaceId) };
}

export const sessionRemindersHost = {
  'ui.reminders': (ctx: AppContext, args: { action?: unknown; text?: unknown; reminderId?: unknown; offset?: unknown }) => {
    const { target, sourceMessageId } = currentTarget(ctx);
    if (args.action === 'list') {
      const offset = args.offset === undefined ? 0 : args.offset;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');
      const { items } = listSessionReminders(ctx, target);
      const page = [];
      let size = 0;
      for (const item of items.slice(offset, offset + 20)) {
        const nextSize = JSON.stringify(item).length;
        if (page.length && size + nextSize > 8000) break;
        page.push(item);
        size += nextSize;
      }
      return { items: page, total: items.length,
        ...(offset + page.length < items.length ? { nextOffset: offset + page.length } : {}) };
    }
    if (args.action === 'add') return addSessionReminder(ctx, target, args.text, sourceMessageId);
    if (args.action === 'complete' || args.action === 'reopen') {
      if (typeof args.reminderId !== 'string') throw new Error('reminderId is required.');
      const { scope } = listSessionReminders(ctx, target);
      if (!scope) throw new Error('The current conversation is not ready for reminders yet.');
      return completeSessionReminder(ctx, target, scope, args.reminderId, args.action === 'complete', 'ai');
    }
    throw new Error('Choose list, add, complete, or reopen.');
  }
};
