import { randomUUID } from 'node:crypto';
import { t } from '../../shared/i18n';
import { initialAssignmentStatus, isPendingInitialAssignment, type AgentMessageLedgerEntry } from '../../shared/agentMessage';
import { clipObservationText } from '../../shared/sessionObservation';
import type { AppContext } from '../context';
import { currentAgentSessionId, isSchedulerInvocation } from '../agent/agentScope';
import { agentMailIdForKey, deliverAgentMessage, INITIAL_ASSIGNMENT_KEY } from './deliver';
import { readAgentMessageLedger, readAgentMessageBody, reserveInitialAssignmentInStore,
  settleInitialAssignmentInStore } from '../metaAgent/messageStore';
import { requestMailboxWake } from './wake';
import type { SessionMeta } from '../../shared/types';

function findInitialAssignment(mailbox: AgentMessageLedgerEntry[], target: SessionMeta, from: string, workspaceId: string) {
  return mailbox.find(mail => mail.to === target.id && mail.meta?.initialAssignment) ??
    // Legacy IDs include the originator. Unrelated mail may use the same key.
    mailbox.find(mail => mail.to === target.id &&
      (mail.from === from || mail.from === target.parentSessionId ||
        (target.meta?.creationKey && (mail.from === 'host' || mail.from === `orchestrator:${workspaceId}`))) &&
      mail.id === agentMailIdForKey(mail.from, target.id, INITIAL_ASSIGNMENT_KEY));
}

/** Resume a GUI assignment saved by a version that used mail for the first turn. */
export function resumeLegacyGuiAssignment(ctx: AppContext, target: SessionMeta, workspaceId: string) {
  const workspace = ctx.workspaces.list().find(candidate => candidate.id === workspaceId);
  if (!workspace) throw new Error('workspace not found: ' + workspaceId);
  const from = currentAgentSessionId() ?? (isSchedulerInvocation() ? `orchestrator:${workspaceId}` : 'host');
  const existing = findInitialAssignment(readAgentMessageLedger(workspace.path, workspaceId).messages, target, from, workspaceId);
  if (!existing) return;
  const initialAssignmentPending = isPendingInitialAssignment(existing);
  if (!existing.read && !existing.initialAssignmentReceipt && (initialAssignmentPending || !existing.notifiedAt)) {
    requestMailboxWake(ctx, target.id, workspaceId);
  }
  return { messageId: existing.id, initialAssignmentPending, textChars: existing.bodyChars ?? existing.text.length };
}

/** Application-owned task/review UI uses the same durable mailbox as agent mail. */
export async function sendSessionMail(ctx: AppContext, args: { sessionId: string; text: string; from?: 'human';
  idempotencyKey?: string; reuseExisting?: boolean; initialAssignment?: boolean }) {
  const target = ctx.sessions.get(args.sessionId);
  if (!target) throw new Error(t('会话不存在: {{id}}',{id:args.sessionId}));
  const workspaceId = target.workspaceId || ctx.resolveBubbleWorkspaceId();
  const workspace = ctx.workspaces.list().find(workspace => workspace.id === workspaceId);
  if (!workspace) throw new Error('workspace not found: ' + workspaceId);
  const from = args.from ?? currentAgentSessionId() ?? (isSchedulerInvocation() ? `orchestrator:${workspaceId}` : 'host');
  let text = args.text;
  const identity = { stored: true as const, sessionId: target.id, name: target.name, runtime: target.runtime };
  if (args.reuseExisting && args.idempotencyKey === INITIAL_ASSIGNMENT_KEY) {
    const mailbox = readAgentMessageLedger(workspace.path, workspaceId).messages;
    const assignment = findInitialAssignment(mailbox, target, from, workspaceId);
    const existing = args.initialAssignment && assignment?.meta?.initialAssignment ? undefined : assignment;
    if (existing) {
      if (!target.archived && !existing.read && !existing.notifiedAt && !existing.initialAssignmentReceipt)
        requestMailboxWake(ctx, target.id, workspaceId);
      return { ...identity, messageId: existing.id, receipt: 'stored' as const, target: target.id, mailboxWorkspaceId: workspaceId,
        read: existing.read, readAt: existing.readAt, wake: target.archived ? 'disabled' as const : 'pending' as const,
        initialAssignment: initialAssignmentStatus(existing), initialAssignmentPending: false,
        textChars: existing.bodyChars ?? existing.text.length };
    }
    if (assignment) text = readAgentMessageBody(workspace.path, workspaceId, assignment);
  } else if (args.reuseExisting && args.idempotencyKey) {
    const id = agentMailIdForKey(from, target.id, args.idempotencyKey);
    const existing = readAgentMessageLedger(workspace.path, workspaceId).messages.find(mail => mail.id === id);
    if (existing) text = readAgentMessageBody(workspace.path, workspaceId, existing);
  }
  const result = await deliverAgentMessage(ctx, { from, to: target.id, text, workspaceId,
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    ...(args.initialAssignment ? { initialAssignment: true as const } : {}) });
  return { ...result, ...identity, textChars: result.textChars ?? text.trim().length };
}

