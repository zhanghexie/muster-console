import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './context';
import { SKIP_DIR_NAMES } from './workspaceSkipDirs';
import type { FsChangedPayload } from '../shared/types';
import { sourceRootsFor, requireSourceRoot } from '../shared/workspaceRoots';
import { requireWorkspace, resolveRealPathInsideRoot } from './workspacePaths';
import { pathKey } from './pathKey';
import { WatcherLifetime } from './watcherLifetime';

const DEBOUNCE_MS = 200;
const PENDING_MAX = 1000;

/** 事件风暴先按整段 skip 名称零分配过滤，再归一化、分发与入队。 */
function hasSkipSegment(filename: string): boolean {
  let start = 0;
  for (let i = 0; i <= filename.length; i++) {
    const code = i === filename.length ? 47 : filename.charCodeAt(i);
    if (code === 47 || code === 92) {
      if (i > start && SKIP_DIR_NAMES.has(filename.substring(start, i))) return true;
      start = i + 1;
    }
  }
  return false;
}

function relativeInside(root: string, target: string): string | undefined {
  const rel = path.relative(root, target).replace(/\\/g, '/');
  return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? undefined : rel;
}

/** 父 watcher 会跳过某些子目录；显式登记这些目录时仍需自己的句柄。 */
function covers(parent: string, child: string): boolean {
  const rel = relativeInside(parent, child);
  return rel !== undefined && !hasSkipSegment(rel);
}

type Binding = { key: string; workspaceId: string; rootId: string; root: string; physical: string; inode: string; revision: number };
type Scope = { key: string; root: string; inode: string; watcher: fs.FSWatcher | null; error?: string };
type Pending = { binding: Binding; paths: Set<string> };

