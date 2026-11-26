import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Another coordinator already owns the lock; this caller created nothing. */
export class DesktopTaskLockContendedError extends Error {
  constructor() {
    super('Desktop task is locked by another coordinator; inspect unresolved work before retrying');
    this.name = 'DesktopTaskLockContendedError';
  }
}

/** A newly created lock could not be fully cleaned up after initialization failed. */
export class DesktopTaskLockCleanupError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, 'Desktop task lock creation and cleanup failed');
    this.name = 'DesktopTaskLockCleanupError';
  }
}

/** The operation finished or failed, but ownership of its lock could not be released. */
export class DesktopTaskLockReleaseError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, 'Desktop task lock release failed');
    this.name = 'DesktopTaskLockReleaseError';
  }
}

/** Cross-process fail-closed lock; the host must use a private trusted directory. */
export class DesktopTaskLock {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Desktop task lock directory must be absolute');
  }

  private file(taskId: string): string {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid desktop task identity');
    return path.join(this.directory, `${createHash('sha256').update(taskId).digest('hex')}.lock`);
  }

  /** Diagnostic only; PID and timestamp cannot prove that an owner is dead or recovery is safe. */
  async inspect(taskId: string): Promise<{ state: 'unlocked' } | { state: 'locked'; pid: number; createdAt: number } | { state: 'invalid' }> {
    const file = this.file(taskId);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return { state: 'invalid' };
      const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!raw || typeof raw !== 'object') return { state: 'invalid' };
      const record = raw as { version?: unknown; owner?: unknown; pid?: unknown; createdAt?: unknown };
      if (record.version !== 1 || typeof record.owner !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.owner) ||
          !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) return { state: 'invalid' };
      return { state: 'locked', pid: record.pid as number, createdAt: record.createdAt as number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'unlocked' };
      if (error instanceof SyntaxError) return { state: 'invalid' };
      throw error;
    }
  }

  async acquire(taskId: string): Promise<() => Promise<void>> {
    const file = this.file(taskId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid desktop task lock directory');
    const record = JSON.stringify({ version: 1, owner: randomUUID(), pid: process.pid, createdAt: Date.now() });
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DesktopTaskLockContendedError();
      throw error;
    }
    try { await handle.writeFile(record, 'utf8'); await handle.sync(); }
    catch (error) {
      const failures: unknown[] = [];
      try { await handle.close(); } catch (failure) { failures.push(failure); }
      try { await fs.unlink(file); } catch (failure) { failures.push(failure); }
      if (failures.length) throw new DesktopTaskLockCleanupError([error, ...failures]);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      let matches: boolean;
      try {
        const info = await fs.lstat(file);
        matches = info.isFile() && !info.isSymbolicLink() && info.size <= 1024 && await fs.readFile(file, 'utf8') === record;
      } catch (error) {
        try { await handle.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Desktop task lock check and handle close failed'); }
        throw error;
      }
      if (!matches) {
        await handle.close();
        throw new Error('Desktop task lock ownership changed; inspect before continuing');
      }
      await handle.close();
      await fs.unlink(file);
      released = true;
    };
  }

  /** A process crash deliberately leaves a lock: recovery requires the host to establish that all owners stopped. */
  async run<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    if (typeof operation !== 'function') throw new Error('Invalid desktop task operation');
    const release = await this.acquire(taskId);
    let value: T;
    try { value = await operation(); }
    catch (error) {
      try { await release(); } catch (cleanup) { throw new DesktopTaskLockReleaseError([error, cleanup]); }
      throw error;
    }
    try { await release(); } catch (cleanup) { throw new DesktopTaskLockReleaseError([cleanup]); }
    return value;
  }
}
