import { createGuiUserMessage } from '../../../shared/guiWorker';
import { messagingTurnIdentity, ownsMessagingSession } from '../../messaging/sessionAuthority';
import { isMessagingId, type SessionSubmissionResult } from '../../messaging/contracts';
import type { GuiSendImage } from '../types';
import { persistEntry } from './base';
import type { HostCore } from './internal';
import { materializeForExecution } from './lifecycle';
import { startTurn } from './turn';
import { rejectImagesForSessionModel } from './usage';

export type MessagingInput = Readonly<{
  owner: string;
  workspaceId: string;
  requestId: string;
  text: string;
  images?: GuiSendImage[];
  origin?: 'channel' | 'desktop';
}>;

/** Remote humans can submit visible literal content to their own dedicated Session. */
export function acceptMessagingInput(host: HostCore, sessionId: string, input: MessagingInput, workbenchBound = false): SessionSubmissionResult {
  const session = host.ctx.sessions.get(sessionId);
  const text = input.text.trim();
  if (!session || session.archived || session.workspaceId !== input.workspaceId ||
      (workbenchBound ? session.type !== 'terminal' || !host.ctx.sessions.isChatRuntime(session.runtime)
        : !ownsMessagingSession(session, input.owner) || session.guiMode !== 'ask') ||
      !isMessagingId(input.requestId) || text.length > 64 * 1024 || (!text && !input.images?.length)) {
    return { status: 'rejected' };
  }
  if (!host.openedSessionIds.has(sessionId)) return { status: 'retryable' };
  const entry = materializeForExecution(host, sessionId);
  if (entry.closed || entry.clearing || entry.forking || entry.workerSwitch || (!workbenchBound && entry.mode !== 'ask') ||
      entry.forkPendingError || entry.forkDeliveryState === 'unknown') {
    return { status: 'retryable' };
  }
  const { userMessageId, assistantMessageId } = messagingTurnIdentity(input.requestId, input.origin);
  if (entry.messages.some(message => message.id === userMessageId && message.role === 'user')) {
    const assistantExists = entry.messages.some(message => message.id === assistantMessageId && message.role === 'assistant');
    return assistantExists ? { status: 'accepted', turnId: assistantMessageId } : { status: 'unknown' };
  }
  if (entry.busy || entry.queue.length > 0 || entry.pendingSends) return { status: 'retryable' };
  if (input.images?.length && (!host.drivers.get(entry.runtimeId)?.supportsImages || rejectImagesForSessionModel(host, entry, input.images))) {
    return { status: 'rejected' };
  }
  const images = input.images?.map(({ data, mimeType, name }, index) => ({ id: `${userMessageId}-image-${index}`, data, mimeType, name }));
  const message = createGuiUserMessage({ id: userMessageId, text, ts: Date.now(), ...(images?.length ? { images } : {}) });
  entry.pendingSends = (entry.pendingSends ?? 0) + 1;
  entry.messages.push(message);
  try {
    persistEntry(host, entry, [message]);
    void startTurn(host, entry, { text, images: input.images, userMessageId, messagingAssistantId: assistantMessageId }).catch(() => {});
    return entry.assistant?.id === assistantMessageId ? { status: 'accepted', turnId: assistantMessageId } : { status: 'unknown' };
  } catch {
    const index = entry.messages.indexOf(message);
    if (index >= 0) entry.messages.splice(index, 1);
    return { status: 'unknown' };
  } finally {
    entry.pendingSends -= 1;
  }
}
