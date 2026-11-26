import type { AppContext } from '../context';
import type { TurnChangeTracker, TurnFileCollision } from './service';
import { persistEntry, syncEntry } from '../agentSession/host/base';
import { t } from '../../shared/i18n';

function participant(ctx: AppContext, tracker: TurnChangeTracker) {
  if (tracker.owner.startsWith('gui:')) {
    const id = tracker.owner.slice(4), meta = ctx.sessions.get(id);
    const entry = ctx.agentSessions?.entries.get(id);
    const message = entry?.messages.find(m => m.id === tracker.messageId && m.turnChanges?.id === tracker.summary.id);
    return { label: meta?.name || id, publish: () => {
      if (!ctx.agentSessions || !entry || entry.closed || !message) return;
      message.turnChanges = { ...tracker.summary }; persistEntry(ctx.agentSessions, entry, [message]); syncEntry(ctx.agentSessions, entry);
    } };
  }
  const id = tracker.owner.slice('dispatch:'.length);
  const workspace = ctx.config.get().workspaces.find(w => w.id === id);
  const bucket = ctx.orchestrator?.buckets.get(id);
  const message = bucket?.display.find(m => m.id === tracker.messageId && m.turnChanges?.id === tracker.summary.id);
  return { label: `${workspace?.name || id} · ${t('调度')}`, publish: () => {
    if (!ctx.orchestrator || !bucket || !message) return;
    message.turnChanges = { ...tracker.summary }; ctx.orchestrator.emit('agent:message', { ...message, workspaceId: id }); ctx.orchestrator.persistBucket(id);
  } };
}

/** Keep peer names with both owning messages for later revert results. */
export function recordTurnFileCollision(ctx: AppContext, collision: TurnFileCollision): void {
  const [a, b] = collision.participants;
  const first = participant(ctx, a), second = participant(ctx, b);
  for (const [tracker, peer, peerLabel] of [[a, b, second.label], [b, a, first.label]] as const) {
    tracker.summary.concurrentEdits = tracker.summary.concurrentEdits?.map(e => e.otherOwner === peer.owner ? { ...e, otherLabel: peerLabel } : e);
  }
  for (const entry of [first, second]) {
    try { entry.publish(); } catch (error) { console.error('[turn-changes] collision publish failed', error); }
  }
}
