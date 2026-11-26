import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { ExtensionMediaServer } from './mediaServer';

const MAX_BYTES = 250 * 1024 * 1024;
const NAME = /^[a-zA-Z0-9._-]{1,128}$/;

export interface ExtensionMediaAsset {
  assetId: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

function ownerKey(owner: string): string {
  return createHash('sha256').update(owner, 'utf8').digest('hex');
}

function safeName(value: unknown): string {
  const name = typeof value === 'string' && value.trim() ? path.basename(value.trim()) : 'asset.bin';
  if (!NAME.test(name)) throw new Error('媒体文件名不合法');
  return name;
}

function mimeFor(name: string, requested?: unknown): string {
  if (typeof requested === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(requested)) return requested;
  const ext = path.extname(name).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

/** Host-owned binary asset store. Extensions receive opaque asset IDs and URLs, never storage paths. */
export class ExtensionMediaStore {
  private readonly server = new ExtensionMediaServer();
  private readonly assets = new Map<string, { owner: string; path: string; asset: ExtensionMediaAsset; retained?: boolean }>();
  private readonly revoked = new Set<string>();
  constructor(private readonly userData: string) {}

  private directory(owner: string): string {
    return path.join(userDataStorage(this.userData).resolve('app', 'extension'), 'media', ownerKey(owner));
  }

  async importFile(owner: string, source: string, name?: unknown, requestedMime?: unknown): Promise<ExtensionMediaAsset> {
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('媒体源路径必须是绝对路径');
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('媒体文件不存在或超过 250MB');
    const assetId = randomUUID();
    const fileName = safeName(name ?? path.basename(source));
    const directory = this.directory(owner); await fs.promises.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${assetId}-${fileName}`);
    await fs.promises.copyFile(source, target);
    return this.register(owner, assetId, target, fileName, stat.size, mimeFor(fileName, requestedMime));
  }

  async importBytes(owner: string, bytes: Uint8Array, name?: unknown, requestedMime?: unknown): Promise<ExtensionMediaAsset> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new Error('媒体内容超过 250MB');
    const assetId = randomUUID();
    const fileName = safeName(name);
    const directory = this.directory(owner); await fs.promises.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${assetId}-${fileName}`);
    const temporary = `${target}.tmp-${randomUUID()}`;
    try { await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await fs.promises.rename(temporary, target); }
    finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
    return this.register(owner, assetId, target, fileName, bytes.byteLength, mimeFor(fileName, requestedMime));
  }

  async url(owner: string, assetId: string): Promise<ExtensionMediaAsset> {
    if (this.revoked.has(assetId)) throw new Error('媒体资产不存在或不属于当前扩展实例');
    let entry = this.assets.get(assetId);
    if (!entry && /^[a-f0-9-]{36}$/.test(assetId)) {
      const directory = this.directory(owner);
      try {
        const metadata = path.join(directory, `${assetId}.json`);
        const info = await fs.promises.lstat(metadata);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Invalid media metadata');
        const saved = JSON.parse(await fs.promises.readFile(metadata, 'utf8')) as ExtensionMediaAsset;
        const name = safeName(saved.name), file = path.join(directory, `${assetId}-${name}`);
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid retained media');
        await this.register(owner, assetId, file, name, stat.size, mimeFor(name, saved.mime));
        entry = this.assets.get(assetId)!; entry.retained = true;
      } catch { throw new Error('媒体资产不存在或不属于当前扩展实例'); }
    }
    if (!entry || entry.owner !== owner) throw new Error('媒体资产不存在或不属于当前扩展实例');
    return entry.asset;
  }

  /** Keep an explicitly saved asset across panel disposal and application restart. */
  async retain(owner: string, assetId: string): Promise<ExtensionMediaAsset> {
    const asset = await this.url(owner, assetId);
    const entry = this.assets.get(assetId)!;
    const metadata = path.join(this.directory(owner), `${assetId}.json`);
    const temporary = `${metadata}.tmp-${randomUUID()}`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ name: asset.name, mime: asset.mime }), { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporary, metadata); entry.retained = true;
    } finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
    return asset;
  }

  async copyTo(owner: string, assetId: string, target: string): Promise<void> {
    await this.url(owner, assetId);
    const entry = this.assets.get(assetId);
    if (!entry || entry.owner !== owner) throw new Error('媒体资产不存在或不属于当前扩展实例');
    const stat = await fs.promises.stat(entry.path);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('媒体资产不可导出');
    await fs.promises.copyFile(entry.path, target);
  }

  async readBytes(owner: string, assetId: string): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
    await this.url(owner, assetId);
    const entry = this.assets.get(assetId);
    if (!entry || entry.owner !== owner) throw new Error('媒体资产不存在或不属于当前扩展实例');
    const stat = await fs.promises.stat(entry.path);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('媒体资产不可读取');
    return { bytes: await fs.promises.readFile(entry.path), name: entry.asset.name, mime: entry.asset.mime };
  }

  async release(owner: string, assetId?: string): Promise<void> {
    if (assetId) {
      const held = this.assets.get(assetId);
      if (held && held.owner !== owner) throw new Error('媒体资产不存在或不属于当前扩展实例');
      if (!held && !this.revoked.has(assetId)) await this.url(owner, assetId);
    }
    const removals: Promise<void>[] = [];
    for (const [id, entry] of this.assets) {
      if (entry.owner !== owner || (assetId && id !== assetId)) continue;
      this.server.releaseAsset(owner, entry.asset.url);
      if (assetId || !entry.retained) {
        this.revoked.add(id);
        removals.push(fs.promises.rm(entry.path, { force: true }));
        removals.push(fs.promises.rm(path.join(this.directory(owner), `${id}.json`), { force: true }));
      }
      this.assets.delete(id);
    }
    if (!assetId) this.server.release(owner);
    await Promise.all(removals);
  }

  stop(): void { this.assets.clear(); this.server.stop(); }

  private async register(owner: string, assetId: string, file: string, name: string, size: number, mime: string): Promise<ExtensionMediaAsset> {
    const url = await this.server.register(owner, file, mime);
    const asset = { assetId, name, mime, size, url };
    this.assets.set(assetId, { owner, path: file, asset });
    return asset;
  }
}
