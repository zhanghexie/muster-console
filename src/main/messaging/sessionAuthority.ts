import { createHash } from 'node:crypto';
import type { SessionMeta } from '../../shared/types';
import type { MessagingAccountRef } from './contracts';

export const MESSAGING_SESSION_OWNER = 'musterMessagingOwner';

export function messagingSessionOwner(account: MessagingAccountRef): string {
  return createHash('sha256').update(JSON.stringify([account.channelKey, account.botId])).digest('hex');
}

export function ownsMessagingSession(session: SessionMeta | undefined, owner: string): session is SessionMeta {
  return !!session && session.runtime === 'pi' && session.configurePermissions === true &&
    session.meta?.[MESSAGING_SESSION_OWNER] === owner;
}

export function messagingTurnIdentity(requestId: string, origin: 'channel' | 'desktop' = 'channel'): { userMessageId: string; assistantMessageId: string } {
  const digest = createHash('sha256').update(requestId).digest('hex');
  const prefix = origin === 'desktop' ? 'im-local' : 'im';
  return { userMessageId: `${prefix}-user-${digest}`, assistantMessageId: `${prefix}-assistant-${digest}` };
}

export function isMessagingUserMessageId(id: string | undefined): boolean {
  return !!id && /^im(?:-local)?-user-[a-f0-9]{64}$/.test(id);
}

export function isMessagingAssistantMessageId(id: string | undefined): boolean {
  return !!id && /^im(?:-local)?-assistant-[a-f0-9]{64}$/.test(id);
}
