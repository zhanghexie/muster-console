import { normalizeMailboxOffsets } from '../../shared/sessionToolArgs';
import type { AppContext } from '../context';
import { isSchedulerInvocation } from '../agent/agentScope';
import { clipObservationText } from '../../shared/sessionObservation';
import { readAgentMessageLedger, readAgentMessageBody, markAgentMessagesReadInStore, persistAgentMessageSourceAgentInStore } from '../metaAgent/messageStore';
import { canonicalMailboxId, mailboxStores } from './deliver';
import { receiveMailbox } from './receive';
import { coerceSourceAgentIdentity } from '../../shared/subagentCharacters';
import { isHostNotification } from '../../shared/hostNotification';
import { initialAssignmentStatus, publicMailWakeReceipt } from '../../shared/agentMessage';

export function mailboxSender(ctx: AppContext, from: string, name?: string) {
  const sender = ctx.sessions.get(from) ?? ctx.sessions.peekEnded?.(from);
  return coerceSourceAgentIdentity({ sessionId: from, name: name || sender?.name || from,
    characterId: sender && 'subagentCharacterId' in sender ? sender.subagentCharacterId : undefined });
}

export interface ReadMailboxArgs {
  box?: 'inbox' | 'sent';
  messageId?: string;
  mailboxWorkspaceId?: string;
  unreadOnly?: boolean;
  since?: number;
  limit?: number;
  offset?: number;
  listOffset?: number;
  bodyOffset?: number;
  length?: number;
  includeBody?: boolean;
  maxChars?: number;
  cursor?: string;
}

