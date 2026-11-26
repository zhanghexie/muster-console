import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface PendingDesktopDispatch {
  version: 1;
  id: string;
  appId: string;
  surfaceId: string;
  action: string;
  objectFingerprint?: string;
}

/** Durable pre-dispatch marker; a crash, unreadable file or invalid record must fail closed. */
export class DesktopDispatchJournal {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Desktop journal directory must be absolute');
  }

  private file(taskId: string): string {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid desktop task identity');
    return path.join(this.directory, `${createHash('sha256').update(taskId).digest('hex')}.json`);
  }

  private async refusalFile(taskId: string, scope: string): Promise<string> {
    if (typeof scope !== 'string' || !scope) throw new Error('Invalid desktop refusal scope');
    await this.prepare();
    const directory = path.join(this.directory, 'refusals');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid desktop refusal directory');
    const digest = createHash('sha256').update(JSON.stringify([taskId, scope])).digest('hex');
    return path.join(directory, `${digest}.denied`);
  }

  async hasRefusal(taskId: string, scope: string): Promise<boolean> {
    this.file(taskId);
    const file = await this.refusalFile(taskId, scope);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid desktop refusal record');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async recordRefusal(taskId: string, scope: string): Promise<void> {
    this.file(taskId);
    const file = await this.refusalFile(taskId, scope);
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && await this.hasRefusal(taskId, scope)) return;
      throw error;
    }
    try { await handle.writeFile('denied-v1', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }

  async clearRefusal(taskId: string, scope: string): Promise<void> {
    if (!await this.hasRefusal(taskId, scope)) throw new Error('Desktop refusal record is missing');
    await fs.unlink(await this.refusalFile(taskId, scope));
  }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid desktop journal directory');
  }

  async read(taskId: string): Promise<PendingDesktopDispatch | null> {
    await this.prepare();
    const file = this.file(taskId);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Invalid desktop journal record');
      const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || typeof value !== 'object') throw new Error('Invalid desktop journal record');
      const row = value as Partial<PendingDesktopDispatch>;
      if (row.version !== 1 || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id) ||
          typeof row.appId !== 'string' || !row.appId || typeof row.surfaceId !== 'string' || !row.surfaceId ||
          typeof row.action !== 'string' || !row.action ||
          (row.objectFingerprint !== undefined && (typeof row.objectFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(row.objectFingerprint))) ||
          Object.keys(row).some(key => !['version', 'id', 'appId', 'surfaceId', 'action', 'objectFingerprint'].includes(key))) {
        throw new Error('Invalid desktop journal record');
      }
      return row as PendingDesktopDispatch;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Desktop journal cannot be read; manual recovery required: ${String(error)}`);
    }
  }

  /** A task can have only one unresolved dispatch, even across host processes. */
  async begin(taskId: string, value: Omit<PendingDesktopDispatch, 'version' | 'id'>): Promise<PendingDesktopDispatch> {
    await this.prepare();
    if (!value || typeof value.appId !== 'string' || !value.appId || typeof value.surfaceId !== 'string' || !value.surfaceId ||
        typeof value.action !== 'string' || !value.action || (value.objectFingerprint !== undefined &&
          (typeof value.objectFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(value.objectFingerprint)))) {
      throw new Error('Invalid desktop journal record');
    }
    const row: PendingDesktopDispatch = { version: 1, id: randomUUID(), appId: value.appId, surfaceId: value.surfaceId,
      action: value.action, ...(value.objectFingerprint === undefined ? {} : { objectFingerprint: value.objectFingerprint }) };
    const data = JSON.stringify(row);
    if (Buffer.byteLength(data) > 4096) throw new Error('Desktop journal record too large');
    const handle = await fs.open(this.file(taskId), 'wx', 0o600);
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    return row;
  }

  /** Only an exact matching record may be cleared after a durable audit or reconciliation. */
  async finish(taskId: string, recordId: string): Promise<void> {
    const record = await this.read(taskId);
    if (!record || record.id !== recordId) throw new Error('Desktop journal record changed; manual recovery required');
    await fs.unlink(this.file(taskId));
  }
}
