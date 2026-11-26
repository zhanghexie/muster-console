import { materializeForExecution } from './lifecycle';
import { t } from '../../../shared/i18n';
import { currentSuggestedReplies, sameReplySuggestions, type ComposerReplySuggestions } from '../../../shared/replySuggestions';
import type { HostCore } from './internal';
import { persistEntry, syncEntry } from './base';

/** Clear only the exact current suggestion snapshot; pending questions remain intact. */
export function clearSuggestedReplies(host: HostCore, sessionId: string, expected: ComposerReplySuggestions): boolean {
  const entry = materializeForExecution(host,sessionId);
  if (!entry || entry.closed) throw new Error(t('GUI 会话宿主未就绪'));
  if (!sameReplySuggestions(currentSuggestedReplies(entry.messages, entry.busy, 'gui-session'), expected)) return false;
  const message = entry.messages.find(item => item.id === expected.messageId);
  if (!message) return false;
  const previous = message.suggestedReplies;
  delete message.suggestedReplies;
  try { persistEntry(host, entry, [message]); }
  catch (error) { message.suggestedReplies = previous; throw error; }
  syncEntry(host, entry);
  return true;
}
