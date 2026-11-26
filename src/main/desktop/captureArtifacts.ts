import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

interface CaptureMetadata {
  version: 1; id: string; taskHash: string; sha256: string;
  capturedAt: number; expiresAt: number; width: number; height: number;
}
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const digest = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Host-owned capture paths. Callers must still enforce authorization before capturing. */
export class DesktopCaptureArtifacts {
  constructor(private readonly directory: string, private readonly decode: (png: Buffer) => Promise<{ width: number; height: number }>, private readonly now: () => number = Date.now) {
    if (!path.isAbsolute(directory)) throw new Error('Capture directory must be absolute');
    if (typeof decode !== 'function') throw new Error('Capture decoder is required');
  }
  private async prepare(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid capture directory');
  }
  private file(id: string, suffix: 'png' | 'json'): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid capture artifact identity');
    return path.join(this.directory, `${id}.${suffix}`);
  }
  private pngInfo(data: Buffer): { width: number; height: number } {
    if (!Buffer.isBuffer(data) || data.length < 45 || data.length > 20 * 1024 * 1024 ||
        !data.subarray(0, 8).equals(PNG) || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.toString('ascii', data.length - 8, data.length - 4) !== 'IEND') throw new Error('Invalid PNG capture');
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (!width || !height || width > 32768 || height > 32768 || width * height > 40_000_000) throw new Error('Invalid capture dimensions');
    return { width, height };
  }
  async create(taskId: string, png: Buffer, ttlMs: number, id: string = randomUUID()): Promise<{ artifactId: string; path: string; mimeType: 'image/png'; width: number; height: number; capturedAt: number; expiresAt: number }> {
    if (typeof taskId !== 'string' || !taskId.trim() || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw new Error('Invalid capture scope or lifetime');
    if (!ID.test(id)) throw new Error('Invalid capture artifact identity');
    const { width, height } = this.pngInfo(png), copy = Buffer.from(png), capturedAt = this.now();
    if (!Number.isSafeInteger(capturedAt) || !Number.isSafeInteger(capturedAt + ttlMs)) throw new Error('Invalid capture time');
    const decoded = await this.decode(Buffer.from(copy));
    if (!decoded || decoded.width !== width || decoded.height !== height) throw new Error('Decoded capture dimensions do not match');
    const afterDecode = this.now();
    if (!Number.isSafeInteger(afterDecode) || afterDecode >= capturedAt + ttlMs) throw new Error('Capture expired before it was ready');
    const row: CaptureMetadata = { version: 1, id, taskHash: digest(taskId), sha256: digest(copy), capturedAt, expiresAt: capturedAt + ttlMs, width, height };
    await this.prepare();
    const image = this.file(id, 'png'), metadata = this.file(id, 'json');
    let imageCreated = false, metadataCreated = false;
    try {
      // Metadata first: after an ordinary process crash cleanup can reclaim a missing or complete image.
      const metaHandle = await fs.open(metadata, 'wx', 0o600); metadataCreated = true;
      try { await metaHandle.writeFile(JSON.stringify(row), 'utf8'); await metaHandle.sync(); }
      finally { await metaHandle.close(); }
      const imageHandle = await fs.open(image, 'wx', 0o600); imageCreated = true;
      try { await imageHandle.writeFile(copy); await imageHandle.sync(); }
      finally { await imageHandle.close(); }
      const afterWrite = this.now();
      if (!Number.isSafeInteger(afterWrite) || afterWrite >= row.expiresAt) throw new Error('Capture expired before it was ready');
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const file of [imageCreated ? image : null, metadataCreated ? metadata : null]) {
        if (!file) continue;
        try { await fs.unlink(file); } catch (failure) { cleanupErrors.push(failure); }
      }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'Capture creation and cleanup failed');
      throw error;
    }
    return { artifactId: id, path: image, mimeType: 'image/png', width, height, capturedAt, expiresAt: row.expiresAt };
  }
  private async metadata(id: string): Promise<CaptureMetadata> {
    await this.prepare();
    const file = this.file(id, 'json'), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) throw new Error('Invalid capture metadata');
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('Invalid capture metadata');
    const row = value as Partial<CaptureMetadata>;
    if (row.version !== 1 || row.id !== id || typeof row.taskHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.taskHash) ||
        typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256) ||
        !Number.isSafeInteger(row.capturedAt) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt! <= row.capturedAt! || row.expiresAt! - row.capturedAt! > MAX_TTL_MS ||
        !Number.isSafeInteger(row.width) || !Number.isSafeInteger(row.height)) throw new Error('Invalid capture metadata');
    return row as CaptureMetadata;
  }
  /** Host-only lookup; task identity must still be resolved against the session's trusted history. */
  async ownerHash(artifactId: string): Promise<string> {
    const row = await this.metadata(artifactId), now = this.now();
    if (!Number.isSafeInteger(now) || row.expiresAt <= now) throw new Error('Capture unavailable or expired');
    return row.taskHash;
  }
  async get(taskId: string, artifactId: string): Promise<{ path: string; mimeType: 'image/png'; width: number; height: number; capturedAt: number; expiresAt: number }> {
    const { data: _data, ...metadata } = await this.readBytes(taskId, artifactId);
    return metadata;
  }
  /** Return the bytes that were actually checked, rather than reopening a path after validation. */
  async readBytes(taskId: string, artifactId: string): Promise<{ path: string; mimeType: 'image/png'; width: number; height: number; capturedAt: number; expiresAt: number; data: Buffer }> {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid capture scope');
    const row = await this.metadata(artifactId);
    const now = this.now();
    if (!Number.isSafeInteger(now)) throw new Error('Invalid capture time');
    if (row.taskHash !== digest(taskId) || row.expiresAt <= now) throw new Error('Capture unavailable or expired');
    const file = this.file(artifactId, 'png'), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) throw new Error('Invalid capture artifact');
    const data = await fs.readFile(file), actual = this.pngInfo(data);
    if (digest(data) !== row.sha256 || actual.width !== row.width || actual.height !== row.height) throw new Error('Capture artifact changed');
    const afterRead = this.now();
    if (!Number.isSafeInteger(afterRead) || row.expiresAt <= afterRead) throw new Error('Capture unavailable or expired');
    return { path: file, mimeType: 'image/png', width: row.width, height: row.height, capturedAt: row.capturedAt, expiresAt: row.expiresAt, data };
  }
  /** Explicitly retract an unpublished artifact after cancellation or stale geometry. */
  async remove(taskId: string, artifactId: string): Promise<void> {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid capture scope');
    const row = await this.metadata(artifactId);
    if (row.taskHash !== digest(taskId)) throw new Error('Capture unavailable or outside task scope');
    const image = this.file(artifactId, 'png'), info = await fs.lstat(image);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid capture artifact');
    await fs.unlink(image);
    await fs.unlink(this.file(artifactId, 'json'));
  }
  /** Reclaim corrupt or missing metadata only after the longest allowed lifetime. */
  private async reclaimDamaged(id: string, now: number, hasMetadata: boolean): Promise<boolean> {
    const image = this.file(id, 'png'), metadata = this.file(id, 'json');
    const stat = async (file: string): Promise<import('node:fs').Stats | undefined> => {
      try {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid capture artifact');
        return info;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const metaInfo = await stat(metadata), imageInfo = await stat(image);
    if (hasMetadata !== !!metaInfo) return false;
    if (!metaInfo && !imageInfo) return false;
    const newest = Math.max(metaInfo?.mtimeMs ?? 0, imageInfo?.mtimeMs ?? 0);
    if (!Number.isFinite(newest) || now - newest < MAX_TTL_MS) return false;
    if (!hasMetadata && await stat(metadata)) return false;
    if (imageInfo) await fs.unlink(image);
    if (metaInfo) await fs.unlink(metadata);
    return true;
  }
  /** Remove expired artifacts and report corrupt records or cleanup failures. */
  async cleanupExpired(): Promise<{ removed: number; errors: string[] }> {
    await this.prepare();
    const now = this.now();
    if (!Number.isSafeInteger(now)) throw new Error('Invalid capture time');
    const names = await fs.readdir(this.directory), nameSet = new Set(names), errors: string[] = [];
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      const id = name.slice(0, -5);
      try {
        const row = await this.metadata(id);
        if (row.expiresAt > now) continue;
        const image = this.file(id, 'png');
        try {
          const info = await fs.lstat(image);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid capture artifact');
          await fs.unlink(image);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await fs.unlink(this.file(id, 'json')); removed++;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof SyntaxError || detail === 'Invalid capture metadata') {
          try {
            if (await this.reclaimDamaged(id, now, true)) { removed++; errors.push(`${id}: invalid metadata; aged capture removed`); continue; }
          } catch (failure) { errors.push(`${id}: ${detail}; cleanup failed: ${String(failure)}`); continue; }
        }
        errors.push(`${id}: ${detail}`);
      }
    }
    for (const name of names) {
      if (!name.endsWith('.png') || !ID.test(name.slice(0, -4)) || nameSet.has(`${name.slice(0, -4)}.json`)) continue;
      const id = name.slice(0, -4);
      try {
        if (await this.reclaimDamaged(id, now, false)) { removed++; errors.push(`${id}: missing metadata; aged capture removed`); }
        else {
          const meta = await fs.lstat(this.file(id, 'json')).then(() => true, (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false; throw error;
          });
          if (!meta) errors.push(`${id}: missing metadata; capture awaits age limit`);
        }
      }
      catch (error) { errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { removed, errors };
  }
}
