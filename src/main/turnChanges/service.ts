import fs from 'node:fs';
import path from 'node:path';
import type { TurnChangedFile, TurnChanges, TurnRevertResult } from '../../shared/turnChanges';
import { isTurnFileCollision, TURN_DIFF_OMITTED, TURN_FILE_COLLISION_PRESERVED } from '../../shared/turnChanges';
import { pathKey } from '../../shared/pathKey';
import { checkedPath, readImage, hash, inside, stamp, physicalFile } from './files';
import type { Image, Root } from './files';
import { TurnChangeTracker } from './tracker';
export { TurnChangeTracker } from './tracker';
import { writeRecord } from './storage';

/** End-of-turn content is only compared, never restored: a hash plus fingerprint suffices. */
type FileRef = { hash: string; stamp: string };
/** `before` (the restore body) is kept only for revertible files; review reads `diff`. */
type SavedFile = { view: TurnChangedFile; abs: string; before?: Image | null; beforeHash: string | null; after: FileRef | null; diff: string };
/** Records written before slimming carried full after/before images. */
type LegacyFile = Omit<SavedFile, 'after' | 'beforeHash'> & { beforeHash?: string | null; after: (Partial<FileRef> & { text?: string; stamp: string }) | null };
function normalizeFile(file: LegacyFile): SavedFile {
  const after = file.after ? { hash: file.after.hash ?? hash(file.after.text ?? ''), stamp: file.after.stamp } : null;
  const beforeHash = file.beforeHash !== undefined ? file.beforeHash : file.before ? hash(file.before.text) : null;
  return { ...file, after, beforeHash };
}
type RecordData = { owner: string; messageId: string; roots: Root[]; summary: TurnChanges; files: SavedFile[] };
export interface TurnFileCollision {
  file: string;
  participants: readonly [TurnChangeTracker, TurnChangeTracker];
}
const NO_RECORD = '该轮没有文件改动快照';

