import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteFilePath } from '../sqliteFilePath';

/**
 * This is a HOST-OWNED fence, never a model assertion. It must cover every old
 * desktop writer in every process, drain their in-flight calls, and prevent
 * restart throughout inspection AND activation. Activation must install an
 * enduring exclusion of old writers before the fence is released.
 */
export interface LegacyDesktopQuiescence {
  isQuiescent(): boolean;
}

export type LegacyDesktopIssueCode = 'pending_dispatch' | 'pending_receipt' | 'unknown_receipt' | 'legacy_lock' |
  'corrupt_record' | 'unreadable_storage' | 'scan_limit' | 'quiescence_lost';
export interface LegacyDesktopIssue {
  code: LegacyDesktopIssueCode;
  location: 'desktop' | 'dispatch' | 'receipts' | 'locks' | 'receipt-locks';
  /** A one-way filename/request digest, never a model-supplied identity. */
  digest?: string;
  guidance: string;
}
export type LegacyDesktopTransition<T> =
  | { status: 'blocked'; issues: LegacyDesktopIssue[]; totalIssues: number }
  | { status: 'activated'; value: T };

/** Activation may already have had effects; disable new writes and investigate. */
export class LegacyDesktopTransitionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'LegacyDesktopTransitionError'; }
}

const MAX_ENTRIES = 10_000;
const MAX_ISSUES = 32;
const MAX_DB_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 4096;
const MAX_RESULT_BYTES = 65536;
const hashPattern = /^[a-f0-9]{64}$/;
const recovery = 'Keep the original records; independently inspect the old action and audit evidence before enabling desktop writes.';

class QuiescenceLost extends Error {}

function assertQuiescent(fence: LegacyDesktopQuiescence): void {
  try { if (fence.isQuiescent() === true) return; } catch { /* fail closed */ }
  throw new QuiescenceLost();
}

class Findings {
  readonly items: LegacyDesktopIssue[] = [];
  total = 0;
  add(code: LegacyDesktopIssueCode, location: LegacyDesktopIssue['location'], guidance: string, digest?: string): void {
    this.total++;
    if (this.items.length < MAX_ISSUES) this.items.push({ code, location, guidance, ...(digest ? { digest } : {}) });
  }
}

