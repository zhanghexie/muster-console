import { t } from '../../../shared/i18n';
import { currentSuggestedReplies, sameReplySuggestions, type ComposerReplySuggestions } from '../../../shared/replySuggestions';
import type { OrchestratorHost } from './internal';

/** Dismiss the displayed snapshot without responding to any pending question. */
export function clearSuggestedReplies(host: OrchestratorHost, workspaceId: string, expected: ComposerReplySuggestions): boolean {
  const bucket = host.buckets.get(workspaceId);
  if (!bucket) throw new Error(t('当前工作区不可用'));
  if (!sameReplySuggestions(currentSuggestedReplies(bucket.display, bucket.busy, 'dispatch'), expected)) return false;
  const message = bucket.display.find(item => item.id === expected.messageId);
  if (!message) return false;
  const previous = message.suggestedReplies;
  delete message.suggestedReplies;
  try { host.persistBucket(workspaceId); }
  catch (error) { message.suggestedReplies = previous; throw error; }
  host.emit('agent:message', { ...message, workspaceId });
  return true;
}
