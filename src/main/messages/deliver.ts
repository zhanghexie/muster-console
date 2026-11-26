import path from 'node:path';
import { semanticOperationsFor } from '../runtimeKernel/semanticOperations';
/** Shared mailbox transport. Saving mail is independent of its later wake or delivery. */
import { createHash, randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import { isSchedulerInvocation } from '../agent/agentScope';
import { AGENT_MESSAGE_TEXT_MAX, initialAssignmentStatus, isAgentMessageId, isPendingInitialAssignment, publicMailWakeReceipt,
  type AgentMessageKind, type AgentMessageMeta, type AgentMessageLedger, type MailSendWakeReceipt } from '../../shared/agentMessage';
import { canonicalMailboxId, projectMailActivity } from '../../shared/mailActivity';
import { agentMessagesFilePath, appendAgentMessageToStore, hasAgentMessageInStore, readAgentMessageLedger, listAgentMessageWorkspaceIds } from '../metaAgent/messageStore';
import { storeMailAtDeparture } from './departure';
import { requestMailboxWake } from './wake';

export { canonicalMailboxId } from '../../shared/mailActivity';

export interface DeliverAgentMessageInput {
  from: string;
  to: string;
  kind?: AgentMessageKind;
  text: string;
  subject?: string;
  idempotencyKey?: string;
  replyToHandle?: string;
  meta?: AgentMessageMeta;
  workspaceId?: string;
  source?: 'scheduler';
  /** Internal only: caller already verified interrupt permission. */
  interrupt?: true;
  /** Application-owned GUI assignment, stable across creation retries and actor changes. */
  initialAssignment?: true;
}
export interface DeliverAgentMessageResult extends MailSendWakeReceipt {
  messageId: string;
  receipt: 'stored';
  target: string;
  mailboxWorkspaceId: string;
  read: boolean;
  readAt?: number;
  /** Mail is stored even if supplementary semantic indexing needs repair. */
  semanticError?: string;
  initialAssignment?: ReturnType<typeof initialAssignmentStatus>;
  initialAssignmentPending?: boolean;
  textChars?: number;
}

export function agentMailIdForKey(from: string, to: string, key: string): string {
  return `mail-${createHash('sha256').update(`${from}\0${to}\0${key}`).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}`;
}

export const INITIAL_ASSIGNMENT_KEY = 'initial-assignment';

export function mailboxStores(ctx: AppContext) {
  const configured = ctx.workspaces.list().map(w => ({ workspaceId: w.id, root: w.path }));
  return [...configured, ...listAgentMessageWorkspaceIds().filter(id => !configured.some(w => w.workspaceId === id))
    .map(workspaceId => ({ workspaceId, root: '' }))];
}

export function readAgentLedgerFor(ctx: AppContext, workspaceId?: string): AgentMessageLedger {
  const wsId = workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
  const root = ctx.workspaces.list().find(w => w.id === wsId)?.path ?? '';
  return readAgentMessageLedger(root, wsId);
}

export async function deliverAgentMessage(ctx: AppContext, input: DeliverAgentMessageInput): Promise<DeliverAgentMessageResult> {
  const text = input.text.trim();
  if (!text) throw new Error('text 不能为空');
  if (text.length > AGENT_MESSAGE_TEXT_MAX) throw new Error(`信件正文过长（最多 ${AGENT_MESSAGE_TEXT_MAX} 字符），未保存`);
  if (input.idempotencyKey && input.idempotencyKey.length > 200) throw new Error('寄信标识最多 200 字符');
  let wsId = input.workspaceId?.trim() || ctx.resolveBubbleWorkspaceId();
  const from = input.from === 'host' && isSchedulerInvocation() ? `orchestrator:${wsId}` : canonicalMailboxId(input.from, wsId);
  let to = canonicalMailboxId(input.to.trim(), wsId);
  let name = '调度', ended = false;
  if (to.startsWith('orchestrator:')) {
    wsId = to.slice('orchestrator:'.length);
    if (!ctx.workspaces.list().some(w => w.id === wsId)) throw new Error(`收信工作区不存在：${wsId}`);
  } else {
    const live = ctx.sessions.peek?.(to) ?? ctx.sessions.get(to);
    const target = live ?? ctx.sessions.peekEnded?.(to);
    if (!target) throw new Error(`收信会话不存在：${to}`);
    to = target.id; name = target.name || target.id;
    wsId = target.workspaceId?.trim() || wsId;
    ended = !live || live.archived === true || !ctx.workspaces.list().some(w => w.id === wsId);
  }
  const root = ctx.workspaces.list().find(w => w.id === wsId)?.path ?? '';
  let anchor: { replyTo?: string; replyAskId?: string } = {};
  const handle = input.replyToHandle?.trim();
  if (handle) {
    const stores = [{ root, workspaceId: wsId }, ...mailboxStores(ctx).filter(w => w.workspaceId !== wsId)];
    const matches = stores.flatMap(w => readAgentMessageLedger(w.root, w.workspaceId).messages
      .filter(m => isAgentMessageId(handle) ? m.id === handle : m.meta?.askId === handle)
      .map(message => ({ message, workspaceId: w.workspaceId })));
    const visible = matches.filter(({ message: m, workspaceId }) => ['host', 'human'].includes(from) ||
      m.from === from || canonicalMailboxId(m.to, workspaceId) === from);
    if (visible.length > 1) throw new Error('旧消息 ID 跨工作区重名，请使用该信的 askId 或新邮件 ID 回复');
    const found = visible[0];
    if (!found) throw new Error(`replyTo 引用的消息不存在或不属于自己邮箱：${handle}`);
    const original = found.message;
    const addressedTo = canonicalMailboxId(original.to, found.workspaceId);
    if (!['host', 'human'].includes(from) && original.from !== from && addressedTo !== from) throw new Error('不能引用不属于自己邮箱的信件');
    anchor = { replyTo: original.id, ...(original.meta?.askId ? { replyAskId: original.meta.askId } : {}) };
  }
  const sender = ctx.sessions.get(from);
  const id = input.initialAssignment
    ? agentMailIdForKey('muster-initial-assignment', to, INITIAL_ASSIGNMENT_KEY)
    : input.idempotencyKey
    ? agentMailIdForKey(from, to, input.idempotencyKey)
    : `mail-${randomUUID()}`;
  const fromName = sender?.name ?? (from.startsWith('orchestrator:') ? '调度' : from);
  const save = () => appendAgentMessageToStore(root, wsId, {
    ...(sender ? { sourceAgent: { sessionId: sender.id, name: sender.name, characterId: sender.subagentCharacterId } } : {}),
    id, from, to, kind: input.kind ?? 'notice', ...anchor,
    meta: { ...input.meta, ...(input.initialAssignment ? { initialAssignment: true as const } : {}),
      ...(input.interrupt ? { interrupt: true } : {}), ...(anchor.replyAskId ? { replyAskId: anchor.replyAskId } : {}) },
    ...(input.interrupt ? { interruption: 'pending' as const } : {}),
    text, ts: Date.now(), receipt: 'stored', subject: input.subject,
    fromName, toName: name
  }, { replyValidated: !!handle, reuseInitialAssignment: !!input.initialAssignment });
  const preview = input.initialAssignment ? undefined : projectMailActivity(wsId,
    { id, from, to, fromName, toName: name, subject: input.subject, ts: Date.now() }, text);
  const entry = await storeMailAtDeparture(ctx, preview, save,
    input.idempotencyKey ? () => hasAgentMessageInStore(wsId, id) : undefined);
  let semanticError: string | undefined;
  try {
    const childResult = sender?.parentSessionId === to && (entry.kind === 'handoff' || entry.kind === 'answer');
    await semanticOperationsFor(ctx, to, path.dirname(path.dirname(agentMessagesFilePath(wsId))), ctx.sessionLogs)
      .fact(childResult ? 'subagent.result' : 'mail.stored', entry.id, [entry.replyTo ?? entry.id],
        { mailId: entry.id, from: entry.from, to: entry.to, kind: entry.kind, ...(entry.replyTo ? { replyTo: entry.replyTo } : {}) });
  } catch (error) {
    // The immutable mail body and ledger already committed. Never report it as
    // unsent or encourage a second mail; retrying the same ID repairs this fact.
    semanticError = `信件已保存，语义索引待修复：${String(error)}`;
    console.error('[mailbox]', semanticError);
  }
  ctx.sessions.broadcastMessagesChanged();
  if (!ended && !entry.read && !input.interrupt && !entry.initialAssignmentReceipt)
    requestMailboxWake(ctx, to, wsId, input.meta?.subscriptionEvent === true);
  const wakeReceipt = publicMailWakeReceipt(entry);
  const wake = ended ? 'disabled' : wakeReceipt.notifiedAt !== undefined ? 'notified' : wakeReceipt.wakeDeferred ? 'deferred' : 'pending';
  return { messageId: entry.id, receipt: 'stored', target: to, mailboxWorkspaceId: wsId,
    read: entry.read, ...(entry.readAt ? { readAt: entry.readAt } : {}), ...wakeReceipt,
    ...(!entry.read ? { wake } : {}),
    ...(entry.meta?.initialAssignment ? { initialAssignment: initialAssignmentStatus(entry),
      initialAssignmentPending: isPendingInitialAssignment(entry), textChars: entry.bodyChars ?? entry.text.length } : {}),
    ...(semanticError ? { semanticError } : {}) };
}