async function optionalStat(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function isPlainFile(info: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return info.isFile() && !info.isSymbolicLink();
}

function validDispatch(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1 && typeof row.id === 'string' && /^[0-9a-f-]{36}$/.test(row.id) &&
    typeof row.appId === 'string' && !!row.appId && typeof row.surfaceId === 'string' && !!row.surfaceId &&
    typeof row.action === 'string' && !!row.action &&
    (row.objectFingerprint === undefined || (typeof row.objectFingerprint === 'string' && /^[a-f0-9]{64}$/i.test(row.objectFingerprint))) &&
    Object.keys(row).every(key => ['version', 'id', 'appId', 'surfaceId', 'action', 'objectFingerprint'].includes(key));
}

async function scanDirectory(root: string, kind: 'dispatch' | 'locks' | 'receipt-locks', findings: Findings,
  fence: LegacyDesktopQuiescence): Promise<void> {
  const directory = path.join(root, kind);
  const info = await optionalStat(directory);
  assertQuiescent(fence);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    findings.add('corrupt_record', kind, 'The legacy directory is not a trusted directory; inspect its path without following links.');
    return;
  }
  const entries = await fs.opendir(directory);
  let count = 0;
  for await (const entry of entries) {
    assertQuiescent(fence);
    if (++count > MAX_ENTRIES) {
      findings.add('scan_limit', kind, 'The directory exceeds the bounded inspection limit; inspect it with a trusted recovery tool.');
      break;
    }
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file);
    assertQuiescent(fence);
    if (kind === 'dispatch' && entry.name === 'refusals') {
      if (!stat.isDirectory() || stat.isSymbolicLink()) findings.add('corrupt_record', kind, 'The refusal directory is invalid; inspect it without following links.');
      continue; // Refusals are not evidence of an unresolved dispatch.
    }
    const match = (kind === 'dispatch' ? /^([a-f0-9]{64})\.json$/ : /^([a-f0-9]{64})\.lock$/).exec(entry.name);
    if (!match || !isPlainFile(stat)) {
      findings.add('corrupt_record', kind, 'An unexpected or linked legacy entry requires independent inspection.');
      continue;
    }
    if (kind !== 'dispatch') {
      findings.add('legacy_lock', kind, 'A legacy lock remains. Establish that every old writer has stopped and inspect the associated operation; PID or age alone is not proof.', match[1]);
      continue;
    }
    if (stat.size > MAX_JOURNAL_BYTES) {
      findings.add('corrupt_record', kind, 'The legacy dispatch marker is oversized; inspect the original without changing it.', match[1]);
      continue;
    }
    let valid = false;
    try { valid = validDispatch(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { /* malformed markers block */ }
    assertQuiescent(fence);
    findings.add(valid ? 'pending_dispatch' : 'corrupt_record', kind,
      valid ? recovery : 'The legacy dispatch marker is invalid; inspect the original without changing it.', match[1]);
  }
}

async function copyStable(file: string, destination: string, before: Awaited<ReturnType<typeof fs.lstat>>,
  fence: LegacyDesktopQuiescence): Promise<void> {
  await fs.copyFile(file, destination);
  const after = await fs.lstat(file);
  assertQuiescent(fence);
  if (!isPlainFile(after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error('Legacy source changed during inspection');
}

async function scanReceipts(root: string, findings: Findings, fence: LegacyDesktopQuiescence): Promise<void> {
  const source = path.join(root, 'action-receipts.sqlite');
  const [main, wal, shm, rollback] = await Promise.all([source, `${source}-wal`, `${source}-shm`, `${source}-journal`].map(optionalStat));
  assertQuiescent(fence);
  if ([main, wal, shm, rollback].some(info => info && !isPlainFile(info))) {
    findings.add('corrupt_record', 'receipts', 'A receipt database or sidecar is not a regular file; inspect it without following links.');
    return;
  }
  if (rollback || (!main && (wal || shm)) || (shm && !wal)) {
    findings.add('corrupt_record', 'receipts', 'An orphaned or rollback database sidecar requires independent SQLite recovery.');
    return;
  }
  if (!main) return;
  if (main.size > MAX_DB_BYTES || (wal && wal.size > MAX_DB_BYTES)) {
    findings.add('scan_limit', 'receipts', 'The receipt database or WAL exceeds the bounded inspection limit; use a trusted recovery tool.');
    return;
  }
  // SQLite may create or update shared-memory sidecars, even for a read-only
  // open. Use a temporary child of the host's private desktop directory so
  // it inherits that directory's access restrictions, and include the WAL.
  // A process crash may leave this copy behind for host recovery/cleanup.
  const temp = await fs.mkdtemp(path.join(root, '.legacy-inspection-'));
  try {
    const copy = path.join(temp, 'action-receipts.sqlite');
    await copyStable(source, copy, main, fence);
    if (wal) await copyStable(`${source}-wal`, `${copy}-wal`, wal, fence);
    assertQuiescent(fence);
    const db = new DatabaseSync(sqliteFilePath(copy), { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON');
      const check = db.prepare('PRAGMA quick_check(1)').get();
      if (!check || Object.values(check)[0] !== 'ok') throw new Error('Invalid receipt database');
      const columns = db.prepare('PRAGMA table_info(desktop_action_receipts)').all().map(row => row.name);
      if (columns.join(',') !== 'request_hash,fingerprint,state,result') throw new Error('Invalid receipt schema');
      const rows = db.prepare('SELECT request_hash, fingerprint, state, result FROM desktop_action_receipts').iterate();
      let count = 0;
      for (const row of rows) {
        assertQuiescent(fence);
        if (++count > MAX_ENTRIES) {
          findings.add('scan_limit', 'receipts', 'The receipt table exceeds the bounded inspection limit; use a trusted recovery tool.');
          break;
        }
        const digest = typeof row.request_hash === 'string' && hashPattern.test(row.request_hash) ? row.request_hash : undefined;
        if (!digest || typeof row.fingerprint !== 'string' || !hashPattern.test(row.fingerprint)) {
          findings.add('corrupt_record', 'receipts', 'The receipt identity or fingerprint is invalid; inspect the original database.', digest);
          continue;
        }
        if (row.state === 'pending' && row.result === null) {
          findings.add('pending_receipt', 'receipts', recovery, digest);
          continue;
        }
        if (row.state !== 'completed' || typeof row.result !== 'string' || Buffer.byteLength(row.result) > MAX_RESULT_BYTES) {
          findings.add('corrupt_record', 'receipts', 'The receipt state or result is invalid; inspect the original database.', digest);
          continue;
        }
        let result: unknown;
        try { result = JSON.parse(row.result); } catch { /* reported below */ }
        if (!result || typeof result !== 'object' || Array.isArray(result) ||
            !['dispatched', 'unknown'].includes(String((result as { outcome?: unknown }).outcome))) {
          findings.add('corrupt_record', 'receipts', 'The completed receipt has an invalid result; inspect the original database.', digest);
        } else if ((result as { outcome: unknown }).outcome === 'unknown') {
          findings.add('unknown_receipt', 'receipts', recovery, digest);
        }
      }
    } finally { db.close(); }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/**
 * root is the host-owned, private desktop storage directory. Scan ALL legacy
 * tasks: neither journal filenames nor receipt hashes can be
 * inverted into a trustworthy old task identity. The fence must be acquired
 * before calling this method and held until activation has permanently excluded
 * legacy writers. No old record is modified and no approval is requested.
 * Unknown receipts cannot be automatically reconciled from these hashes.
 */
export async function transitionFromLegacyDesktop<T>(root: string, fence: LegacyDesktopQuiescence,
  activate: () => Promise<T>): Promise<LegacyDesktopTransition<T>> {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !fence || typeof fence.isQuiescent !== 'function' || typeof activate !== 'function') {
    throw new Error('A host-owned absolute desktop directory, quiescence fence and activation are required');
  }
  const findings = new Findings();
  try {
    assertQuiescent(fence);
    const info = await optionalStat(root);
    assertQuiescent(fence);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      findings.add('corrupt_record', 'desktop', 'The desktop storage path is not a trusted directory; inspect it without following links.');
    } else if (info) {
      for (const kind of ['dispatch', 'locks', 'receipt-locks'] as const) {
        try { await scanDirectory(root, kind, findings, fence); }
        catch (error) {
          if (error instanceof QuiescenceLost) throw error;
          findings.add('unreadable_storage', kind, 'The legacy directory cannot be read consistently; restore access and inspect it before retrying.');
        }
      }
      try { await scanReceipts(root, findings, fence); }
      catch (error) {
        if (error instanceof QuiescenceLost) throw error;
        findings.add('unreadable_storage', 'receipts', 'The receipt database or its inspection copy could not be read or cleaned up; inspect the database and .legacy-inspection-* folders in desktop storage.');
      }
    }
    assertQuiescent(fence);
  } catch (error) {
    if (error instanceof QuiescenceLost) findings.add('quiescence_lost', 'desktop', 'Stop all old executors and hold a host-owned global fence for inspection and the entire transition.');
    else findings.add('unreadable_storage', 'desktop', 'The desktop storage cannot be read consistently; restore access and inspect it before retrying.');
  }
  if (findings.total) return { status: 'blocked', issues: findings.items, totalIssues: findings.total };
  try {
    assertQuiescent(fence);
    const value = await activate();
    assertQuiescent(fence);
    return { status: 'activated', value };
  } catch (error) {
    throw new LegacyDesktopTransitionError('Desktop activation or its quiescence fence failed; disable new writes and inspect the transition outcome.', { cause: error });
  }
}
