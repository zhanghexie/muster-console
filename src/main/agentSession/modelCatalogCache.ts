import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeTextAtomicSync } from '../atomicJson';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';

let file: string | undefined;
let snapshots: Map<string, unknown> | undefined;
let revision = 0;
const revisions = new Map<string, number>();
const keyFor = (scope: string, key: string): string =>
  `${scope}:${createHash('sha256').update(key).digest('hex')}`;

export function configureModelCatalogStorage(userData: string): void {
  file = userDataStorage(userData).file('harness-model-catalogs');
  snapshots = undefined;
  revisions.clear();
}

function readSnapshots(): Map<string, unknown> {
  if (snapshots) return snapshots;
  let entries: [string, unknown][] = [];
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.entries)) throw new Error('Invalid catalog snapshot');
      entries = saved.entries.filter((entry: unknown): entry is [string, unknown] =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' &&
        /^[a-z-]+:[a-f0-9]{64}$/.test(entry[0]) && entry[1] != null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[model-catalog] invalid saved catalog snapshot; refresh to rebuild');
      }
    }
  }
  return snapshots = new Map(entries);
}

/** Stores only adapter-normalized discovery results. Scope inputs are hashed before writing. */
export class ModelCatalogCache<T> {
  constructor(private readonly scope: string) {}

  get(key: string): T | undefined {
    return structuredClone(readSnapshots().get(keyFor(this.scope, key))) as T | undefined;
  }

  /** Exact persisted entry generation, including removal on eviction. */
  revision(key: string): number {
    const id = keyFor(this.scope, key);
    if (!readSnapshots().has(id)) return 0;
    const current = revisions.get(id);
    if (current !== undefined) return current;
    revisions.set(id, ++revision);
    return revision;
  }

  set(key: string, value: T): void {
    const next = new Map(readSnapshots());
    const id = keyFor(this.scope, key);
    next.delete(id);
    const own = [...next.keys()].filter(entry => entry.startsWith(`${this.scope}:`));
    const evicted = own.slice(0, Math.max(0, own.length - 63));
    for (const oldest of evicted) next.delete(oldest);
    next.set(id, structuredClone(value));
    if (file) writeTextAtomicSync(file, JSON.stringify({ version: 1, entries: [...next] }));
    snapshots = next;
    for (const oldest of evicted) revisions.delete(oldest);
    revisions.set(id, ++revision);
  }
}
