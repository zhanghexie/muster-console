import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), cleanups: [] as Array<() => void | Promise<void>> }));
vi.mock('../../../src/main/ipc/handle', () => ({
  handle: (name: string, handler: (...args: any[]) => any) => state.handlers.set(name, handler),
  ipcCaller: (event: unknown) => event,
  ownIpcResource: (cleanup: () => void | Promise<void>) => state.cleanups.push(cleanup)
}));
import { registerHistorySearchIpc } from '../../../src/main/ipc/chatSearch';

describe('history search ownership', () => {
  beforeEach(() => { state.handlers.clear(); state.cleanups.length = 0; });
  const caller = (id: string) => ({ id, isAlive: () => true });
  const read = () => ({ before: 0, total: 1, messages: [{ id: 'm', role: 'user' as const, content: 'hit' }] });

  it('cancels only the requesting client and drains on domain disposal', async () => {
    registerHistorySearchIpc('chat', read);
    const search = state.handlers.get('chat:search')!;
    const cancel = state.handlers.get('chat:searchCancel')!;
    const a = search(caller('a'), 's', 'hit', 'S', 'same-request');
    const b = search(caller('b'), 's', 'hit', 'S', 'same-request');
    cancel(caller('a'), 'same-request');
    expect((await a).hits).toEqual([]);
    expect((await b).hits).toHaveLength(1);
    const closing = search(caller('b'), 's', 'hit', 'S', 'closing');
    await state.cleanups[0]();
    expect((await closing).hits).toEqual([]);
  });

  it('stops a disconnected client before scanning another body page', async () => {
    let alive = true, reads = 0;
    registerHistorySearchIpc('chat', () => { reads++; return read(); });
    const result = state.handlers.get('chat:search')!({ id: 'a', isAlive: () => alive }, 's', 'hit', 'S', 'disconnect');
    alive = false;
    expect((await result).hits).toEqual([]);
    expect(reads).toBe(1);
  });
});
