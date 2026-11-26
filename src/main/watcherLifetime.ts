import type { FSWatcher } from 'node:fs';

/** Track the native close event, including watchers already retired by reconfiguration. */
export class WatcherLifetime {
  private readonly owned = new Map<FSWatcher, { closed: Promise<void>; closing?: Promise<void> }>();

  own(watcher: FSWatcher): FSWatcher {
    const closed = new Promise<void>(resolve => watcher.once('close', () => {
      this.owned.delete(watcher);
      resolve();
    }));
    this.owned.set(watcher, { closed });
    return watcher;
  }

  close(watcher: FSWatcher): Promise<void> {
    const entry = this.owned.get(watcher);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    // Publish before close(), which may emit close synchronously in an adapter.
    let resolve!: () => void, reject!: (error: unknown) => void;
    entry.closing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void entry.closing.catch(() => { entry.closing = undefined; });
    void entry.closed.then(resolve);
    try { watcher.close(); } catch (error) { reject(error); }
    return entry.closing;
  }

  retire(watcher: FSWatcher | null | undefined): void {
    if (watcher) void this.close(watcher).catch(error => console.error('[fs.watch] close failed; owner retained for retry', error));
  }

  async shutdown(): Promise<void> {
    const results = await Promise.allSettled([...this.owned.keys()].map(watcher => this.close(watcher)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Native file watchers failed to close');
  }
}