export class TurnChangeService {
  readonly active = new Set<TurnChangeTracker>();
  private collisionHandler?: (collision: TurnFileCollision) => void;
  private reverting = new Set<string>();
  private retentionCallback?: (owner: string, reference?: { id: string; messageId: string }) => void;
  constructor(private dir: string) {}
  dispose(): void {}
  setRetentionCallback(callback: (owner: string, reference?: { id: string; messageId: string }) => void): void { this.retentionCallback = callback; }
  requestRetention(owner: string, reference?: { id: string; messageId: string }): void {
    try { this.retentionCallback?.(owner, reference); }
    catch (error) { console.warn('[turn-changes] 无法安排快照清理', owner, error); }
  }
  isSnapshotBusy(id: string): boolean { return this.reverting.has(id) || [...this.active].some(tracker => tracker.summary.id === id); }
  setCollisionHandler(handler: (collision: TurnFileCollision) => void): void { this.collisionHandler = handler; }
  reportCollision(collision: TurnFileCollision): void {
    try { this.collisionHandler?.(collision); }
    catch (error) { console.error('[turn-changes] collision recording failed', error); }
  }
  activeForOwner(owner: string): TurnChangeTracker | undefined {
    const matches = [...this.active].filter(tracker => tracker.owner === owner && !tracker.finished);
    return matches.length === 1 ? matches[0] : undefined;
  }
  /** Register before engine execution, without traversing or reading the workspace. */
  begin(owner: string, messageId: string, cwd: string, directories: readonly string[], rootDirs?: ReadonlyMap<string, string>): TurnChangeTracker {
    const roots: Root[] = [], failures: string[] = [];
    for (const dir of new Set(directories)) {
      try { roots.push({ path: path.resolve(dir), physical: fs.realpathSync.native(dir) }); }
      catch (error) { failures.push(`源目录不可用 ${dir}（${String(error)}）`); }
    }
    const tracker = new TurnChangeTracker(this, owner, messageId, cwd, roots, rootDirs);
    this.active.add(tracker);
    if (failures.length) tracker.noteRootFailure(failures.join('；'));
    return tracker;
  }
  save(record: RecordData): Promise<void> {
    return writeRecord(path.join(this.dir, `${record.summary.id}.json`), record);
  }
  private load(id: string, owner: string, messageId: string): RecordData {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的快照');
    let raw: string;
    try { raw = fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(NO_RECORD);
      throw error;
    }
    const record = JSON.parse(raw) as Omit<RecordData, 'files'> & { files: LegacyFile[] };
    if (record.owner !== owner || record.messageId !== messageId || record.summary.id !== id) throw new Error('快照不属于该回合');
    return { ...record, files: record.files.map(normalizeFile) };
  }
  diff(id: string, owner: string, messageId: string, file: string): string {
    const record = this.load(id, owner, messageId);
    const hit = record.files.find(f => f.view.path === file);
    if (!hit) throw new Error('文件不属于该回合');
    if (hit.view.diffOmitted) throw new Error(TURN_DIFF_OMITTED);
    return hit.diff;
  }
  /** Historical memory reads are bound to the original snapshot and current authorized roots. */
  evidence(id:string,owner:string,messageId:string,allowedRoots:readonly string[],repo:string,branch:string,file?:string):import('../../shared/knowledge').KnowledgeEvidenceView {
    const record=this.load(id,owner,messageId),scope=record.summary.repository;
    if(!scope?.scopeStable||!scope.branch||pathKey(scope.root)!==pathKey(repo)||scope.branch!==branch) throw new Error('证据仓库或分支范围未知、变化或不匹配');
    const roots=allowedRoots.map(root=>fs.realpathSync.native(root));
    const permitted=record.files.filter(f=>{
      // Provider patches do not carry a verified complete before/after image.
      if(f.view.origin==='provider-diff'||f.view.diffOmitted)return false;
      const physical=physicalFile(record.roots,f.abs);
      return !!physical&&roots.some(root=>inside(root,physical));
    });
    if(file!==undefined){
      const hit=permitted.find(f=>f.view.path===file);if(!hit) throw new Error('文件不在当前授权范围或不属于此轮');
      return {status:'available',diff:hit.diff};
    }
    return {status:'available',files:permitted.map(f=>({path:f.view.path,beforeHash:f.beforeHash,afterHash:f.after?.hash??null}))};
  }
  revert(id: string, owner: string, messageId: string, allowedRoots: readonly string[], canWrite?: (file: string) => boolean): Promise<TurnRevertResult> {
    let record: RecordData;
    try { record = this.load(id, owner, messageId); }
    catch (error) {
      if ((error as Error).message === NO_RECORD) return Promise.resolve({ ok: false, restored: [], conflicts: [], error: NO_RECORD });
      throw error;
    }
    if (this.reverting.has(id)) return Promise.resolve({ ok: false, restored: [], conflicts: [], error: '正在保存本轮回退结果，请稍后重试' });
    this.reverting.add(id);
    return this.restore(record, allowedRoots, canWrite).finally(() => { this.reverting.delete(id); this.requestRetention(owner, { id, messageId }); });
  }
  /** File checks + mutations are synchronous; only metadata persistence may yield. */
  private async restore(record: RecordData, allowedRoots: readonly string[], canWrite?: (file: string) => boolean): Promise<TurnRevertResult> {
    const result: TurnRevertResult = { ok: true, summary: record.summary, restored: [], conflicts: [] };
    for (const file of record.files) {
      if (file.view.reverted) continue;
      if (isTurnFileCollision(record.summary, file.view)) {
        const peers = record.summary.concurrentEdits?.filter(edit => edit.path === file.view.path) ?? [];
        const names = [...new Set(peers.map(edit => edit.otherLabel || edit.otherOwner))];
        const reason = names.length ? `${TURN_FILE_COLLISION_PRESERVED}：${names.join('、')}` : TURN_FILE_COLLISION_PRESERVED;
        result.conflicts.push({ path: file.view.path, reason });
        continue;
      }
      if (file.view.diffOmitted) { result.conflicts.push({ path: file.view.path, reason: TURN_DIFF_OMITTED }); continue; }
      let reason = file.view.reason;
      if ((canWrite && !canWrite(file.abs)) || !allowedRoots.some(r => inside(path.resolve(r), file.abs))) reason = '文件已不在当前可写范围';
      const physical = physicalFile(record.roots, file.abs);
      if (physical && [...this.active].some(t => t.roots.some(r => inside(r.physical, physical)))) reason = '有会话正在使用该目录，请等回合结束后重试';
      const live = readImage(record.roots, file.abs);
      if (live === undefined || (live ? hash(live.text) : null) !== (file.after?.hash ?? null) || live?.stamp !== file.after?.stamp) reason = '文件在本轮后已变化，已保留当前内容';
      if (!file.view.revertible || file.before === undefined || reason) { result.conflicts.push({ path: file.view.path, reason: reason ?? '无法确认改动归属' }); continue; }
      try {
        if (!checkedPath(record.roots, file.abs)) throw new Error('文件路径或源目录已变化');
        if (!file.before) fs.unlinkSync(file.abs);
        else if (!file.after) {
          // Never overwrite a concurrently recreated file or create missing directories.
          fs.writeFileSync(file.abs, file.before.text, { flag: 'wx', mode: file.before.mode });
        } else {
          const fd = fs.openSync(file.abs, 'r+');
          try {
            if (stamp(fs.fstatSync(fd)) !== file.after.stamp || hash(fs.readFileSync(fd, 'utf8')) !== file.after.hash) throw new Error('文件已变化');
            fs.writeSync(fd, Buffer.from(file.before.text), 0, Buffer.byteLength(file.before.text), 0);
            fs.ftruncateSync(fd, Buffer.byteLength(file.before.text));
          } finally { fs.closeSync(fd); }
        }
        file.view.reverted = true;
        file.view.revertible = false;
        result.restored.push(file.view.path);
      } catch (e) { result.conflicts.push({ path: file.view.path, reason: (e as Error).message }); }
    }
    record.summary.files = record.files.map(f => ({ ...f.view }));
    result.ok = result.conflicts.length === 0;
    // Persist before returning; if saving fails, repeated rollback still checks real contents.
    try { await this.save(record); }
    catch (error) { result.ok = false; result.error = `文件回退结果已列出，快照状态保存失败：${(error as Error).message}`; }
    return result;
  }
}
