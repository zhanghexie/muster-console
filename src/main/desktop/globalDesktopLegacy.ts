import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';
import { boundedVisibleActionResult } from './visibleActionJson';
import type { LegacyDesktopQuiescence } from './legacyDesktopMigration';

/** Host must hold exclusion continuously and prevent legacy writers from restarting after activation. */
export interface GlobalDesktopTransitionFence extends LegacyDesktopQuiescence {
  allLegacyRootsEnumerated(): boolean;
  allOutboxesEnumerated(): boolean;
  legacyWritersPermanentlyExcluded(): boolean;
  verifyLegacyDelivery(record: Readonly<{ kind: 'outbox'; identity: string; resultHash: string }>): boolean;
  verifyLegacyResolution(record: Readonly<{ invocationId: string; sessionHash: string; taskId: string;
    source: string; action: string; target: string; resolution: string; auditId: string }>): boolean;
  /** Old automatically resumed work cannot dispatch even through the new writer. */
  legacyAutomaticContinuationsExcluded(): boolean;
}

export interface GlobalLegacyReceipt {
  readonly rootHash: string;
  readonly requestHash: string;
  readonly fingerprint: string;
  readonly resultHash: string;
  readonly format: 'win32-dispatch-v1' | 'win32-launch-v1';
}

export interface GlobalLegacyPreview {
  readonly manifestHash: string;
  readonly receiptCount: number;
  readonly dispatchCount: number;
  readonly launchCount: number;
  readonly delivery: 'unverified';
}

export function assertGlobalTransition(fence: GlobalDesktopTransitionFence): void {
  try {
    if (fence?.isQuiescent() === true && fence.allLegacyRootsEnumerated() === true && fence.allOutboxesEnumerated() === true &&
        fence.legacyWritersPermanentlyExcluded() === true && fence.legacyAutomaticContinuationsExcluded() === true &&
        typeof fence.verifyLegacyResolution === 'function' &&
        typeof fence.verifyLegacyDelivery === 'function') return;
  } catch { /* fail closed */ }
  throw new Error('A host-owned desktop transition fence covering all legacy writers and outboxes is required');
}

async function stat(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try { return await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function plain(info: Awaited<ReturnType<typeof fs.lstat>>): boolean { return info.isFile() && !info.isSymbolicLink(); }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

async function inspectCopy(root: string, file: string, fence: GlobalDesktopTransitionFence, inspect: (db: DatabaseSync) => void): Promise<void> {
  const main = await stat(file), wal = await stat(`${file}-wal`), shm = await stat(`${file}-shm`), rollback = await stat(`${file}-journal`);
  assertGlobalTransition(fence);
  if (rollback || (!main && (wal || shm)) || (shm && !wal)) throw new Error('Legacy database has an unresolved or orphan sidecar');
  if (!main) return;
  if (!plain(main) || main.size > 64 * 1024 * 1024 || (wal && (!plain(wal) || wal.size > 64 * 1024 * 1024)) ||
      (shm && (!plain(shm) || shm.size > 64 * 1024 * 1024))) {
    throw new Error('Legacy database or WAL is invalid or too large');
  }
  const temp = await fs.mkdtemp(path.join(root, '.global-outbox-inspection-'));
  try {
    const copyStable = async (source: string, target: string, before: NonNullable<Awaited<ReturnType<typeof stat>>>) => {
      await fs.copyFile(source, target);
      const after = await fs.lstat(source);
      assertGlobalTransition(fence);
      if (!plain(after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error('Legacy database changed during inspection');
    };
    const copy = path.join(temp, 'legacy.sqlite');
    await copyStable(file, copy, main);
    if (wal) await copyStable(`${file}-wal`, `${copy}-wal`, wal);
    if (!!await stat(`${file}-wal`) !== !!wal || !!await stat(`${file}-shm`) !== !!shm || await stat(`${file}-journal`)) {
      throw new Error('Legacy database sidecars changed during inspection');
    }
    assertGlobalTransition(fence);
    const db = new DatabaseSync(sqliteFilePath(copy), { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON');
      const check = db.prepare('PRAGMA quick_check(1)').get();
      if (!check || Object.values(check)[0] !== 'ok') throw new Error('Legacy database integrity check failed');
      inspect(db);
    } finally { db.close(); }
  } finally {
    const resolvedRoot = await fs.realpath(root), resolvedTemp = await fs.realpath(temp);
    const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same(path.dirname(resolvedTemp), resolvedRoot) || !path.basename(resolvedTemp).startsWith('.global-outbox-inspection-')) {
      throw new Error('Refusing to clean an unexpected legacy inspection directory');
    }
    await fs.rm(resolvedTemp, { recursive: true, force: true });
  }
  assertGlobalTransition(fence);
}

/** Read only formats produced by the legacy Win32 runtime; none proves engine delivery. */
export async function readLegacyActionReceipts(root: string, fence: GlobalDesktopTransitionFence): Promise<GlobalLegacyReceipt[]> {
  const receipts: GlobalLegacyReceipt[] = [];
  const canonicalRoot = await fs.realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return path.resolve(root);
    throw error;
  });
  const rootHash = digest(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot);
  await inspectCopy(root, path.join(root, 'action-receipts.sqlite'), fence, db => {
    const rows = db.prepare('SELECT request_hash,fingerprint,state,result FROM desktop_action_receipts').iterate();
    let count = 0;
    for (const row of rows) {
      assertGlobalTransition(fence);
      if (++count > 10000 || typeof row.request_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.request_hash) ||
          typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint) || row.state !== 'completed' ||
          typeof row.result !== 'string' || Buffer.byteLength(row.result) > 65536) throw new Error('A legacy desktop action receipt is unresolved or invalid');
      const result: unknown = JSON.parse(row.result);
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).sort().join(',') !== 'outcome,value' ||
          (result as { outcome?: unknown }).outcome !== 'dispatched') throw new Error('Legacy desktop receipt format cannot be verified');
      const value = (result as { value?: unknown }).value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Legacy desktop receipt format cannot be verified');
      const keys = Object.keys(value).sort().join(',');
      const item = value as { dispatched?: unknown; pid?: unknown };
      let format: GlobalLegacyReceipt['format'];
      if (keys === 'dispatched' && item.dispatched === true) format = 'win32-dispatch-v1';
      else if (keys === 'pid' && Number.isSafeInteger(item.pid) && (item.pid as number) > 0) format = 'win32-launch-v1';
      else throw new Error('Legacy desktop receipt format cannot be verified');
      receipts.push(Object.freeze({ rootHash, requestHash: row.request_hash, fingerprint: row.fingerprint,
        resultHash: digest(row.result), format }));
    }
  });
  return receipts;
}

