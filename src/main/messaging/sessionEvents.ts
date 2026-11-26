import { guiMessageText, type GuiChatMessage } from '../../shared/guiWorker';
import { isMessagingAssistantMessageId, isMessagingUserMessageId } from './sessionAuthority';

export type MessagingSessionEvent = Readonly<{
  seq: number; time?: number; type: string; surfaceOp?: 'append'; data: Record<string, unknown>;
}>;
export type MessagingSessionEventListener = (session: { id: string }, event: MessagingSessionEvent) => void;
export const SESSION_EVENT_STRIDE = 4;

function turnNumber(message: GuiChatMessage): number {
  return Number.parseInt(message.id.slice(-13), 16);
}

export function projectSessionMessage(message: GuiChatMessage, offset: number): MessagingSessionEvent[] {
  const seq = offset * SESSION_EVENT_STRIDE;
  const text = guiMessageText(message);
  const content = text ? [{ type: 'text', text }] : [];
  const turn = turnNumber(message);
  if (message.role === 'user' && isMessagingUserMessageId(message.id)) {
    const source = { kind: 'user', rpcId: message.id };
    return [
      { seq, time: message.ts, type: 'turn/start', data: { turn } },
      { seq: seq + 1, time: message.ts, type: 'user/message', surfaceOp: 'append', data: { turn, source, content, message: { content } } }
    ];
  }
  if (message.role === 'assistant' && isMessagingAssistantMessageId(message.id)) {
    const items: MessagingSessionEvent[] = [{ seq, time: message.finishedAt ?? message.ts,
      type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 0, message: { content } } }];
    if (message.finishedAt) items.push({ seq: seq + 1, time: message.finishedAt, type: 'turn/end', data: {
      turn, reason: { kind: message.aborted ? 'cancelled' : message.error ? 'failed' : 'completed' }
    } });
    return items;
  }
  // A private row still advances the cursor, without disclosing its content.
  return [{ seq, type: 'session/cursor', data: {} }];
}
