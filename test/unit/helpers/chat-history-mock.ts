import type { ApiMock } from './api-mock';
import { resolveChatHistoryWindow } from '../../../src/shared/chatHistory';

/** Fixture bodies stay small; production exposes only the requested page. */
export function mockHistoryRange(api: ApiMock, read: (...args: any[]) => any): void {
  api.override('chat.historyRange', async (workspaceId, before, limit = 120, targetMessageId) => {
    const messages = await read(workspaceId);
    const { start, end } = resolveChatHistoryWindow(messages, before, limit, targetMessageId);
    return { messages: messages.slice(start, end), before: start, total: messages.length, hasEarlier: start > 0 };
  });
}
