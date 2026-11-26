import fs from 'node:fs';
import path from 'node:path';
import type { EventEnvelope, SessionHandleContract } from './contracts';
import type { SessionManager } from './kernelContracts';
import { SessionEventLog } from './sessionEventLog';

export type SessionNamespace = 'plugin' | 'scheduler' | 'gui';
export interface SessionLogHandle extends SessionHandleContract {
  readonly sessionId: string;
  readonly hasPendingWrites: boolean;
  appendSync(event: EventEnvelope): { seq: number };
  loadSync(consumer?: (event: EventEnvelope) => void): void;
  readRangeSync(query: import('./contracts').SessionRangeQuery): EventEnvelope[];
  readAllSync(): EventEnvelope[];
  flushSync(): void;
  deleteSync(): void;
}
export interface SessionLogFactory {
  openSync(namespace: SessionNamespace, sessionId: string): SessionLogHandle;
  release(sessionId: string, namespace?: SessionNamespace): Promise<void>;
}
type Entry = { handle: SessionLogHandle; isClosing(): boolean; release(): Promise<void> };

/** One event writer per namespace/session, shared by plugins and built-in adapters. */
export class FileSessionManager implements SessionManager, SessionLogFactory {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(private readonly root: string, private readonly roots: Partial<Record<SessionNamespace, string>> = {}) {}
  private key(namespace: SessionNamespace, sessionId: string): string { return namespace === 'plugin' ? sessionId : `${namespace}:${sessionId}`; }
  private directory(namespace: SessionNamespace): string {
    if (namespace === 'plugin') return this.root;
    const root = this.roots[namespace];
    if (!root) throw new Error(`Session namespace is not configured: ${namespace}`);
    return root;
  }

  async create(sessionId: string): Promise<SessionHandleContract> {
    this.assertOpen(sessionId);
    if (this.entries.has(sessionId)) throw new Error(`Session already open: ${sessionId}`);
    fs.mkdirSync(this.root, { recursive: true });
    fs.closeSync(fs.openSync(path.join(this.root, `${sessionId}.ndjson`), 'wx'));
    return this.open(sessionId);
  }
  async open(sessionId: string): Promise<SessionHandleContract> { return this.openSync('plugin', sessionId); }

  openSync(namespace: SessionNamespace, sessionId: string): SessionLogHandle {
    this.assertOpen(sessionId);
    const key = this.key(namespace, sessionId);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.isClosing()) throw new Error(`Session is released: ${sessionId}`);
      return existing.handle;
    }
    const log = new SessionEventLog(this.directory(namespace), sessionId);
    const operations = new Set<Promise<unknown>>();
    const subscriptions = new Set<() => void>();
    let closing = false;
    let releasePromise: Promise<void> | undefined;
    const assertActive = (): void => {
      if (closing || this.disposed) throw new Error(`Session is released: ${sessionId}`);
    };
    const run = <T>(action: () => Promise<T>): Promise<T> => {
      try { assertActive(); } catch (error) { return Promise.reject(error); }
      const operation = Promise.resolve().then(action);
      operations.add(operation);
      void operation.then(() => operations.delete(operation), () => operations.delete(operation));
      return operation;
    };
    const handle: SessionLogHandle = {
      sessionId,
      get hasPendingWrites() { return log.hasPendingWrites; },
      append: event => run(() => log.append(event)),
      appendSync: event => { assertActive(); return log.appendSync(event); },
      loadSync: consumer => { assertActive(); log.loadSync(consumer); },
      readRangeSync: query => { assertActive(); return log.readRangeSync(query); },
      readAllSync: () => { assertActive(); return log.readAllSync(); },
      readRange: query => run(() => log.readRange(query)),
      fork: options => run(() => log.fork(options)),
      flush: reason => run(() => log.flush(reason)),
      flushSync: () => { assertActive(); log.flushSync(); },
      deleteSync: () => { assertActive(); log.deleteSync(); },
      subscribeLive: listener => {
        assertActive();
        const off = log.subscribeLive(listener);
        const unsubscribe = (): void => { off(); subscriptions.delete(unsubscribe); };
        subscriptions.add(unsubscribe);
        return unsubscribe;
      }
    };
    const release = (): Promise<void> => {
      closing = true;
      return releasePromise ??= (async () => {
        for (const off of subscriptions) off();
        const results = await Promise.allSettled([...operations]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        try { await log.flush('session-release'); } catch (error) { errors.push(error); }
        // Failed flush retains ownership: a new writer must not hide lost writes.
        if (errors.length) throw new AggregateError(errors, `Session release failed: ${sessionId}`);
        this.entries.delete(key);
      })();
    };
    this.entries.set(key, { handle, isClosing: () => closing, release });
    return handle;
  }

  async release(sessionId: string, namespace: SessionNamespace = 'plugin'): Promise<void> { await this.entries.get(this.key(namespace, sessionId))?.release(); }
  list(): readonly string[] { return [...this.entries.keys()]; }
  dispose(): Promise<void> {
    this.disposed = true;
    return this.disposal ??= (async () => {
      const results = await Promise.allSettled([...this.entries.values()].map(entry => entry.release()));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Session manager disposal failed');
    })();
  }
  private assertOpen(sessionId: string): void {
    if (this.disposed) throw new Error('Session manager is disposed');
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  }
}
