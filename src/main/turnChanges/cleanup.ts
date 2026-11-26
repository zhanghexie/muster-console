import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/** Session-owned turn snapshots: remove deleted owners and retain only each
 * surviving owner's newest usable snapshot. The shared baseline cache is separate. */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context';
import { retainLatestSnapshots, type SnapshotMessage, type SnapshotReference } from './retention';

export type TurnChangesOwnerLiveness = 'gone' | 'done' | 'active';
export interface TurnChangesRecordStat { file: string; owner: string | null; messageId: string | null; id: string; bytes: number; mtimeMs: number }
export interface TurnChangesSweepResult { removedFiles: number; removedBytes: number; keptBytes: number }
type Messages = readonly SnapshotMessage[];
type OwnerReaders = { live: () => Messages | Promise<Messages>; durable: () => Messages | Promise<Messages> };
type RetentionService = { setRetentionCallback(callback: (owner: string, reference?: SnapshotReference) => void): void; isSnapshotBusy(id: string): boolean };

const SWEEP_FIRST_DELAY_MS = 30_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SETTLE_DELAY_MS = 1500;

/** Only the top-level JSON files are snapshots; caches and temporary files stay separate. */
export async function scanTurnChangesRecords(dir: string): Promise<TurnChangesRecordStat[]> {
  const stats: TurnChangesRecordStat[] = [];
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    try {
      const [st, raw] = await Promise.all([fs.promises.stat(file), fs.promises.readFile(file, 'utf8')]);
      let owner: string | null = null, messageId: string | null = null;
      try {
        const record = JSON.parse(raw) as { owner?: unknown; messageId?: unknown };
        if (typeof record?.owner === 'string') owner = record.owner;
        if (typeof record?.messageId === 'string') messageId = record.messageId;
      } catch { /* Unreadable records cannot be opened as snapshots. */ }
      stats.push({ file, owner, messageId, id: entry.name.slice(0, -5), bytes: st.size, mtimeMs: st.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[turn-changes] 快照统计失败', file, error);
    }
  }
  return stats;
}

async function unlinkRecords(records: readonly TurnChangesRecordStat[]): Promise<TurnChangesSweepResult> {
  let removedFiles = 0, removedBytes = 0;
  for (const record of records) {
    try { await fs.promises.unlink(record.file); removedFiles++; removedBytes += record.bytes; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[turn-changes] 快照清理失败', record.file, error); }
  }
  return { removedFiles, removedBytes, keptBytes: 0 };
}

/** Deleted owners are purged. Surviving owners have no byte/time eviction:
 * their newest usable snapshot is retained after its transcript is durable. */
export async function sweepTurnChanges(dir: string, opts: {
  classify: (owner: string | null) => TurnChangesOwnerLiveness;
  readers?: (owner: string) => OwnerReaders | null;
  protectedId?: (id: string) => boolean;
}): Promise<TurnChangesSweepResult> {
  const records = await scanTurnChangesRecords(dir);
  const gone = records.filter(record => opts.classify(record.owner) === 'gone');
  const result = await unlinkRecords(gone);
  const owners = new Set(records.filter(record => record.owner && opts.classify(record.owner) !== 'gone').map(record => record.owner!));
  for (const owner of owners) {
    const readers = opts.readers?.(owner);
    if (!readers) continue;
    const owned = records.filter(record => record.owner === owner);
    // When old scheduler messages are gone, only file modification time is
    // available to choose one fallback for the entire workspace.
    const extra: SnapshotReference[] = owned.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file))
      .flatMap(record => record.messageId ? [{ id: record.id, messageId: record.messageId }] : []);
    try {
      const retained = await retainLatestSnapshots(dir, owner, readers.live, readers.durable,
        { extra, protectedId: opts.protectedId, fallbackToExtra: owner.startsWith('dispatch:') });
      const removed = new Set(retained.removedIds);
      result.removedFiles += removed.size;
      result.removedBytes += owned.filter(record => removed.has(record.id)).reduce((sum, record) => sum + record.bytes, 0);
    } catch (error) { console.warn('[turn-changes] 会话快照清理失败', owner, error); }
  }
  return { ...result, keptBytes: records.reduce((sum, record) => sum + record.bytes, 0) - result.removedBytes };
}

/** Session deletion also purges its GUI snapshots, independently of retention. */
export async function purgeTurnChangesForSessions(dir: string, sessionIds: readonly string[]): Promise<TurnChangesSweepResult> {
  const owners = new Set(sessionIds.filter(Boolean).map(id => `gui:${id}`));
  if (!owners.size) return { removedFiles: 0, removedBytes: 0, keptBytes: 0 };
  const records = await scanTurnChangesRecords(dir);
  const result = await unlinkRecords(records.filter(record => record.owner !== null && owners.has(record.owner)));
  return { ...result, keptBytes: records.reduce((sum, record) => sum + record.bytes, 0) - result.removedBytes };
}