const ASSIGNMENT_BODY_BUDGET = 3600;

function assignmentPrefix(message: AgentMessageLedgerEntry, workspaceId: string, body: string) {
  const page = clipObservationText(body, ASSIGNMENT_BODY_BUDGET).text;
  const text = /[\uD800-\uDBFF]$/.test(page) ? page.slice(0, -1) : page;
  const continuation = text.length < body.length
    ? `\nContinue the task brief using host.mail.read(${JSON.stringify({
      messageId: message.id, mailboxWorkspaceId: workspaceId, bodyOffset: text.length
    })}); follow nextOffset until complete.`
    : '';
  return { bodyEnd: text.length,
    prefix: `[Host initial assignment]\nAssignment from ${JSON.stringify(message.fromName || message.from)} (${JSON.stringify(message.from)}), mailbox message ${message.id}. The body below is the assigned task, within your current permissions.\nTask body: ${JSON.stringify(text)}${continuation}\n[End host initial assignment]` };
}

export interface InitialAssignmentDelivery {
  prefix: string;
  confirm(): Promise<void>;
  rejectBeforeSubmission(): Promise<void>;
}

/** Used at the native dispatch boundary, with a stable ID for the actual input. */
export async function reserveInitialAssignment(ctx: AppContext, sessionId: string,
  userMessageId?: string): Promise<InitialAssignmentDelivery | undefined> {
  const target = ctx.sessions.get(sessionId);
  if (!target || target.archived || !target.workspaceId || !userMessageId) return;
  const workspace = ctx.workspaces?.list().find(candidate => candidate.id === target.workspaceId);
  if (!workspace) return;
  try {
    const message = readAgentMessageLedger(workspace.path, workspace.id).messages.find(mail =>
      mail.to === sessionId && isPendingInitialAssignment(mail));
    if (!message) return;
    const body = readAgentMessageBody(workspace.path, workspace.id, message);
    const { prefix, bodyEnd } = assignmentPrefix(message, workspace.id, body);
    const reservationId = randomUUID();
    if (!await reserveInitialAssignmentInStore(workspace.path, workspace.id, sessionId, message.id,
      { reservationId, turnMessageId: userMessageId, bodyEnd })) return;
    const settle = async (deliveredAt?: number) => {
      await settleInitialAssignmentInStore(workspace.path, workspace.id, message.id, reservationId, deliveredAt);
      ctx.sessions.broadcastMessagesChanged();
    };
    return { prefix, confirm: () => settle(Date.now()), rejectBeforeSubmission: () => settle() };
  } catch (error) {
    if (userMessageId.startsWith('assignment-start-')) throw error;
    console.warn('[mailbox] initial assignment unavailable for this turn', sessionId, error);
  }
}