/** 物理范围共享句柄；逻辑根各自有队列、版本、错误与相对路径。 */
export class WorkspaceFsWatcher {
  private watchers = new Map<string, Scope>();
  private bindings = new Map<string, Binding>();
  /** Physical-root prefix index used to route an event only to containing logical roots. */
  private bindingsByPhysical = new Map<string, Binding[]>();
  private bindingErrors = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = new Set<string>();
  private closing = false;
  private readonly lifetime = new WatcherLifetime();
  private readonly active = new Set<Promise<void>>();
  /** 先投递自动化，再向窗口发事件；旧单根回调可忽略第三个参数。 */
  onChanged: ((workspaceId: string, relativePaths: string[], rootId: string) => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  syncFromConfig(): void {
    if (this.closing) throw new Error('Workspace file watcher is stopping');
    this.stopped.clear();
    this.reconcile();
  }

  ensure(workspaceId: string): void {
    if (this.closing) throw new Error('Workspace file watcher is stopping');
    this.stopped.delete(workspaceId);
    this.reconcile();
  }

  /** 手动刷新树时重试失效/离线句柄；未知身份不回落到其他源根。 */
  refreshRoot(workspaceId: string, rootId: string): string | undefined {
    requireSourceRoot(requireWorkspace(this.ctx.config.get(), workspaceId), rootId);
    this.ensure(workspaceId);
    return this.errorForRoot(workspaceId, rootId);
  }

  errorForRoot(workspaceId: string, rootId: string): string | undefined {
    const binding = this.bindings.get(JSON.stringify([workspaceId, rootId]));
    if (!binding) return 'source folder not found';
    return this.bindingErrors.get(binding.key) ?? [...this.watchers.values()].find(s => covers(s.root, binding.physical))?.error;
  }

  stop(workspaceId: string): void {
    this.stopped.add(workspaceId);
    this.reconcile();
  }

  stopAll(): void {
    for (const scope of this.watchers.values()) this.close(scope);
    this.watchers.clear();
    for (const key of this.pending.keys()) this.cancelPending(key);
    this.bindings.clear();
    this.bindingsByPhysical.clear();
    this.bindingErrors.clear();
    this.stopped = new Set(this.ctx.config.get().workspaces.map(w => w.id));
  }

  stopAdmission(): void { this.closing = true; this.stopAll(); }
  async shutdown(): Promise<void> {
    this.stopAdmission();
    const results = await Promise.allSettled([this.lifetime.shutdown(), ...this.active]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Workspace file watcher shutdown failed');
  }

  private reconcile(): void {
    if (this.closing) return;
    const next = new Map<string, Binding>();
    const errors = new Map<string, string>();
    for (const workspace of this.ctx.config.get().workspaces) {
      if (this.stopped.has(workspace.id)) continue;
      let roots;
      try { roots = sourceRootsFor(workspace); }
      catch (err) { console.error('[fs.watch] invalid workspace', workspace.id, err); continue; }
      for (const root of roots) {
        let physical = path.resolve(root.path);
        let inode = '';
        const key = JSON.stringify([workspace.id, root.id]);
        try {
          physical = fs.realpathSync.native(physical);
          const stat = fs.statSync(physical, { bigint: true });
          if (!stat.isDirectory()) throw new Error('source folder is not a directory');
          inode = `${stat.dev}:${stat.ino}`;
        } catch (err) { errors.set(key, err instanceof Error ? err.message : String(err)); }
        const old = this.bindings.get(key);
        const revision = workspace.rootsRevision ?? 0;
        next.set(key, old && old.root === root.path && old.physical === physical && old.inode === inode && old.revision === revision
          ? old : { key, workspaceId: workspace.id, rootId: root.id, root: root.path, physical, inode, revision });
      }
    }
    for (const [key, value] of this.bindings) if (next.get(key) !== value) this.cancelPending(key);
    this.bindings = next;
    this.bindingsByPhysical = new Map<string, Binding[]>();
    for (const binding of next.values()) {
      const physicalKey = pathKey(binding.physical);
      const bucket = this.bindingsByPhysical.get(physicalKey);
      if (bucket) bucket.push(binding);
      else this.bindingsByPhysical.set(physicalKey, [binding]);
    }
    for (const [key, error] of errors) {
      if (this.bindingErrors.get(key) === error) continue;
      const binding = next.get(key)!;
      console.error('[fs.watch] source folder unavailable', binding.root, error);
      this.send({ workspaceId: binding.workspaceId, rootId: binding.rootId,
        rootsRevision: binding.revision, relativePaths: [], error });
    }
    this.bindingErrors = errors;

    const roots = [...new Map([...next.values()].map(b => [pathKey(b.physical), b.physical])).values()]
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    const ranges: string[] = [];
    for (const root of roots) if (!ranges.some(parent => covers(parent, root))) ranges.push(root);
    const wanted = new Set(ranges.map(pathKey));
    for (const [key, scope] of this.watchers) {
      if (wanted.has(key)) continue;
      this.watchers.delete(key);
      this.close(scope);
    }
    for (const root of ranges) {
      const key = pathKey(root);
      const old = this.watchers.get(key);
      const inode = [...next.values()].find(b => pathKey(b.physical) === key)!.inode;
      if (old?.watcher && old.inode === inode) continue;
      if (old) this.close(old);
      const scope: Scope = { key, root, inode, watcher: null };
      this.watchers.set(key, scope);
      try {
        if (!fs.statSync(root).isDirectory()) throw new Error('source folder is not a directory');
        scope.watcher = this.lifetime.own(fs.watch(root, { recursive: true }, (_eventType, filename) => this.receive(scope, filename)));
        scope.watcher.on('error', (err) => {
          if (this.watchers.get(key) !== scope) return;
          this.close(scope);
          this.reportError(scope, err);
        });
      } catch (err) { this.reportError(scope, err); }
    }
  }

  private close(scope: Scope): void {
    this.lifetime.retire(scope.watcher);
    scope.watcher = null;
  }

  private reportError(scope: Scope, err: unknown): void {
    scope.error = err instanceof Error ? err.message : String(err);
    console.error('[fs.watch]', scope.root, err);
    for (const binding of this.bindings.values()) {
      if (covers(scope.root, binding.physical)) this.send({ workspaceId: binding.workspaceId,
        rootId: binding.rootId, rootsRevision: binding.revision, relativePaths: [], error: scope.error });
    }
  }

  private receive(scope: Scope, filename: string | Buffer | null): void {
    if (this.watchers.get(scope.key) !== scope || !scope.watcher) return;
    const rel = filename == null ? '' : String(filename);
    if (hasSkipSegment(rel)) return;
    const target = path.resolve(scope.root, rel);
    if (relativeInside(scope.root, target) === undefined) return;
    const candidates = new Map<string, Binding>();
    let cursor = target;
    while (true) {
      for (const binding of this.bindingsByPhysical.get(pathKey(cursor)) ?? []) candidates.set(binding.key, binding);
      if (pathKey(cursor) === scope.key) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    for (const binding of candidates.values()) {
      if (!covers(scope.root, binding.physical)) continue;
      const relative = rel ? relativeInside(binding.physical, target) : '';
      if (relative !== undefined && !hasSkipSegment(relative)) this.queue(binding, relative);
    }
  }

  private cancelPending(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.pending.delete(key);
  }

  private queue(binding: Binding, rel: string): void {
    let batch = this.pending.get(binding.key);
    if (!batch) { batch = { binding, paths: new Set() }; this.pending.set(binding.key, batch); }
    if (batch.paths.has('')) return;
    if (rel === '' || batch.paths.size >= PENDING_MAX) { batch.paths.clear(); batch.paths.add(''); }
    else batch.paths.add(rel);
    const timer = this.timers.get(binding.key);
    if (timer) clearTimeout(timer);
    this.timers.set(binding.key, setTimeout(() => { void this.flush(binding.key); }, DEBOUNCE_MS));
  }

  private current(binding: Binding): boolean {
    if (this.closing) return false;
    const workspace = this.ctx.config.get().workspaces.find(w => w.id === binding.workspaceId);
    if (this.bindings.get(binding.key) !== binding || !workspace || (workspace.rootsRevision ?? 0) !== binding.revision) return false;
    try { return requireSourceRoot(workspace, binding.rootId).path === binding.root; } catch { return false; }
  }

  private flush(key: string): Promise<void> {
    const task = Promise.resolve().then(() => this.flushOwned(key));
    this.active.add(task);
    void task.then(() => this.active.delete(task), () => this.active.delete(task));
    return task;
  }

  private async flushOwned(key: string): Promise<void> {
    this.timers.delete(key);
    const batch = this.pending.get(key);
    this.pending.delete(key);
    if (!batch || !this.current(batch.binding)) return;
    try {
      if (!(await fs.promises.stat(batch.binding.physical)).isDirectory()) throw new Error('source folder is not a directory');
      if (!this.current(batch.binding)) return;
      this.bindingErrors.delete(key);
    } catch (err) {
      if (!this.current(batch.binding)) return;
      const error = err instanceof Error ? err.message : String(err);
      this.bindingErrors.set(key, error);
      this.send({ workspaceId: batch.binding.workspaceId, rootId: batch.binding.rootId,
        rootsRevision: batch.binding.revision, relativePaths: [], error });
      return;
    }
    const relativePaths: string[] = [];
    // 有界批次校验真实路径，避免把根内越界 Junction 的事件送给自动化。
    const candidates = [...batch.paths];
    for (let i = 0; i < candidates.length; i += 16) {
      const checked = await Promise.all(candidates.slice(i, i + 16).map(async rel => {
        try { await resolveRealPathInsideRoot(batch.binding.physical, rel || '.'); return rel; }
        catch { return undefined; }
      }));
      relativePaths.push(...checked.filter((rel): rel is string => rel !== undefined));
    }
    if (!relativePaths.length || !this.current(batch.binding)) return;
    try { this.onChanged?.(batch.binding.workspaceId, relativePaths, batch.binding.rootId); }
    catch (err) { console.error('[fs.watch] onChanged listener failed', err); }
    this.send({ workspaceId: batch.binding.workspaceId, rootId: batch.binding.rootId,
      rootsRevision: batch.binding.revision, relativePaths });
  }

  private send(payload: FsChangedPayload): void {
    if (this.closing) return;
    const win = this.ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('fs:changed', payload);
  }
}
