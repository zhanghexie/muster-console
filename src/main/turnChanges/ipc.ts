import { pathWritableInContext } from '../workspaceExecutionContext';
import type { AppContext } from '../context';
import { handle } from '../ipc/handle';
import { turnChanges, turnChangesDir } from './runtime';
import { latestAvailableSnapshot } from './retention';
import { captureSchedulerWorkspaceContext } from '../agent/schedulerWorkspaceContext';
import { persistEntry, syncEntry } from '../agentSession/host/base';
import type { TurnChangeOwner, TurnChangeTarget, TurnReviewEntry } from '../../shared/turnChanges';
import { t } from '../../shared/i18n';
import { recordTurnFileCollision } from './collisions';

/** Metadata only. Diff text remains behind the message-scoped host resolver. */
export function listTurnReviews(ctx: AppContext, owner: TurnChangeOwner): TurnReviewEntry[] {
  if (!owner || (owner.kind !== 'gui' && owner.kind !== 'dispatch') || typeof owner.id !== 'string') throw new Error(t('无效的会话'));
  const entry = owner.kind === 'gui' ? ctx.agentSessions?.entries.get(owner.id) : undefined;
  if (entry?.closed) throw new Error(t('会话已关闭'));
  const messages = owner.kind === 'gui' ? entry?.messages : ctx.orchestrator?.buckets.get(owner.id)?.display;
  if (!messages) throw new Error(t('本轮改动快照不可用'));
  let label = '';
  const reviews: TurnReviewEntry[] = [];
  for (const message of messages) {
    if (message.role === 'user') label = ('content' in message ? message.content : message.parts.filter(p => p.kind === 'text').map(p => p.kind === 'text' ? p.text : '').join('')).slice(0, 120);
    if (message.role === 'assistant' && message.turnChanges) reviews.push({ target: { ...owner, messageId: message.id }, summary: message.turnChanges, label, createdAt: 'ts' in message ? message.ts : message.createdAt });
  }
  return reviews.reverse();
}

/** Keep diagnostic states in the review panel, but expose only the newest
 * ready snapshot whose record still belongs to its original message. */
export async function listRetainedTurnReviews(ctx: AppContext, owner: TurnChangeOwner): Promise<TurnReviewEntry[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const entries = listTurnReviews(ctx, owner);
    const messages = entries.slice().reverse().map(entry => ({ id: entry.target.messageId, role: 'assistant', turnChanges: entry.summary }));
    const latest = await latestAvailableSnapshot(turnChangesDir(), `${owner.kind}:${owner.id}`, messages);
    // A session/history may change while the disk read is in flight.
    const current = listTurnReviews(ctx, owner);
    const same = current.length === entries.length && current.every((entry, index) =>
      entry.target.messageId === entries[index].target.messageId && entry.summary.id === entries[index].summary.id && entry.summary.state === entries[index].summary.state);
    if (same) {
      // Keep coverage diagnostics for the newest empty capture alongside the
      // latest usable file snapshot.
      const diagnostic = current.find(entry => entry.summary.state === 'ready' && !entry.summary.files.length &&
        entry.summary.warnings.length);
      return current.filter(entry => entry.summary.state !== 'ready' || entry === diagnostic ||
        (entry.summary.id === latest?.id && entry.target.messageId === latest.messageId));
    }
  }
  return listTurnReviews(ctx, owner).filter(entry => entry.summary.state !== 'ready');
}

/** Resolve the live message on the host; renderer never supplies paths, hashes or contents. */
function resolve(ctx: AppContext, target: TurnChangeTarget) {
  if (target?.kind === 'gui') {
    const host = ctx.agentSessions;
    const entry = host?.entries.get(target.id);
    const message = entry?.messages.find(m => m.id === target.messageId && m.role === 'assistant');
    if (!host || !entry || entry.closed || !message?.turnChanges || message.turnChanges.state !== 'ready') throw new Error(t('本轮改动快照不可用'));
    const context = host.getWorkspaceContext(target.id);
    return { message, canWrite: context ? (file: string) => pathWritableInContext(file, context) : undefined, owner: `gui:${target.id}`, roots: context?.writableDirectories.map(d => d.path) ?? [entry.cwd],
      isCurrent: () => host.entries.get(target.id) === entry && !entry.closed && entry.messages.includes(message),
      publish: () => { persistEntry(host, entry, [message]); syncEntry(host, entry); } };
  }
  if (target?.kind === 'dispatch') {
    const host = ctx.orchestrator;
    const bucket = host?.buckets.get(target.id);
    const message = bucket?.display.find(m => m.id === target.messageId && m.role === 'assistant');
    if (!host || !bucket || !message?.turnChanges || message.turnChanges.state !== 'ready') throw new Error(t('本轮改动快照不可用'));
    const context = captureSchedulerWorkspaceContext(ctx.config.get(), target.id, bucket.piSession, bucket.piSessionFile);
    return { message, canWrite: (file: string) => pathWritableInContext(file, context), owner: `dispatch:${target.id}`, roots: context.writableDirectories.map(d => d.path),
      isCurrent: () => host.buckets.get(target.id) === bucket && bucket.display.includes(message),
      publish: () => { host.emit('agent:message', { ...message, workspaceId: target.id }); host.persistBucket(target.id); } };
  }
  throw new Error(t('无效的会话'));
}

export function registerTurnChangesIpc(ctx: AppContext): void {
  turnChanges().setCollisionHandler(collision => recordTurnFileCollision(ctx, collision));
  handle('turnChanges:list', async (_event, owner: TurnChangeOwner) => {
    try { return { ok: true, entries: await listRetainedTurnReviews(ctx, owner) }; }
    catch (error) { return { ok: false, entries: [], error: (error as Error).message }; }
  });
  handle('turnChanges:diff', (_event, args: { target: TurnChangeTarget; file: string }) => {
    try {
      const current = resolve(ctx, args.target);
      return { ok: true, diff: turnChanges().diff(current.message.turnChanges!.id, current.owner, args.target.messageId, String(args.file)) };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  });
  handle('turnChanges:revert', async (_event, target: TurnChangeTarget) => {
    try {
      const current = resolve(ctx, target);
      const snapshotId = current.message.turnChanges!.id;
      const result = await turnChanges().revert(snapshotId, current.owner, target.messageId, current.roots, current.canWrite);
      // File restoration already happened. Clearing/closing/switching history
      // while metadata retries must not resurrect a removed message or entry.
      if (current.isCurrent() && current.message.turnChanges?.id === snapshotId) {
        if (result.summary) current.message.turnChanges = { ...result.summary };
        try { current.publish(); }
        catch (error) { result.ok = false; result.error = t('文件回退结果已列出，界面同步失败：{{error}}', { error: (error as Error).message }); }
      }
      return result;
    } catch (error) { return { ok: false, restored: [], conflicts: [], error: (error as Error).message }; }
  });
}
