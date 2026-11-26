import { setImmediate } from 'node:timers/promises';
import { CHAT_SEARCH_MAX_HITS, searchChatMessagesWithMeta, type ChatSearchableMessage, type ChatSearchHit, type ChatSearchOutcome } from '../shared/chatSearch';

type Page = { messages: readonly ChatSearchableMessage[]; before: number; total: number };

/** Scan bounded projection pages; only snippets cross IPC or survive a page. */
export async function searchHistoryPages(
  read: (before: number | undefined, limit: number) => Page | null,
  query: string,
  session: { id: string; name: string },
  active: () => boolean
): Promise<ChatSearchOutcome<ChatSearchHit[]>> {
  const hits: ChatSearchHit[] = [];
  if (typeof query !== 'string' || !query.trim() || !active()) return { hits, truncated: false };
  if (query.length > 4096) throw new Error('Search query exceeds 4096 characters');
  const size = 120;
  const tail = read(undefined, 1);
  if (!tail || !Number.isSafeInteger(tail.total) || tail.total < 0) throw new Error('Conversation history is unavailable');
  const total = tail.total;
  for (let start = 0; start < total; start += size) {
    await setImmediate();
    if (!active()) return { hits: [], truncated: false };
    const page = read(Math.min(total, start + size), Math.min(size, total - start));
    // Clear/removal during the scan invalidates ordinal positions. Report the
    // read failure instead of returning a misleading partial result.
    if (!page || page.total < total || page.before !== start) throw new Error('Conversation changed during search; retry the search');
    const result = searchChatMessagesWithMeta(page.messages, query, session);
    const ordinals = new Map(page.messages.map((message, index) => [message.id, start + index]));
    for (const hit of result.hits) hit.messageIndex = ordinals.get(hit.messageId);
    const remaining = CHAT_SEARCH_MAX_HITS - hits.length;
    hits.push(...result.hits.slice(0, remaining));
    if (result.truncated || result.hits.length > remaining) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}
