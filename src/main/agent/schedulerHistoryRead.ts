import type { ChatMessage } from '../../shared/types';
import type { ChatHistoryPage } from '../../shared/chatSurface';
import { CHAT_HISTORY_PAGE_SIZE } from '../../shared/chatHistory';

export type SchedulerHistoryReader = {
  getHistoryRange(workspaceId: string, before?: number, limit?: number): ChatHistoryPage;
};

/** Tail readers stop as soon as their bounded answer is complete, and never
 * construct an active bucket or concatenate historical pages. */
export function* iterateSchedulerHistoryNewestFirst(reader: SchedulerHistoryReader, workspaceId: string): IterableIterator<ChatMessage> {
  let before: number | undefined;
  for (;;) {
    const page = reader.getHistoryRange(workspaceId, before, CHAT_HISTORY_PAGE_SIZE);
    for (let index = page.messages.length - 1; index >= 0; index--) yield page.messages[index];
    if (!page.hasEarlier) return;
    if (!Number.isSafeInteger(page.before) || page.before < 0 || (before !== undefined && page.before >= before)) {
      throw new Error('Scheduler history cursor did not advance');
    }
    before = page.before;
  }
}

export function findLatestSchedulerMessage(reader: SchedulerHistoryReader, workspaceId: string, predicate: (message: ChatMessage) => boolean): ChatMessage | undefined {
  for (const message of iterateSchedulerHistoryNewestFirst(reader, workspaceId)) if (predicate(message)) return message;
  return undefined;
}
