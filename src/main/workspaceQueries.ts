import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig, WorkspaceListedFile, WorkspaceQueryOptions, WorkspaceQueryResult, WorkspaceQueryRootStatus, WorkspaceRoot, WorkspaceSearchHit } from '../shared/types';
import { sourceRootsFor, requireSourceRoot } from '../shared/workspaceRoots';
import { captureWorkspaceRoots, requireWorkspace, resolveRealPathInsideRoot, workspaceRootsAreCurrent } from './workspacePaths';
import { pathKey } from './pathKey';
import { listPathsDetailed, searchTextDetailed, type RgResult } from './workspaceRg';
import { rankWorkspaceFiles } from '../shared/workspaceQuery';

type Config = Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>;
type ResolvedRoot = WorkspaceRoot & { physical: string; inode: string; excludeDirs: string[] };
type Waiter = { grant: () => void; cancel: () => void; signal: AbortSignal };
type ActiveQuery = { controller: AbortController; token: ReturnType<typeof captureWorkspaceRoots> };
type SubscribeConfigChanges = (listener: () => void) => () => void;
const MAX_CONCURRENT = 2;
const MAX_ACTIVE_QUERIES = 32;

function relativeChild(parent: string, child: string): string | undefined {
  const rel = path.relative(parent, child).replace(/\\/g, '/');
  return !rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? undefined : rel;
}

async function assertRootLocation(root: ResolvedRoot): Promise<void> {
  const physical = await fs.realpath(root.path);
  const stat = await fs.stat(physical, { bigint: true });
  if (pathKey(physical) !== pathKey(root.physical) || `${stat.dev}:${stat.ino}` !== root.inode) {
    throw new Error('source folder location changed; refresh query');
  }
}

/** 查询间共享进程池；每根保留预算，不把结果上限乘根数。 */
export class WorkspaceQueries {
  private active = new Map<string, ActiveQuery>();
  private running = 0;
  private waiting: Waiter[] = [];
  private readonly unsubscribeConfigChanges?: () => void;

  constructor(private readonly getConfig: () => Config,
    private readonly rg = { listPathsDetailed, searchTextDetailed },
    subscribeConfigChanges?: SubscribeConfigChanges) {
    // Root revisions are changed by ConfigManager events. Keep one listener for
    // the service and abort only queries whose workspace snapshot became stale.
    this.unsubscribeConfigChanges = subscribeConfigChanges?.(() => {
      const config = this.getConfig();
      for (const query of this.active.values()) {
        if (!workspaceRootsAreCurrent(config, query.token)) query.controller.abort();
      }
    });
  }

  dispose(): void {
    this.unsubscribeConfigChanges?.();
    for (const query of this.active.values()) query.controller.abort();
    this.active.clear();
  }

  cancel(workspaceId: string, requestId: string): boolean {
    const query = this.active.get(JSON.stringify([workspaceId, requestId]));
    if (!query) return false;
    query.controller.abort();
    return true;
  }

  list(workspaceId: string, opts: WorkspaceQueryOptions = {}): Promise<WorkspaceQueryResult<WorkspaceListedFile>> {
    return this.query(workspaceId, opts, 8000, (root, limit, signal) => this.rg.listPathsDetailed(root.physical, {
      max: limit, signal, excludeDirs: root.excludeDirs, includeHidden: opts.includeHidden, includeIgnored: opts.includeIgnored
    }), (rel, root) => ({ path: rel, fileRef: { workspaceId, rootId: root.id, relativePath: rel }, absolutePath: path.join(root.path, rel) }), value => value)
      .then(result => opts.query ? { ...result, items: rankWorkspaceFiles(result.items, opts.query, opts.max ?? 8000) } : result);
  }

  search(workspaceId: string, opts: WorkspaceQueryOptions): Promise<WorkspaceQueryResult<WorkspaceSearchHit>> {
    return this.query(workspaceId, opts, 200, (root, limit, signal) => this.rg.searchTextDetailed(root.physical, {
      query: opts.query ?? '', caseSensitive: opts.caseSensitive, maxResults: limit, signal,
      excludeDirs: root.excludeDirs, includeHidden: opts.includeHidden, includeIgnored: opts.includeIgnored
    }), (hit, root) => ({ ...hit, path: hit.path.replace(/^\.\//, ''), fileRef: {
      workspaceId, rootId: root.id, relativePath: hit.path.replace(/^\.\//, '')
    } }), hit => hit.path);
  }

  private async slot<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T | undefined> {
    if (signal.aborted) return undefined;
    if (this.running >= MAX_CONCURRENT) {
      const granted = await new Promise<boolean>(resolve => {
        const waiter: Waiter = {
          signal,
          grant: () => { signal.removeEventListener('abort', waiter.cancel); resolve(true); },
          cancel: () => { this.waiting = this.waiting.filter(w => w !== waiter); resolve(false); }
        };
        this.waiting.push(waiter);
        signal.addEventListener('abort', waiter.cancel, { once: true });
      });
      if (!granted) return undefined;
    } else this.running += 1;
    try { return signal.aborted ? undefined : await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) next.grant();
      else this.running -= 1;
    }
  }

