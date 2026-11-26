import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppImageAsset } from '../../shared/agentApps';
import type { AppSqliteChange } from './sqliteRepository';

type ImageChange = Extract<AppSqliteChange, { type: 'putImageAsset' | 'markImageDeleting' | 'deleteImageAsset' }>;
export interface ImageAssetStore {
  imageAsset(workspaceId: string, appId: string, id: string): AppImageAsset | undefined;
  imageAssets(workspaceId: string, appId: string): AppImageAsset[];
  allImageAssets(workspaceId: string): AppImageAsset[];
  imageReferenceCount(workspaceId: string, id: string): number;
  changeImageAsset(workspaceId: string, change: ImageChange): void;
}

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const assetId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Called only by the phone worker. Source files are copied; originals are never modified. */
export class AppImageAssets {
  private previous = Promise.resolve();
  private readonly readers = new Map<string, { count: number; done: Promise<void>; resolve(): void }>();
  private readonly removals = new Map<string, Promise<boolean>>();
  constructor(private readonly root: string, private readonly store: ImageAssetStore, private readonly now: () => number = Date.now) {}
  private workspaceDir(workspaceId: string): string {
    if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 200) throw new Error('Invalid image workspace');
    return path.join(this.root, digest(workspaceId));
  }
  private dir(workspaceId: string, id: string): string {
    if (!assetId.test(id)) throw new Error('Invalid image asset identity');
    const parent = path.resolve(this.workspaceDir(workspaceId)), result = path.resolve(parent, id);
    if (path.dirname(result) !== parent) throw new Error('Invalid image asset path');
    return result;
  }
  private async writeExclusive(file: string, bytes: Buffer): Promise<void> {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  async importFile(workspaceId: string, appId: string, source: string, assertAuthorized: () => void = () => {}): Promise<AppImageAsset> {
    let release!: () => void;
    const previous = this.previous;
    this.previous = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      assertAuthorized();
      if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Image source must be an absolute file path');
      const handle = await fs.open(source, 'r');
      let input: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new Error('Image must be a file of at most 25 MB');
        input = await handle.readFile();
        if (input.length !== stat.size || input.length > MAX_BYTES) throw new Error('Image changed while being read');
      } finally { await handle.close(); }
      let sharp: typeof import('sharp').default;
      try { sharp = require('sharp') as typeof sharp; }
      catch { throw new Error('图片处理组件不可用，请重新安装当前平台的工作台'); }
      const image = sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS, sequentialRead: true });
      const metadata = await image.metadata();
      const mime = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : undefined;
      if (!mime || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1) throw new Error('Only single-frame JPEG, PNG or WebP images up to 40 megapixels are supported');
      const thumbnail = await image.rotate().resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      assertAuthorized();
      const id = randomUUID(), destination = this.dir(workspaceId, id), temp = `${destination}.tmp-${randomUUID()}`;
      const parent = path.dirname(destination);
      if (path.dirname(path.resolve(temp)) !== parent) throw new Error('Invalid temporary image path');
      const asset: AppImageAsset = { id, appId, name: path.basename(source).slice(0, 255), mime, width: metadata.width, height: metadata.height, bytes: input.length, sha256: digest(input), thumbnailSha256: digest(thumbnail), createdAt: this.now() };
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      let placed = false;
      try {
        await fs.mkdir(temp, { mode: 0o700 });
        await this.writeExclusive(path.join(temp, 'original'), input);
        await this.writeExclusive(path.join(temp, 'thumbnail.png'), thumbnail);
        await fs.rename(temp, destination); placed = true;
        assertAuthorized();
        this.store.changeImageAsset(workspaceId, { type: 'putImageAsset', value: asset });
      } catch (error) {
        try { await fs.rm(placed ? destination : temp, { recursive: true, force: true }); }
        catch { throw new Error('Image import failed and its temporary files could not be removed'); }
        throw error;
      }
      return asset;
    } finally { release(); }
  }
  async read(workspaceId: string, appId: string, id: string, thumbnail = false): Promise<{ mime: string; bytes: Uint8Array }> {
    const directory = this.dir(workspaceId, id), asset = this.store.imageAsset(workspaceId, appId, id);
    if (!asset || asset.deleting) throw new Error('Image asset is unavailable to this app');
    const key = `${workspaceId}:${id}`;
    let active = this.readers.get(key);
    if (!active) { let resolve!: () => void; const done = new Promise<void>(finish => { resolve = finish; }); active = { count: 0, done, resolve }; this.readers.set(key, active); }
    active.count++;
    try {
      const bytes = await fs.readFile(path.join(directory, thumbnail ? 'thumbnail.png' : 'original'));
      if (bytes.length > MAX_BYTES || digest(bytes) !== (thumbnail ? asset.thumbnailSha256 : asset.sha256)) throw new Error('Image asset failed integrity verification');
      return { mime: thumbnail ? 'image/png' : asset.mime, bytes };
    } finally { if (--active.count === 0) { this.readers.delete(key); active.resolve(); } }
  }
  async originalPath(workspaceId: string, appId: string, id: string): Promise<{ path: string; asset: AppImageAsset }> {
    const directory = this.dir(workspaceId, id), asset = this.store.imageAsset(workspaceId, appId, id);
    if (!asset || asset.deleting) throw new Error('Image asset is unavailable to this app');
    const file = path.join(directory, 'original'), stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== asset.bytes) throw new Error('Image asset is missing or invalid');
    return { path: file, asset };
  }
  removeIfUnused(workspaceId: string, appId: string, id: string): Promise<boolean> {
    const key = `${workspaceId}:${id}`, previous = this.removals.get(key);
    if (previous) return previous;
    const work = (async () => {
      const directory = this.dir(workspaceId, id), asset = this.store.imageAsset(workspaceId, appId, id);
      if (!asset || this.store.imageReferenceCount(workspaceId, id)) return false;
      this.store.changeImageAsset(workspaceId, { type: 'markImageDeleting', appId, id });
      await this.readers.get(key)?.done;
      await fs.rm(directory, { recursive: true, force: true });
      this.store.changeImageAsset(workspaceId, { type: 'deleteImageAsset', appId, id });
      return true;
    })().finally(() => this.removals.delete(key));
    this.removals.set(key, work); return work;
  }
  async recover(workspaceId: string): Promise<void> {
    const all = this.store.allImageAssets(workspaceId), known = new Set(all.map(asset => asset.id));
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    for (const asset of all) if (asset.deleting || asset.createdAt < cutoff && !this.store.imageReferenceCount(workspaceId, asset.id)) await this.removeIfUnused(workspaceId, asset.appId, asset.id);
    const parent = path.resolve(this.workspaceDir(workspaceId));
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(parent, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^([0-9a-f-]{36})(?:\.tmp-([0-9a-f-]{36}))?$/i.exec(entry.name);
      if (!match || !assetId.test(match[1]) || match[2] && !assetId.test(match[2]) || !match[2] && known.has(match[1])) continue;
      const candidate = path.resolve(parent, entry.name);
      if (path.dirname(candidate) !== parent) throw new Error('Invalid orphan image path');
      if ((await fs.stat(candidate)).mtimeMs < cutoff) await fs.rm(candidate, { recursive: true, force: true });
    }
  }
}
