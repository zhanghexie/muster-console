import type { ApiMock } from './api-mock';
import { searchChatMessagesWithMeta, type ChatSearchableMessage } from '../../../src/shared/chatSearch';

/** Small message fixtures are converted to the new snippet-only IPC contract. */
export function mockSearch(api: ApiMock, route: 'chat.search' | 'agentSession.search',
  read: (id: unknown) => unknown): void {
  api.override(route, async (id: string, query: string, name: string) => {
    const raw = await read(id);
    const messages = Array.isArray(raw) ? raw : (raw as { messages?: ChatSearchableMessage[] } | null)?.messages ?? [];
    return searchChatMessagesWithMeta(messages, query, { id: route === 'chat.search' ? `dispatch:${id}` : id, name });
  });
}