function classifyOwner(ctx: AppContext): (owner: string | null) => TurnChangesOwnerLiveness {
  return owner => {
    if (owner === null) return 'gone';
    if (owner.startsWith('gui:')) {
      const row = ctx.sessions.get(owner.slice('gui:'.length));
      return !row ? 'gone' : row.archived ? 'done' : 'active';
    }
    if (owner.startsWith('dispatch:')) return ctx.config.get().workspaces.some(w => w.id === owner.slice('dispatch:'.length)) ? 'active' : 'gone';
    return 'gone';
  };
}

function readersForOwner(ctx: AppContext, owner: string): OwnerReaders | null {
  if (owner.startsWith('gui:')) {
    const id = owner.slice('gui:'.length), host = ctx.agentSessions;
    if (!host || !ctx.sessions.get(id)) return null;
    const durable = async (): Promise<Messages> => await host.store.loadForReviewRetention(id) ?? [];
    return { durable, live: () => {
      const entry = host.entries.get(id);
      return entry && !entry.closed ? entry.messages : durable();
    } };
  }
  if (owner.startsWith('dispatch:')) {
    const id = owner.slice('dispatch:'.length);
    if (!ctx.config.get().workspaces.some(w => w.id === id)) return null;
    const durable = async (): Promise<Messages> => await ctx.store.loadChatForReviewRetention(id) ?? [];
    return { durable, live: () => ctx.orchestrator?.buckets.get(id)?.display ?? durable() };
  }
  return null;
}

export function startTurnChangesCleanupSweeper(ctx: AppContext, userDataDir: string, service: RetentionService): void {
  const dir = userDataStorage(userDataDir).resolve('app', 'turn-changes');
  const classify = classifyOwner(ctx), readers = (owner: string) => readersForOwner(ctx, owner);
  const protectedId = (id: string) => service.isSnapshotBusy(id);
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  const dispatchRecords = new Map<string, Map<string, SnapshotReference & { mtimeMs: number }>>();
  let dispatchScanned = false, dispatchScan: Promise<void> | null = null;
  const remember = (owner: string, reference: SnapshotReference, mtimeMs: number) => {
    let records = dispatchRecords.get(owner);
    if (!records) { records = new Map(); dispatchRecords.set(owner, records); }
    const existing = records.get(reference.id);
    if (!existing || existing.mtimeMs < mtimeMs) records.set(reference.id, { ...reference, mtimeMs });
  };
  const ensureDispatchIndex = async () => {
    if (dispatchScanned) return;
    if (!dispatchScan) dispatchScan = scanTurnChangesRecords(dir).then(records => {
      for (const record of records) if (record.owner?.startsWith('dispatch:') && record.messageId) {
        remember(record.owner, { id: record.id, messageId: record.messageId }, record.mtimeMs);
      }
      dispatchScanned = true;
    }).finally(() => { dispatchScan = null; });
    await dispatchScan;
  };
  const run = () => {
    void sweepTurnChanges(dir, { classify, readers, protectedId }).then(result => {
      // Rebuild on the next scheduler settlement to pick up external/legacy records.
      dispatchRecords.clear(); dispatchScanned = false;
      if (result.removedFiles) console.log(`[turn-changes] 清理 ${result.removedFiles} 个快照记录（${result.removedBytes} 字节）`);
    }).catch(error => console.warn('[turn-changes] 清理失败', error));
  };
  const schedule = (owner: string, attempt = 0) => {
    const previous = scheduled.get(owner); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      scheduled.delete(owner);
      const current = readers(owner);
      if (!current) return;
      const retain = async () => {
        const dispatch = owner.startsWith('dispatch:');
        // Scan legacy owners once, then update this in-memory index from saved
        // snapshots instead of rereading every session's files on each turn.
        if (dispatch) await ensureDispatchIndex();
        const extra = [...(dispatchRecords.get(owner)?.values() ?? [])].sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
        const result = await retainLatestSnapshots(dir, owner, current.live, current.durable, { protectedId, extra, fallbackToExtra: dispatch });
        for (const id of result.removedIds) dispatchRecords.get(owner)?.delete(id);
        return result;
      };
      void retain().then(result => {
        if (result.deferred && !scheduled.has(owner)) {
          if (attempt < 3) schedule(owner, attempt + 1);
          else console.warn('[turn-changes] 会话历史尚未确认落盘，已保留旧快照', owner);
        }
      }).catch(error => console.warn('[turn-changes] 会话快照清理失败', owner, error));
    }, SETTLE_DELAY_MS);
    scheduled.set(owner, timer); timer.unref?.();
  };
  service.setRetentionCallback((owner, reference) => {
    if (owner.startsWith('dispatch:') && reference) remember(owner, reference, Date.now());
    schedule(owner);
  });
  const first = setTimeout(run, SWEEP_FIRST_DELAY_MS); first.unref?.();
  const timer = setInterval(run, SWEEP_INTERVAL_MS); timer.unref?.();
}
