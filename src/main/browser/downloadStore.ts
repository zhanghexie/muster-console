import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomicSync } from '../atomicJson';
import { pathKey } from '../pathKey';
import { t } from '../../shared/i18n';

type DownloadState = 'completed' | 'cancelled' | 'interrupted';
type Receipt = { version: 1; id: string; name: string; state: DownloadState; identity: string };
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// ctime changes on rename; retain the file identity and content metadata that do not.
const identity = (stat: fs.Stats) => {
  if (!stat.ino) throw new Error('File identity unavailable');
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(':');
};

/** Download paths are unique per item; receipts persist only after the native download ends. */
export class BrowserDownloadStore {
  private active = new Map<string, string>();
  private readonly root: string;
  private readonly receipts: string;
  constructor(userData: string) {
    this.root = userDataStorage(userData).resolve('app', 'browser-downloads');
    this.receipts = userDataStorage(userData).resolve('app', 'browser-download-receipts');
  }

  begin(filename: string): { id: string; file: string } {
    fs.mkdirSync(this.root, { recursive: true });
    this.assertDirectory(this.root);
    const id = randomUUID();
    const base = path.basename(filename).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/[. ]+$/g, '');
    let safe = '';
    for (const character of base) {
      if (Buffer.byteLength(safe + character, 'utf8') > 180) break;
      safe += character;
    }
    safe = safe.replace(/[. ]+$/g, '') || 'download';
    const file = path.join(this.root, `${id}-${safe}`);
    this.active.set(id, file);
    return { id, file };
  }

  abandon(id: string): void { this.active.delete(id); }

  finish(id: string, state: DownloadState): void {
    const file = this.active.get(id);
    if (!file) throw new Error(t('下载记录不可用。'));
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(t('下载文件不可用。'));
      const receipt: Receipt = { version: 1, id, name: path.basename(file), state, identity: identity(stat) };
      fs.mkdirSync(this.receipts, { recursive: true });
      this.assertDirectory(this.receipts);
      writeJsonAtomicSync(path.join(this.receipts, `${id}.json`), receipt);
    } finally { this.active.delete(id); }
  }

  status(file: string): 'active' | 'verified' | 'unknown' {
    if ([...this.active.values()].some(active => pathKey(active) === pathKey(file))) return 'active';
    try {
      const receipt = this.readReceipt(file), stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && receipt.identity === identity(stat) ? 'verified' : 'unknown';
    } catch { return 'unknown'; }
  }

  /** Isolate first, then verify the moved object before deleting it. */
  remove(file: string, expectedStat: string, hooks?: { beforeRename?: () => void; afterRename?: () => void }): void {
    if (this.status(file) !== 'verified') throw new Error(t('下载状态或凭据已变化，请重新扫描。'));
    this.assertDirectory(this.root);
    const receipt = this.readReceipt(file);
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || identity(current) !== expectedStat || receipt.identity !== expectedStat) throw new Error(t('存储项目已变化，请重新扫描。'));
    const quarantine = fs.mkdtempSync(path.join(this.root, '.cleanup-'));
    const moved = path.join(quarantine, 'item');
    let isolated = false;
    try {
      hooks?.beforeRename?.();
      fs.renameSync(file, moved);
      isolated = true;
      hooks?.afterRename?.();
      const stat = fs.lstatSync(moved);
      if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== expectedStat) {
        // Never overwrite a file that appeared at the original path.
        fs.linkSync(moved, file); fs.unlinkSync(moved); isolated = false;
        throw new Error(t('存储项目已变化，请重新扫描。'));
      }
      fs.unlinkSync(moved);
      isolated = false;
      try { fs.unlinkSync(path.join(this.receipts, `${receipt.id}.json`)); }
      catch (error) { throw new Error(t('下载文件已删除，但记录清理失败：{{error}}', { error: (error as Error)?.message || String(error) })); }
    } catch (error) {
      if (isolated) throw new Error(t('下载清理未完成，请检查隔离位置 {{path}}：{{error}}', { path: moved, error: (error as Error)?.message || String(error) }));
      throw error;
    } finally {
      if (!isolated) fs.rmdirSync(quarantine);
    }
  }

  snapshotIdentity(file: string): string { return identity(fs.lstatSync(file)); }

  private assertDirectory(dir: string): void {
    const stat = fs.lstatSync(dir);
    const expected = path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
    if (!stat.isDirectory() || stat.isSymbolicLink() || pathKey(fs.realpathSync(dir)) !== pathKey(expected)) throw new Error(t('存储目录已变化或被重定向，请重新扫描。'));
  }

  private readReceipt(file: string): Receipt {
    if (pathKey(path.dirname(file)) !== pathKey(this.root)) throw new Error('outside download root');
    const name = path.basename(file), id = name.slice(0, 36);
    if (!idPattern.test(id) || name[36] !== '-') throw new Error('unknown download');
    this.assertDirectory(this.receipts);
    const recordPath = path.join(this.receipts, `${id}.json`), stat = fs.lstatSync(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('invalid receipt');
    const record: unknown = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (!record || typeof record !== 'object') throw new Error('invalid receipt');
    const value = record as Partial<Receipt>;
    if (value.version !== 1 || value.id !== id || value.name !== name || typeof value.identity !== 'string' || !['completed', 'cancelled', 'interrupted'].includes(value.state ?? '')) throw new Error('invalid receipt');
    return value as Receipt;
  }
}