/** Stable, bounded preview: no input content, process ID or claimed delivery. */
export function legacyReceiptPreview(receipts: readonly GlobalLegacyReceipt[]): GlobalLegacyPreview {
  if (!Array.isArray(receipts) || receipts.length > 10000) throw new Error('Legacy receipt manifest exceeds the inspection limit');
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const sorted = [...receipts].sort((a, b) => compare(a.rootHash, b.rootHash) || compare(a.requestHash, b.requestHash));
  const seen = new Set<string>();
  for (const row of sorted) {
    if (!row || ![row.rootHash, row.requestHash, row.fingerprint, row.resultHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
        !['win32-dispatch-v1', 'win32-launch-v1'].includes(row.format)) throw new Error('Invalid legacy receipt manifest');
    const key = `${row.rootHash}:${row.requestHash}`;
    if (seen.has(key)) throw new Error('Duplicate legacy receipt source');
    seen.add(key);
  }
  const dispatchCount = sorted.filter(row => row.format === 'win32-dispatch-v1').length;
  return Object.freeze({ manifestHash: digest(JSON.stringify(sorted.map(row =>
    [row.rootHash, row.requestHash, row.fingerprint, row.resultHash, row.format]))), receiptCount: sorted.length,
    dispatchCount, launchCount: sorted.length - dispatchCount, delivery: 'unverified' });
}

/** Inspect all explicitly enumerated prior outboxes, including committed WAL, without modifying originals. */
export async function assertLegacyOutboxesClear(root: string, files: readonly string[], fence: GlobalDesktopTransitionFence): Promise<void> {
  if (!Array.isArray(files) || files.length > 64 || files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
    throw new Error('Absolute paths for all legacy outboxes are required');
  }
  assertGlobalTransition(fence);
  const seen = new Set<string>();
  for (const file of files) {
    const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    if (seen.has(key)) throw new Error('Duplicate legacy outbox path');
    seen.add(key);
    await inspectCopy(root, file, fence, db => {
      const barrier = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='visible_action_barriers'").get();
      if (barrier && db.prepare('SELECT 1 FROM visible_action_barriers LIMIT 1').get()) throw new Error('A legacy task barrier remains unresolved');
      const rows = db.prepare('SELECT id,session_hash,task_id,source,action,target,state,result,resolution,resolution_audit FROM write_outbox').iterate();
      let count = 0;
      for (const row of rows) {
        assertGlobalTransition(fence);
        if (++count > 10000) throw new Error('Legacy outbox exceeds the bounded inspection limit');
        if (typeof row.session_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.session_hash) ||
            [row.id, row.task_id, row.source, row.action, row.target].some(value => typeof value !== 'string' || !value.trim() || value.length > 1024)) {
          throw new Error('Invalid legacy outbox identity');
        }
        if (row.state !== 'delivered' || typeof row.result !== 'string' || Buffer.byteLength(row.result) > 65536) {
          throw new Error('A legacy outbox action is unresolved or corrupt');
        }
        const result: unknown = JSON.parse(row.result);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid legacy outbox result');
        const item = result as { outcome?: unknown; value?: unknown };
        if (item.outcome === 'known') {
          if (Object.keys(item).sort().join(',') !== 'outcome,value' || row.resolution !== null || row.resolution_audit !== null) throw new Error('Invalid legacy outbox result');
          boundedVisibleActionResult(item.value);
          const identity = JSON.stringify([row.id, row.session_hash, row.task_id, row.source, row.action, row.target]);
          if (fence.verifyLegacyDelivery(Object.freeze({ kind: 'outbox', identity: digest(identity), resultHash: digest(row.result) })) !== true) {
            throw new Error('A legacy outbox result lacks matching trusted delivery evidence');
          }
        } else if (item.outcome === 'unknown') {
          if (Object.keys(item).join(',') !== 'outcome' || !['confirmed-applied', 'confirmed-not-applied'].includes(String(row.resolution)) ||
              typeof row.resolution_audit !== 'string' || !row.resolution_audit.trim() || row.resolution_audit.length > 1024 ||
              fence.verifyLegacyResolution(Object.freeze({ invocationId: row.id as string, sessionHash: row.session_hash,
                taskId: row.task_id as string, source: row.source as string, action: row.action as string, target: row.target as string,
                resolution: String(row.resolution), auditId: row.resolution_audit })) !== true) {
            throw new Error('A legacy unknown result lacks independent recovery evidence');
          }
        } else throw new Error('Invalid legacy outbox result');
      }
    });
  }
}