/** Lists never mark read. Opening a body marks read only for its actual recipient AI. */
export async function readMailbox(ctx: AppContext, args: ReadMailboxArgs,
  actor: { id: string; hostView: boolean; workspaceId: string }, signal?: AbortSignal) {
  if ('waitMs' in args) throw new Error('waitMs is removed: waiting moved to host.waitFor({condition, note, priority?}).');
  if ('watchSessionIds' in args) throw new Error('watchSessionIds is removed: waiting moved to host.waitFor({condition, note, priority?}).');
  args = normalizeMailboxOffsets(args);
  if (signal?.aborted) throw new Error('收信已取消');
  const scheduler = actor.hostView && isSchedulerInvocation();
  const id = scheduler ? `orchestrator:${actor.workspaceId}` : actor.id;
  const hostView = actor.hostView && !scheduler;
  const snapshot = () => mailboxStores(ctx)
    .filter(w => (!args.mailboxWorkspaceId || w.workspaceId === args.mailboxWorkspaceId) &&
      // hostView 的可见面本就只有自身工作区（下方终过滤），无需读取其余工作区账本（F-04 扫描域收敛）
      (!hostView || w.workspaceId === actor.workspaceId))
    .flatMap(w => readAgentMessageLedger(w.root, w.workspaceId).messages.map(message => ({ ...w, message })))
    .filter(({ message }) => !isHostNotification(message))
    .filter(({ workspaceId, message: m }) => hostView ? workspaceId === actor.workspaceId
      : m.from === id || canonicalMailboxId(m.to, workspaceId) === id);
  if (args.messageId) {
    if (args.cursor) throw new Error('单封正文读取不与游标混用');
    const entries = snapshot();
    const found = entries.filter(e => e.message.id === args.messageId);
    if (found.length > 1) throw new Error('旧消息 ID 跨工作区重名，请指定 mailboxWorkspaceId');
    if (!found.length) throw new Error('信件不存在或不属于当前邮箱');
    const { root, workspaceId, message } = found[0]!;
    const body = readAgentMessageBody(root, workspaceId, message);
    const offset = Number.isFinite(args.offset) ? Math.min(body.length, Math.max(0, Math.floor(args.offset!))) : 0;
    const length = Number.isFinite(args.length) ? Math.max(1, Math.min(5000, Math.floor(args.length!))) : 4000;
    const page = clipObservationText(body.slice(offset), length);
    if (!hostView && canonicalMailboxId(message.to, workspaceId) === id && !message.read) {
      await markAgentMessagesReadInStore(root, workspaceId, [message.id], signal);
      const updated = readAgentMessageLedger(root, workspaceId).messages.find(m => m.id === message.id)!;
      message.read = updated.read; message.readAt = updated.readAt;
      ctx.sessions.broadcastMessagesChanged();
    }
    // F-05：无快照旧信按当前会话状态回填身份后一次性固化落盘，后续读取不再随
    // 发送者改名/删除漂移；固化失败回落现行为（下次读取重试），不影响本次读取。
    const backfill = message.sourceAgent ?? mailboxSender(ctx, message.from, message.fromName);
    if (!message.sourceAgent && backfill) {
      try { await persistAgentMessageSourceAgentInStore(root, workspaceId, message.id, backfill); }
      catch (error) { console.warn('[read] sourceAgent 回填固化失败，回落按读取时现状', error); }
    }
    const { initialAssignmentReceipt: _assignment, wakeDeferred: _deferred, wakeAtIdle: _atIdle,
      wakeError: _error, wakeUncertain: _uncertain, notifiedAt: _notified, deliveryMethod: _delivery, ...publicMessage } = message;
    return { ...publicMessage, ...publicMailWakeReceipt(message), initialAssignment: initialAssignmentStatus(message),
      sourceAgent: backfill, mailboxWorkspaceId: workspaceId, text: page.text,
      totalChars: body.length, offset, nextOffset: offset + page.text.length < body.length ? offset + page.text.length : null,
      truncated: offset > 0 || page.truncated, read: message.read, readAt: message.readAt ?? null };
  }
  const box = args.box ?? 'inbox';
  if (box !== 'inbox' && box !== 'sent') throw new Error('box 必须为 inbox 或 sent');
  args = { ...args, includeBody: args.includeBody ?? box === 'inbox', unreadOnly: args.unreadOnly ?? box === 'inbox' };
  if ((args.includeBody !== false && box === 'inbox') || args.includeBody || args.cursor !== undefined) {
    return receiveMailbox(ctx, args, { id: hostView ? `host:${actor.workspaceId}` : id, hostView, workspaceId: actor.workspaceId }, snapshot, signal);
  }
  const entries = snapshot();
  const rows = entries.filter(({ workspaceId, message: m }) => hostView || (box === 'sent' ? m.from === id : canonicalMailboxId(m.to, workspaceId) === id))
    .filter(({ message: m }) => (!args.unreadOnly || !m.read) && (args.since === undefined || m.ts > args.since))
    .sort((a, b) => b.message.ts - a.message.ts || b.message.id.localeCompare(a.message.id));
  const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset!)) : 0;
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit!))) : 12;
  const messages: object[] = [];
  let size = 0;
  for (const { workspaceId, message: m } of rows.slice(offset, offset + limit)) {
    const row = { id: m.id, from: m.from, fromName: m.fromName, to: m.to, toName: m.toName,
      subject: m.subject, kind: m.kind, replyTo: m.replyTo, askId: m.meta?.askId,
      preview: clipObservationText(m.text, 160).text, ts: m.ts, receipt: m.receipt, read: m.read,
      readAt: m.readAt ?? null, ...(!m.read ? { notifiedAt: m.notifiedAt ?? null } : {}),
      ...publicMailWakeReceipt(m),
      initialAssignment: initialAssignmentStatus(m),
      ...(m.interruption ? { interruption: m.interruption } : {}),
      totalChars: m.bodyChars ?? m.text.length, mailboxWorkspaceId: workspaceId };
    const chars = JSON.stringify(row).length;
    if (messages.length && size + chars > 6000) break;
    messages.push(row); size += chars;
  }
  return { mailbox: id, box, total: rows.length, unread: rows.filter(e => !e.message.read).length, messages,
    nextOffset: offset + messages.length < rows.length ? offset + messages.length : null,
    note: '列表不标已读。用 messageId 打开正文；已读只表示收件 AI 主动打开，不代表处理完成。' };
}
