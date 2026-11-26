import { handle, ipcCaller, ownIpcResource } from './handle';
import { searchHistoryPages } from '../chatHistorySearch';
import type { ChatSearchableMessage } from '../../shared/chatSearch';

export function registerHistorySearchIpc(
  channel: string,
  read: (id: string, before: number | undefined, limit: number) => { messages: readonly ChatSearchableMessage[]; before: number; total: number } | null,
  findId: (id: string) => string = id => id
): void {
  const jobs = new Set<{ caller: string; requestId: string; cancelled: boolean; pending?: Promise<unknown> }>();
  ownIpcResource(async () => {
    for (const job of jobs) job.cancelled = true;
    await Promise.allSettled([...jobs].map(job => job.pending));
    jobs.clear();
  });
  handle(`${channel}:searchCancel`, (event, requestId: string) => {
    const caller = ipcCaller(event);
    for (const job of jobs) if (job.caller === caller.id && job.requestId === requestId) job.cancelled = true;
  });
  handle(`${channel}:search`, async (event, id: string, query: string, name: string, requestId: string) => {
    const caller = ipcCaller(event);
    if (typeof id !== 'string' || !id || typeof requestId !== 'string' || !requestId || requestId.length > 128) throw new Error('Invalid history search request');
    if ([...jobs].filter(job => job.caller === caller.id).length >= 8) throw new Error('Too many concurrent history searches');
    const job: { caller: string; requestId: string; cancelled: boolean; pending?: Promise<unknown> } = { caller: caller.id, requestId, cancelled: false }; jobs.add(job);
    try {
      const pending = searchHistoryPages((before, limit) => read(id, before, limit), query,
        { id: findId(id), name: typeof name === 'string' ? name.slice(0, 256) : id },
        () => !job.cancelled && caller.isAlive());
      job.pending = pending;
      return await pending;
    } finally { jobs.delete(job); }
  });
}