  private async query<Input, Output>(workspaceId: string, opts: WorkspaceQueryOptions, defaultMax: number,
    perform: (root: ResolvedRoot, limit: number, signal: AbortSignal) => Promise<RgResult<Input>>,
    decorate: (value: Input, root: ResolvedRoot) => Output,
    getPath: (value: Input) => string
  ): Promise<WorkspaceQueryResult<Output>> {
    if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId !== workspaceId.trim()) throw new Error('workspace identity required');
    const config = this.getConfig();
    const workspace = requireWorkspace(config, workspaceId);
    const token = captureWorkspaceRoots(config, workspaceId);
    let roots = [...sourceRootsFor(workspace)].map(r => ({ ...r }));
    if (opts.rootIds !== undefined) {
      if (!Array.isArray(opts.rootIds) || opts.rootIds.some(id => typeof id !== 'string' || !id)) throw new Error('invalid source folder selection');
      roots = [...new Set(opts.rootIds)].map(id => ({ ...requireSourceRoot(workspace, id) }));
    }
    const max = opts.max ?? defaultMax;
    if (!Number.isSafeInteger(max) || max < 1 || max > defaultMax) throw new Error(`query budget must be between 1 and ${defaultMax}`);
    const requestId = opts.requestId ?? randomUUID();
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new Error('invalid query identity');
    const key = JSON.stringify([workspaceId, requestId]);
    this.active.get(key)?.controller.abort();
    if (!this.active.has(key) && this.active.size >= MAX_ACTIVE_QUERIES) throw new Error('too many active workspace queries');
    const controller = new AbortController();
    this.active.set(key, { controller, token });
    const current = (): boolean => workspaceRootsAreCurrent(this.getConfig(), token);
    // Close the small synchronous gap between snapshot capture and registration
    // when a config update was already committed before this query became active.
    if (!current()) controller.abort();
    const status = roots.map(root => ({ rootId: root.id, truncated: false, timedOut: false } as WorkspaceQueryRootStatus));
    const finished = new Set<number>();
    let deadlineExceeded = false;
    // 整体时限包含池中排队；根数不能把 25s/45s 时限乘成几分钟。
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      for (let index = 0; index < status.length; index++) if (!finished.has(index) && !status[index].error) status[index].timedOut = true;
      controller.abort();
    }, defaultMax === 200 ? 25_000 : 45_000);
    const resolved: Array<ResolvedRoot | undefined> = new Array(roots.length);
    const output: Output[][] = roots.map(() => []);
    try {
      // root 数量不会转成并发 realpath 或 rg 子进程数量。
      for (let i = 0; i < roots.length && !controller.signal.aborted; i++) {
        try {
          const physical = await fs.realpath(roots[i].path);
          const stat = await fs.stat(physical, { bigint: true });
          if (!stat.isDirectory()) throw new Error('source folder is not a directory');
          if (!resolved.some(root => root && pathKey(root.physical) === pathKey(physical))) {
            resolved[i] = { ...roots[i], physical, inode: `${stat.dev}:${stat.ino}`, excludeDirs: [] };
          }
        } catch (err) { status[i].error = err instanceof Error ? err.message : String(err); }
      }
      for (const root of resolved) {
        if (!root) continue;
        root.excludeDirs = resolved.filter((child): child is ResolvedRoot => !!child && child !== root)
          .map(child => relativeChild(root.physical, child.physical)).filter((dir): dir is string => dir !== undefined);
      }
      const candidates = resolved.map((root, index) => ({ root, index })).filter((entry): entry is { root: ResolvedRoot; index: number } => !!entry.root);
      let nextIndex = 0;
      const work = async (): Promise<void> => {
        while (nextIndex < candidates.length && !controller.signal.aborted) {
          const position = nextIndex++;
          const { root, index } = candidates[position];
          // 保留每根最低份额；预算小于根数时明确标记未检索的根，而非隐瞒。
          const limit = Math.floor(max / candidates.length) + (position < max % candidates.length ? 1 : 0);
          if (!limit) { status[index].truncated = true; finished.add(index); continue; }
          try {
            const result = await this.slot(controller.signal, async () => {
              await assertRootLocation(root);
              controller.signal.throwIfAborted();
              return perform(root, limit, controller.signal);
            });
            if (!result || controller.signal.aborted) break;
            status[index].truncated = result.truncated;
            status[index].timedOut = result.timedOut;
            if (result.cancelled) { controller.abort(); break; }
            // rg 默认不跟随目录链接，返回路径仍需防文件链接和扫描期间改指向。
            for (let start = 0; start < result.items.length && !controller.signal.aborted; start += 16) {
              const checked = await Promise.all(result.items.slice(start, start + 16).map(async value => {
                try {
                  await resolveRealPathInsideRoot(root.physical, getPath(value));
                  return decorate(value, root);
                } catch { return undefined; }
              }));
              for (const value of checked) if (value !== undefined) output[index].push(value);
            }
            finished.add(index);
          } catch (err) { status[index].error = err instanceof Error ? err.message : String(err); finished.add(index); }
        }
      };
      await Promise.all([work(), work()]);
      // 根路径的 Junction 改指向或同名目录替换不一定改配置版本。
      for (const { root, index } of candidates) {
        if (controller.signal.aborted) break;
        try { await assertRootLocation(root); }
        catch (err) { output[index] = []; status[index].error = err instanceof Error ? err.message : String(err); }
      }
      const cancelled = (controller.signal.aborted && !deadlineExceeded) || !current();
      const items: Output[] = [];
      if (!cancelled) {
        // 公平交错，界面只取前 40 条时也不会把第二根全部藏在第一根之后。
        for (let row = 0; items.length < max && output.some(values => row < values.length); row++) {
          for (const values of output) if (row < values.length && items.length < max) items.push(values[row]);
        }
      }
      return { items, roots: status, rootsRevision: token.rootsRevision,
        truncated: status.some(root => root.truncated || root.timedOut), cancelled,
        ...(!current() ? { error: 'workspace source folders changed; retry query' }
          : deadlineExceeded ? { error: 'workspace query timed out; narrow the search' } : {}) };
    } finally {
      clearTimeout(deadlineTimer);
      if (this.active.get(key)?.controller === controller) this.active.delete(key);
    }
  }
}
