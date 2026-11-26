import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { GitOperationScope } from '../../shared/gitOperations';
import type { GitEvidenceContents } from '../safety/evidence';
import { type SimpleGit, type StatusResult, type PushResult } from 'simple-git';
import type { ConfigManager } from '../config';
import type {
  GitActionResult,
  GitAddRepoResult,
  GitAdoptHunkKey,
  GitAdoptHunksResult,
  GitAdoptPreviewResult,
  GitBranchList,
  GitCheckoutRequest,
  GitCommitDiffResult,
  GitCommitFilesResult,
  GitDiffResult,
  GitFileChange,
  GitGraphBranch,
  GitGraphCommit,
  GitLogPage,
  GitRepoStatus,
  GitRepoSummary,
  GitRepoListResult,
  GitRepoLocationListResult,
  GitRepoDiscoveryIssue,
  GitWorktreeAddArgs,
  GitWorktreeAddResult,
  GitWorktreeAddGroupResult,
  GitWorktreeInfo,
  GitDeleteBranchResult,
  GitMergeIsolateResult,
  MergeIsolateOptions,
  WorkspaceInfo
} from '../../shared/types';
import { parseNameStatusZ } from './parseNameStatus';
import { isPathInsideWorkspace, gitScanIssue } from './scan';
import {
  findContainingWorkspace,
  resolveWorktreesRoot,
  compactWorktreePath,
  type WorkspacePathRef
} from './workspaceResolve';
import {
  ensureWorktreesExclude,
  parseWorktreePorcelain,
  sessionWorktreeBranch,
  sessionWorktreeDirName
} from './worktree';
import {
  addNestedWorktrees,
  formatNestedRepoSkipWarning,
  normalizeRepoSetInput,
  selectHealthyNestedTargets,
  inspectSelectedNestedRepos,
  type NestedRepoDiscovery
} from './nestedRepos';
import {
  deleteMergedBranch,
  deleteBranchForce,
  isBranchMergedIntoDefault,
  mergeIsolateBranch,
  parsePorcelainPaths,
  resolveDefaultBranch
} from './mergeIsolate';
import { createAdopter } from './adopt';
import { pathKey } from '../pathKey';
import { readGitDirectories, resolveRepoIdentity } from './repoIdentity';
import { GitRepoDiscoveryCache } from './discoveryCache';
import { prepareWorktreeGroup, assertPreparedWorktreeGroupCurrent, type PreparedWorktreeGroup } from './worktreeCreatePlan';
import { rollbackPreparedTrees } from './worktreeRollback';
import { controlRootFor, defaultCwdFor, requireWorkspace, resolveRealPathInsideRoot, sourcePathKey, sourceRootsFor } from '../workspacePaths';
import { readWorkspaceFile } from '../metaAgent/workspaceFile';
import { repositoryExclusions } from '../../shared/worktreePreparation';
import { errorMessage } from '../../shared/errors';
import { t } from '../../shared/i18n';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitCommandEnvironment } from './gitEnvironment';
import { createHostGitClient } from './hostGitClient';

export type MergeBlockedListener = (info: {
  mainRepo: string;
  branch: string;
  files: string[];
}) => void;
let mergeBlockedListener: MergeBlockedListener | null = null;
/** R3：合入被脏文件挡时通知事件泵（index 装配，避免循环依赖） */
export function setMergeBlockedListener(fn: MergeBlockedListener | null): void {
  mergeBlockedListener = fn;
}

const execFileAsync = promisify(execFile);

function gitErrMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: string; stderr?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    if (stderr) return stderr;
    if (typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  }
  return errorMessage(err);
}

function mapFiles(status: StatusResult): GitFileChange[] {
  return status.files.map((f) => ({
    path: f.path,
    index: f.index ?? ' ',
    working_dir: f.working_dir ?? ' '
  }));
}

// .git 内用于判断「仓库活动状态」的关键文件；任一变化即认为 summary 可能过期。
const GIT_PROBE_FILES = ['HEAD', 'index', 'FETCH_HEAD', 'COMMIT_EDITMSG', 'logs/HEAD'];

/** summarize 批量并发上限：Windows 下 spawn 昂贵，几十仓同时 spawn git 会打满主进程 CPU，堵住其他 IPC */
const SUMMARIZE_CONCURRENCY = 6;

/** dirty（porcelain）结果 TTL：窗口内不重跑 porcelain，直接用上次结果 */
const DIRTY_TTL_MS = 2000;

/** status() 结果 TTL */
const STATUS_TTL_MS = 1500;

/** 小型并发限制器：最多 limit 个任务同时在途，结果保持输入顺序 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

interface SummaryCacheEntry {
  /** probe 文件 mtime 摘要（max）；用于判断缓存是否仍新鲜 */
  probeMtimeMs: number;
  summary: GitRepoSummary;
  /** 上次 porcelain 实际执行的 dirty 结果与时间（固定窗口，不随复用滑动） */
  dirty: boolean;
  dirtyAtMs: number;
}

interface StatusCacheEntry {
  /** 缓存写入时间；TTL 内直接复用对象 */
  atMs: number;
  status: GitRepoStatus;
}

interface BranchHeadsCacheEntry {
  /** refs 目录 mtime；变化才重读 branchHeads */
  refsMtimeMs: number;
  branchHeads: GitGraphBranch[];
}

interface RepoListScope {
  workspace: WorkspaceInfo;
  key: string;
  followsActive: boolean;
}
type RepoRefreshResult = { ok: true; count: number; workspaceIds: string[]; issues: GitRepoDiscoveryIssue[]; issueCount: number };
interface GitOperationContext {
  workspace: WorkspaceInfo;
  rootsKey: string;
  checkedRepos: Set<string>;
}

export class GitService {
  private preparedWorktreeGroups = new WeakMap<PreparedWorktreeGroup, string>();
  private operationScope = new AsyncLocalStorage<GitOperationContext>();
  /** Shared topology snapshot for the Git list, dispatch preflight and group creation. */
  private discovery = new GitRepoDiscoveryCache();
  /** SimpleGit 实例按仓路径缓存，避免每次调用都重建 child 通道 */
  private clients = new Map<string, SimpleGit>();
  private clientEnvironments = new WeakMap<SimpleGit, string>();
  /** 仓库摘要缓存：key = pathKey(repoPath) */
  private summaryCache = new Map<string, SummaryCacheEntry>();
  private summaryInFlight = new Map<string, { promise: Promise<GitRepoSummary>; epoch: number }>();
  /** branchHeads 缓存（log 翻页复用）：key = pathKey(repoPath) */
  private branchHeadsCache = new Map<string, BranchHeadsCacheEntry>();
  /** status 结果缓存（TTL）：key = pathKey(root) */
  private statusCache = new Map<string, StatusCacheEntry>();
  private remoteChecks = new Map<string, { identity: string; value: import('../../shared/types').GitRemoteCheck }>();
  /** status 在途去重：key = pathKey(root)，同仓并发调用共享 Promise */
  private statusInFlight = new Map<string, { promise: Promise<GitRepoStatus>; epoch: number }>();
  /** Old slow reads cannot refill caches invalidated by a manual discovery refresh. */
  private statusEpoch = 0;
  /** listRepos 在途 Promise（single-flight）：并发调用搭同一班车，避免双倍 spawn */
  private listReposInFlight = new Map<string, { promise: Promise<GitRepoListResult>; forced: boolean }>();
  /** Manual refresh during a summary read awaits the subsequent fresh scan. */
  private listReposForcedInFlight = new Map<string, Promise<GitRepoListResult>>();
  private locationListsInFlight = new Map<string, Promise<GitRepoLocationListResult>>();
  private refreshReposInFlight = new Map<string, Promise<RepoRefreshResult>>();
  private summaryLanes: Promise<unknown>[] = Array.from({ length: SUMMARIZE_CONCURRENCY }, () => Promise.resolve());
  private summaryCursor = 0;

  constructor(private readonly config: ConfigManager) {}

  private rootsKey(workspace: WorkspaceInfo): string {
    return JSON.stringify([workspace.rootsRevision ?? 0, sourceRootsFor(workspace),
      workspace.defaultRootId, workspace.controlRoot, workspace.path]);
  }

  /** UI requests capture their owner before any dialog, filesystem or Git await. */
  async withWorkspace<T>(scope: GitOperationScope, run: () => Promise<T>): Promise<T> {
    if (!scope || typeof scope.workspaceId !== 'string' || !scope.workspaceId.trim()
      || !Number.isSafeInteger(scope.rootsRevision) || scope.rootsRevision < 0) {
      throw new Error('invalid Git workspace scope');
    }
    const workspace = requireWorkspace(this.config.get(), scope.workspaceId);
    if ((workspace.rootsRevision ?? 0) !== scope.rootsRevision) throw new Error('workspace repository scope changed');
    const existing = this.assertOperationScope();
    if (existing) {
      if (existing.workspace.id !== workspace.id) throw new Error('conflicting Git workspace scope');
      return run();
    }
    const context: GitOperationContext = { workspace: structuredClone(workspace), rootsKey: this.rootsKey(workspace), checkedRepos: new Set() };
    return this.operationScope.run(context, async () => {
      const result = await run();
      this.assertOperationScope();
      // Shared status promises/caches may have started in another scope.
      for (const repo of context.checkedRepos) {
        if (!await this.currentlyRegistered(repo)) throw new Error('workspace repository scope changed');
      }
      this.assertOperationScope();
      return result;
    });
  }

  private assertOperationScope(): GitOperationContext | undefined {
    const context = this.operationScope.getStore();
    if (context && this.rootsKey(requireWorkspace(this.config.get(), context.workspace.id)) !== context.rootsKey) {
      throw new Error('workspace repository scope changed');
    }
    return context;
  }

  private operationWorkspace(): WorkspaceInfo {
    return this.assertOperationScope()?.workspace ?? requireWorkspace(this.config.get());
  }

  currentOperationScope(): GitOperationScope {
    const workspace = this.operationWorkspace();
    return { workspaceId: workspace.id, rootsRevision: workspace.rootsRevision ?? 0 };
  }

  workspaceRoot(): { path: string; workspaceId: string } {
    return { path: this.workspace(), workspaceId: this.activeWorkspaceId() };
  }

  private async repoIdentity(root: string) {
    const candidates = [...this.workspaceRefs().map((w) => w.path)];
    const known = await resolveRepoIdentity(root, candidates);
    if (known) return known;
    const dirs = readGitDirectories(root);
    if (!dirs) return null;
    try { await fs.access(dirs.commonDir); } catch { return null; }
    candidates.push(...await this.discovery.rootsMany(await Promise.all(this.workspaceRefs().map(async workspace =>
      fs.realpath(workspace.path).catch(() => path.resolve(workspace.path))))));
    return resolveRepoIdentity(root, candidates);
  }

  private async registeredWorktree(root: string) {
    const identity = await this.repoIdentity(root);
    return identity?.linked && this.key(identity.root) === this.key(root) ? identity : null;
  }

  private workspace(): string {
    return path.resolve(defaultCwdFor(this.operationWorkspace()));
  }

  private activeWorkspaceId(): string {
    return this.assertOperationScope()?.workspace.id ?? this.config.get().activeWorkspaceId;
  }

  private key(p: string): string {
    return pathKey(p);
  }

  private async hasGitRoot(repoPath: string): Promise<boolean> {
    try {
      await fs.access(path.join(repoPath, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  private workspaceRefs(): WorkspacePathRef[] {
    const scoped = this.assertOperationScope();
    return (scoped ? [scoped.workspace] : this.config.get().workspaces ?? []).flatMap(w => w.rootsError ? [] : sourceRootsFor(w).map(root => ({ id: w.id, path: root.path })));
  }

  private listScope(workspaceId?: string): RepoListScope {
    const workspace = requireWorkspace(this.config.get(), workspaceId);
    const followsActive = workspaceId === undefined;
    const key = JSON.stringify([workspace.id, workspace.rootsRevision ?? 0, sourceRootsFor(workspace).map(r => [r.id, r.path]), followsActive]);
    return { workspace, key, followsActive };
  }

  private assertListScope(scope: RepoListScope): void {
    if (this.listScope(scope.followsActive ? undefined : scope.workspace.id).key !== scope.key) {
      throw new Error('workspace repository scope changed');
    }
  }

  /** Cached discovery is never authorization; realpath and current registration are rechecked. */
  private async repoInScopes(repo: string, roots: readonly string[]): Promise<boolean> {
    const containing = [...roots].filter(root => isPathInsideWorkspace(repo, root)).sort((a, b) => b.length - a.length);
    for (const root of containing) {
      try { await resolveRealPathInsideRoot(root, repo); return true; }
      catch { /* An invalid/Junction scope must not broaden access. */ }
    }
    if (!containing.length) {
      // Git may return a canonical path for a registered source-root Junction.
      const physicalRepo = await fs.realpath(repo).catch(() => undefined);
      if (physicalRepo) for (const root of roots) {
        const physicalRoot = await fs.realpath(root).catch(() => undefined);
        if (physicalRoot && isPathInsideWorkspace(physicalRepo, physicalRoot)) return true;
      }
    }
    return false;
  }

  private async currentlyRegistered(repo: string): Promise<boolean> {
    const roots = this.workspaceRefs().map(w => w.path);
    const permitted = await this.repoInScopes(repo, roots);
    // Recheck after the await: a registration change must not validate retroactively.
    return permitted && JSON.stringify(roots) === JSON.stringify(this.workspaceRefs().map(w => w.path));
  }

  private unknownRepoContext(resolved: string): { active: string; target: string } {
    const containing = findContainingWorkspace(resolved, this.workspaceRefs());
    return {
      active: this.workspace(),
      target: containing?.path ?? resolved
    };
  }

  /**
   * 路径是当前登记源仓的 linked worktree 时可操作，
   * 不要求人先切活动工作区或点「刷新/添加」。
   */
  private async tryAdoptLinkedWorktree(resolved: string) {
    try {
      const identity = await this.registeredWorktree(resolved);
      if (!identity) return null;
      const mainRepo = identity.mainRepo;
      return await this.currentlyRegistered(mainRepo) ? identity : null;
    } catch {
      return null;
    }
  }

  private async assertAllowed(repoPath: string): Promise<string> {
    this.assertOperationScope();
    const resolved = path.resolve(repoPath);
    const ctx = this.unknownRepoContext(resolved);
    if (!(await this.hasGitRoot(resolved))) {
      throw new Error(
        t('不是 git 仓库: {{resolved}}（当前活动工作区 {{active}}、目标 {{target}}）', {
          resolved,
          active: ctx.active,
          target: ctx.target
        })
      );
    }
    if (await this.currentlyRegistered(resolved)) {
      this.assertOperationScope()?.checkedRepos.add(resolved);
      return resolved;
    }
    const linked = await this.tryAdoptLinkedWorktree(resolved);
    if (linked) {
      this.assertOperationScope()?.checkedRepos.add(linked.mainRepo);
      return resolved;
    }
    throw new Error(
      t(
        '未知仓库（未登记或索引未刷新）: {{resolved}}（当前活动工作区 {{active}}、目标 {{target}}）。可调用 git.refreshRepos() 刷新。',
        { resolved, active: ctx.active, target: ctx.target }
      )
    );
  }

  /**
   * 读取 .git 关键文件的最大 mtime，作为「仓库活动指纹」。
   * 用于 summary 缓存失效判断：mtime 未变即认为 dirty/branch/ahead/behind 未变。
   * 同时复用为 lastModifiedMs（最近活动排序用）。
   */
  private async readGitProbeMtime(repoPath: string): Promise<number> {
    let max = 0;
    const dirs = readGitDirectories(repoPath);
    if (!dirs) return 0;
    const gitPath = dirs.gitDir;

    for (const rel of GIT_PROBE_FILES) {
      try {
        const s = await fs.stat(path.join(gitPath, rel));
        if (s.mtimeMs > max) max = s.mtimeMs;
      } catch {
        /* skip */
      }
    }
    return max;
  }

  /**
   * 直接读 .git/HEAD 解析当前分支名，避免 spawn 一次 git status。
   * - `ref: refs/heads/<name>` → name
   * - detached（纯 sha）→ 返回 null，调用方 fallback 到 git status
   */
  async readHeadBranch(repoPath: string): Promise<string | null> {
    try {
      const dirs = readGitDirectories(repoPath);
      if (!dirs) return null;
      const content = await fs.readFile(path.join(dirs.gitDir, 'HEAD'), 'utf8');
      const m = content.match(/^ref:\s+refs\/heads\/(.+)$/m);
      return m ? m[1]!.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * 单仓摘要。
   * - dirty：跑 `git status --porcelain`（单 spawn，比完整 status 轻很多），
   *   结果带 2 秒 TTL（工作区/未跟踪文件变化不会更新 .git probe mtime，无法靠 mtime 缓存 dirty）。
   * - branch / ahead / behind：靠 .git probe mtime 缓存，命中时直接复用，省掉
   *   rev-parse/rev-list 的额外 spawn。这些状态变化必然伴随 HEAD/refs mtime 变化。
   * - 引用稳定：dirty、branch/ahead/behind、probe mtime 都没变时返回旧 summary 对象，
   *   避免渲染层整列表引用全变、全树重渲。
   */
  private async summarizeRepo(repoPath: string): Promise<GitRepoSummary> {
    const epoch = this.statusEpoch;
    const name = path.basename(repoPath);
    const k = this.key(repoPath);
    const probeMtimeMs = await this.readGitProbeMtime(repoPath);
    const lastModifiedMs = probeMtimeMs;

    const cached = this.summaryCache.get(k);
    const metaFresh = cached && cached.probeMtimeMs === probeMtimeMs;
    const dirtyFresh = cached && Date.now() - cached.dirtyAtMs < DIRTY_TTL_MS;

    // 全部新鲜：直接返回旧对象，零 spawn
    if (metaFresh && dirtyFresh && cached) {
      return cached.summary;
    }

    try {
      const git = this.client(repoPath);

      let dirty: boolean;
      let dirtyAtMs = Date.now();
      if (dirtyFresh && cached) {
        // dirty TTL 内复用上次 porcelain 结果（dirtyAtMs 保留原值，固定窗口不滑动）
        dirty = cached.dirty;
        dirtyAtMs = cached.dirtyAtMs;
      } else {
        const porcelain = await git.raw(['status', '--porcelain']);
        dirty = String(porcelain || '').trim().length > 0;
        // A slow status must receive a full TTL after it completes.
        dirtyAtMs = Date.now();
      }

      let branch: string | undefined;
      let ahead: number | undefined;
      let behind: number | undefined;

      if (metaFresh && cached) {
        // branch/ahead/behind 靠 probe mtime 保证新鲜，直接复用
        branch = cached.summary.branch;
        ahead = cached.summary.ahead;
        behind = cached.summary.behind;
      } else {
        branch = (await this.readHeadBranch(repoPath)) ?? undefined;
        // 仅在分支有 upstream 时才比对远端，避免无跟踪分支也跑 rev-list
        if (branch) {
          try {
            const tracking = await git.raw([
              'rev-parse',
              '--abbrev-ref',
              '--symbolic-full-name',
              '@{u}'
            ]);
            const up = String(tracking || '').trim();
            if (up && !up.includes('HEAD')) {
              const counts = await git.raw(['rev-list', '--left-right', '--count', `${up}...HEAD`]);
              const parts = String(counts || '').trim().split(/\s+/);
              if (parts.length === 2) {
                behind = Number(parts[0]) || 0;
                ahead = Number(parts[1]) || 0;
              }
            }
          } catch {
            /* 无 upstream 或 detached，跳过 */
          }
        }
      }

      if (
        metaFresh &&
        cached &&
        cached.summary.dirty === dirty &&
        cached.summary.branch === branch &&
        cached.summary.ahead === ahead &&
        cached.summary.behind === behind
      ) {
        // 内容与上次完全一致：沿用旧对象保持引用相等，只刷新缓存条目
        if (epoch === this.statusEpoch) this.summaryCache.set(k, { probeMtimeMs, summary: cached.summary, dirty, dirtyAtMs });
        return cached.summary;
      }

      const summary: GitRepoSummary = {
        path: repoPath,
        name,
        dirty,
        branch,
        ahead,
        behind,
        lastModifiedMs,
        worktree: (() => { const d = readGitDirectories(repoPath); return !!d && this.key(d.gitDir) !== this.key(d.commonDir); })()
      };
      if (epoch === this.statusEpoch) this.summaryCache.set(k, { probeMtimeMs, summary, dirty, dirtyAtMs });
      return summary;
    } catch (e) {
      // Unknown status must never become a clean row or survive in the cache.
      if (epoch === this.statusEpoch) this.summaryCache.delete(k);
      console.warn(`[git] summarizeRepo failed: ${repoPath}:`, (e as Error).message);
      throw e;
    }
  }

  private summarizeBounded(repoPath: string): Promise<GitRepoSummary> {
    const key = this.key(repoPath);
    const existing = this.summaryInFlight.get(key);
    if (existing) {
      if (existing.epoch === this.statusEpoch) return existing.promise;
      return existing.promise.catch(() => undefined).then(() => this.summarizeBounded(repoPath));
    }
    const lane = this.summaryCursor++ % SUMMARIZE_CONCURRENCY;
    const value = this.summaryLanes[lane].then(() => this.summarizeRepo(repoPath)).finally(() => {
      if (this.summaryInFlight.get(key)?.promise === value) this.summaryInFlight.delete(key);
    });
    this.summaryInFlight.set(key, { promise: value, epoch: this.statusEpoch });
    this.summaryLanes[lane] = value.catch(() => undefined);
    return value;
  }

  private client(repoPath: string): SimpleGit {
    const k = this.key(repoPath);
    const environment = gitCommandEnvironment();
    const environmentKey = JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)));
    let c = this.clients.get(k);
    if (!c || this.clientEnvironments.get(c) !== environmentKey) {
      // Large local checkouts can legitimately produce no status output for >10s.
      // Preserve a bounded timeout, without converting timeout into a clean row.
      c = createHostGitClient(repoPath, environment, 60000);
      this.clients.set(k, c);
      this.clientEnvironments.set(c, environmentKey);
    }
    const context = this.assertOperationScope();
    if (!context) return c;
    // Methods are awaited directly by this service. Bind the cached client to each
    // request, and recheck access before *every* command in multi-step operations.
    return new Proxy(c, {
      get: (target, property) => {
        const method = Reflect.get(target, property);
        if (typeof method !== 'function' || property === 'then') return typeof method === 'function' ? method.bind(target) : method;
        return (...args: unknown[]) => this.operationScope.run(context, async () => {
          this.assertOperationScope();
          if (property !== 'init') await this.assertAllowed(repoPath);
          this.assertOperationScope();
          return method.apply(target, args);
        });
      }
    });
  }

  /** 失效单仓 summary/status 缓存（操作后强制下次重读） */
  private invalidateSummary(repoPath: string): void {
    const k = this.key(repoPath);
    this.summaryCache.delete(k);
    this.statusCache.delete(k);
  }

  async listRepos(forceRescan = false, requestedPaths: string[] = [], workspaceId?: string): Promise<GitRepoSummary[]> {
    return (await this.listReposDetailed(forceRescan, requestedPaths, workspaceId)).repos;
  }

  async listReposDetailed(forceRescan = false, requestedPaths: string[] = [], workspaceId?: string): Promise<GitRepoListResult> {
    const scope = this.listScope(workspaceId);
    if (requestedPaths.length) {
      const result = await this.listReposDetailed(forceRescan, [], workspaceId);
      const repos = [...result.repos];
      const statusIssues: GitRepoDiscoveryIssue[] = [];
      for (const requested of [...new Set(requestedPaths)].slice(0, 128)) {
        if (typeof requested !== 'string') continue;
        try {
          const identity = await this.repoIdentity(requested);
          if (!identity?.linked || repos.some((r) => this.key(r.path) === this.key(identity.root))) continue;
          if (!await this.repoInScopes(identity.mainRepo, sourceRootsFor(scope.workspace).map(r => r.path))) continue;
          const root = await this.assertAllowed(identity.root);
          try {
            repos.push({ ...await this.summarizeBounded(root), workspaceId: scope.workspace.id, worktree: true });
          } catch (error) {
            const issue = gitScanIssue(root, error);
            statusIssues.push({ ...issue, message: `git status: ${issue.message}`, code: 'GIT_STATUS',
              workspaceId: scope.workspace.id, rootPath: identity.mainRepo });
          }
        } catch (err) { console.warn('[git] requested worktree unavailable', requested, err); }
      }
      this.assertListScope(scope);
      return { ...result, repos, issues: [...result.issues, ...statusIssues].slice(0, 100),
        issueCount: result.issueCount + statusIssues.length };
    }
    const forced = this.listReposForcedInFlight.get(scope.key);
    if (forced) return forced;
    // A manual refresh must return the newly discovered list, not the stale result
    // of an already-running summary read. Concurrent manual requests share it.
    const inFlight = this.listReposInFlight.get(scope.key);
    if (inFlight) {
      if (forceRescan && !inFlight.forced) {
        const fresh = inFlight.promise.catch(() => undefined)
          .then(() => { this.assertListScope(scope); return this.startListRepos(true, scope); })
          .finally(() => {
            if (this.listReposForcedInFlight.get(scope.key) === fresh) this.listReposForcedInFlight.delete(scope.key);
          });
        this.listReposForcedInFlight.set(scope.key, fresh);
        return fresh;
      }
      return inFlight.promise;
    }
    return this.startListRepos(forceRescan, scope);
  }

  /** Start a single list read; topology refresh has its own coalesced promise. */
  private startListRepos(force: boolean, scope: RepoListScope): Promise<GitRepoListResult> {
    const p = this.runListRepos(force, scope).finally(() => {
      if (this.listReposInFlight.get(scope.key)?.promise === p) this.listReposInFlight.delete(scope.key);
    });
    this.listReposInFlight.set(scope.key, { promise: p, forced: force });
    return p;
  }

  /** Directory choices share discovery with the panel, without computing status. */
  async listRepoLocations(forceRescan = false, workspaceId?: string, requestedPaths: string[] = []): Promise<GitRepoLocationListResult> {
    const scope = this.listScope(workspaceId);
    if (requestedPaths.length) {
      const result = await this.listRepoLocations(forceRescan, workspaceId);
      const repos = [...result.repos];
      for (const requested of [...new Set(requestedPaths)].slice(0, 128)) {
        if (typeof requested !== 'string') continue;
        if (repos.some(repo => this.key(repo.path) === this.key(requested))) continue;
        try {
          const identity = await this.repoIdentity(requested);
          if (!identity?.linked || repos.some(r => this.key(r.path) === this.key(identity.root))) continue;
          if (!await this.repoInScopes(identity.mainRepo, sourceRootsFor(scope.workspace).map(r => r.path))) continue;
          const root = await this.assertAllowed(identity.root);
          repos.push({ path: root, name: path.basename(root), workspaceId: scope.workspace.id, worktree: true });
        } catch (error) { console.warn('[git] requested worktree unavailable', requested, error); }
      }
      this.assertListScope(scope);
      return { ...result, repos };
    }
    const key = JSON.stringify([scope.key, forceRescan]);
    const existing = this.locationListsInFlight.get(key);
    if (existing) return existing;
    const value = this.discoverListLocations(forceRescan, scope).finally(() => {
      if (this.locationListsInFlight.get(key) === value) this.locationListsInFlight.delete(key);
    });
    this.locationListsInFlight.set(key, value);
    return value;
  }

  private async discoverListLocations(force: boolean, scope: RepoListScope): Promise<GitRepoLocationListResult> {
    if (force) {
      this.statusEpoch++;
      this.summaryCache.clear();
      this.statusCache.clear();
    }
    const roots = sourceRootsFor(scope.workspace);
    const issues: GitRepoDiscoveryIssue[] = [];
    const entries = roots.map(r => ({ path: r.path, rootId: r.id }));
    const physical = (await Promise.all(entries.map(async root => {
      try {
        const physical = await fs.realpath(root.path);
        if (!(await fs.stat(physical)).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
        return { ...root, physical };
      } catch (error) {
        issues.push({ workspaceId: scope.workspace.id, rootId: root.rootId, rootPath: root.path, ...gitScanIssue(root.path, error) });
        return undefined;
      }
    }))).filter((p): p is NonNullable<typeof p> => p !== undefined);
    // Discover physical scopes once; project each checkout into its most-specific
    // source root so aliases do not duplicate paths or lose the registered root ID.
    const scanned = await this.discovery.rootsManyDetailed(physical.map(r => r.physical), force);
    const sourceScopes = physical.filter(r => r.rootId).sort((a, b) => b.physical.length - a.physical.length);
    for (const issue of scanned.issues) {
      const owner = sourceScopes.find(r => isPathInsideWorkspace(issue.path, r.physical) || isPathInsideWorkspace(r.physical, issue.path))
        ?? physical.find(r => isPathInsideWorkspace(issue.path, r.physical) || isPathInsideWorkspace(r.physical, issue.path));
      if (owner) issues.push({ ...issue, workspaceId: scope.workspace.id, rootId: owner.rootId, rootPath: owner.path,
        path: isPathInsideWorkspace(issue.path, owner.physical) ? path.join(owner.path, path.relative(owner.physical, issue.path)) : owner.path });
    }
    const repos = scanned.roots.map(repo => {
      const source = sourceScopes.find(r => isPathInsideWorkspace(repo, r.physical));
      const owner = source ?? physical.find(r => isPathInsideWorkspace(repo, r.physical))!;
      const repoPath = path.join(owner.path, path.relative(owner.physical, repo));
      const dirs = readGitDirectories(repoPath);
      return { path: repoPath, name: path.basename(repoPath), workspaceId: scope.workspace.id, rootId: source?.rootId,
        ...(dirs && this.key(dirs.gitDir) !== this.key(dirs.commonDir) ? { worktree: true } : {}) };
    });
    this.assertListScope(scope);
    issues.sort((a, b) => a.path.localeCompare(b.path));
    return { workspaceId: scope.workspace.id, rootsRevision: scope.workspace.rootsRevision ?? 0,
      repos, issues: issues.slice(0, 100), issueCount: issues.length };
  }

  private async runListRepos(force: boolean, scope: RepoListScope): Promise<GitRepoListResult> {
    if (force) {
      // force 刷新绕过 summary 缓存（含 dirty TTL），全部重算
      this.summaryCache.clear();
    }

    const locations = await this.discoverListLocations(force, scope);
    const roots = sourceRootsFor(scope.workspace);
    const issues = [...locations.issues];
    // 并发限流：几十个仓同时 spawn git 会打满主进程 CPU，堵住其他 IPC（如 git:status）
    const results = await mapLimit(locations.repos, SUMMARIZE_CONCURRENCY, async ({ path: repoPath, rootId }): Promise<GitRepoSummary | undefined> => {
      try {
        return { ...await this.summarizeBounded(repoPath), workspaceId: scope.workspace.id, ...(rootId ? { rootId } : {}) };
      } catch (error) {
        const issue = gitScanIssue(repoPath, error);
        issues.push({ ...issue, message: `git status: ${issue.message}`, code: 'GIT_STATUS', workspaceId: scope.workspace.id,
          rootId, rootPath: roots.find(root => root.id === rootId)?.path ?? repoPath });
        return undefined;
      }
    });
    const summaries = results.filter((value): value is GitRepoSummary => value !== undefined);
    this.assertListScope(scope);
    issues.sort((a, b) => a.path.localeCompare(b.path));
    return { workspaceId: scope.workspace.id, rootsRevision: scope.workspace.rootsRevision ?? 0, repos: summaries,
      issues: issues.slice(0, 100), issueCount: locations.issueCount + issues.length - locations.issues.length };
  }

  /** Small, explicitly scoped background reads must not fan out to all repos. */
  async repoSummaries(repoPaths: string[]): Promise<GitRepoListResult> {
    if (!Array.isArray(repoPaths) || repoPaths.length > 2 || repoPaths.some(p => typeof p !== 'string' || !p.trim())) {
      throw new Error('invalid repository summary batch');
    }
    const scope = this.listScope(this.operationWorkspace().id);
    // Check every target before starting any status command. Cached summaries
    // and membership in another workspace cannot authorize a background read.
    const paths = await Promise.all([...new Set(repoPaths)].map(p => this.assertAllowed(p)));
    const roots = [...sourceRootsFor(scope.workspace)].sort((a, b) => b.path.length - a.path.length);
    const issues: GitRepoDiscoveryIssue[] = [];
    const repos = await mapLimit(paths, 2, async repoPath => {
      const root = roots.find(r => isPathInsideWorkspace(repoPath, r.path));
      try {
        const summary = await this.summarizeBounded(repoPath);
        return { ...summary, workspaceId: scope.workspace.id, ...(root ? { rootId: root.id } : {}) };
      } catch (error) {
        issues.push({ ...gitScanIssue(repoPath, error), code: 'GIT_STATUS', workspaceId: scope.workspace.id,
          rootId: root?.id, rootPath: root?.path ?? repoPath, message: `git status: ${errorMessage(error)}` });
        return undefined;
      }
    });
    this.assertListScope(scope);
    return { workspaceId: scope.workspace.id, rootsRevision: scope.workspace.rootsRevision ?? 0,
      repos: repos.filter((r): r is NonNullable<typeof r> => !!r), issues, issueCount: issues.length };
  }

  /**
   * 在指定目录（默认当前工作区根）执行 git init。
   * 只支持工作区扫描范围内的目录；工作区外仓库改用「添加源文件夹」登记。
   */
  async initRepo(dir?: string): Promise<GitAddRepoResult> {
    const resolved = path.resolve(dir?.trim() || this.workspace());
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) {
        return { ok: false, message: t('不是有效目录') };
      }
    } catch {
      return { ok: false, message: t('目录不存在') };
    }

    if (await this.hasGitRoot(resolved)) {
      this.discovery.invalidateContaining(resolved);
      return { ok: true, path: resolved, message: t('已是 git 仓库') };
    }

    try {
      await this.client(resolved).init();
    } catch (err) {
      return { ok: false, path: resolved, message: gitErrMessage(err) };
    }

    this.invalidateSummary(resolved);
    this.discovery.invalidateContaining(resolved);
    return { ok: true, path: resolved };
  }

  /** Host-owned approval material; full hashes bind bounded previews to the actual bytes. */
  async approvalEvidence(repoPath: string, targetRef = 'HEAD', sourceRef = 'HEAD', capture?: (contents: GitEvidenceContents) => void) {
    const root = await this.assertAllowed(repoPath), git = this.client(root);
    const source = (await git.revparse(['--verify', `${sourceRef}^{commit}`])).trim();
    const target = (await git.revparse(['--verify', `${targetRef}^{commit}`])).trim();
    const [diff, workingDiff, stagedDiff, status, commits, head] = await Promise.all([
      git.diff([`${target}..${source}`, '--']), git.diff(['--']), git.diff(['--cached', '--']),
      this.status(root, true), git.raw(['log', '--format=%H %s', '-n', '100', `${target}..${source}`, '--']),
      git.revparse(['--verify', 'HEAD^{commit}'])
    ]);
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const untracked = await git.raw(['ls-files', '--others', '--exclude-standard', '-z']);
    const untrackedFiles: Array<{ path: string; type: 'file' | 'symlink'; sha256: string }> = [];
    // Serial reads bound open descriptors; never follow an untracked link into private files/devices.
    for (const relative of untracked.split('\0').filter(Boolean)) {
      const full = path.resolve(root, relative), rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Untracked file escaped repository');
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        untrackedFiles.push({ path: relative, type: 'symlink', sha256: hash(await fs.readlink(full)) });
        continue;
      }
      if (!stat.isFile()) throw new Error(`Approval evidence unavailable: untracked non-regular file ${relative}`);
      const realRoot = await fs.realpath(root), real = await fs.realpath(full), realRelative = path.relative(realRoot, real);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('Untracked file resolves outside repository');
      const handle = await fs.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Untracked file changed during evidence read');
        const digest = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
        untrackedFiles.push({ path: relative, type: 'file', sha256: digest.digest('hex') });
      } finally { await handle.close(); }
    }
    const preview = (value: string) => ({ text: value.slice(0, 48000), truncated: value.length > 48000, sha256: hash(value) });
    capture?.({ diff, workingDiff, stagedDiff, commits });
    return { root, sourceRef, targetRef, source, target, head: head.trim(), status, diff: preview(diff), workingDiff: preview(workingDiff),
      stagedDiff: preview(stagedDiff), untrackedFiles, commits: preview(commits), tests: { status: 'not-collected' as const, reason: 'This Git probe does not collect commit-bound test execution receipts' } };
  }

  async status(repoPath: string, fresh = false): Promise<GitRepoStatus> {
    const root = await this.assertAllowed(repoPath);
    const k = this.key(root);
    if (fresh) { this.statusCache.delete(k); this.statusEpoch++; }

    // TTL 命中：直接回缓存对象（引用稳定，渲染层 memo 生效）
    const cached = this.statusCache.get(k);
    if (cached && Date.now() - cached.atMs < STATUS_TTL_MS) {
      return cached.status;
    }

    // 在途去重：同仓并发调用共享同一 Promise（fs 事件风暴时高频重复调用被合并）
    const epoch = this.statusEpoch;
    const inFlight = this.statusInFlight.get(k);
    if (inFlight) {
      if (inFlight.epoch === epoch) return inFlight.promise;
      // Keep one process per repo; after the stale read finishes, query again.
      await inFlight.promise.catch(() => undefined);
      return this.status(repoPath);
    }

    const p = Promise.resolve().then(async () => {
      try {
        const st = await this.client(root).status();
        const result: GitRepoStatus = {
          branch: st.current ?? 'HEAD',
          tracking: st.tracking ?? null,
          ahead: st.ahead,
          behind: st.behind,
          files: mapFiles(st),
          remoteCheck: this.remoteChecks.get(k)?.identity === JSON.stringify([st.current, st.tracking])
            ? this.remoteChecks.get(k)?.value : undefined
        };
        if (epoch === this.statusEpoch) this.statusCache.set(k, { status: result, atMs: Date.now() });
        return result;
      } finally {
        if (this.statusInFlight.get(k)?.promise === p) this.statusInFlight.delete(k);
      }
    });
    this.statusInFlight.set(k, { promise: p, epoch });
    return p;
  }

  /**
   * 读取 branchHeads（git branch -a），带 refs 目录 mtime 缓存。
   * log 翻页时 branchHeads 几乎不变，避免每页都 spawn 一次。
   */
  private async readBranchHeads(repoPath: string): Promise<GitGraphBranch[]> {
    const k = this.key(repoPath);
    let refsMtimeMs = 0;
    try {
      const st = await fs.stat(path.join(repoPath, '.git', 'refs'));
      refsMtimeMs = st.mtimeMs;
    } catch {
      refsMtimeMs = 0;
    }

    const cached = this.branchHeadsCache.get(k);
    if (cached && cached.refsMtimeMs === refsMtimeMs && refsMtimeMs > 0) {
      return cached.branchHeads;
    }

    let branchHeads: GitGraphBranch[] = [];
    try {
      const br = await this.client(repoPath).branch(['-a']);
      branchHeads = Object.entries(br.branches).map(([name, info]) => ({
        name,
        commit: { sha: info.commit }
      }));
    } catch {
      branchHeads = [];
    }

    if (refsMtimeMs > 0) {
      this.branchHeadsCache.set(k, { refsMtimeMs, branchHeads });
    }
    return branchHeads;
  }

  /**
   * 分页 commit 历史（含 parents），供 commit-graph 渲染。
   * skip/limit 对齐 git log --skip / -n
   */
  async log(
    repoPath: string,
    skip = 0,
    limit = 80,
    ref?: string
  ): Promise<GitLogPage> {
    const root = await this.assertAllowed(repoPath);
    const git = this.client(root);
    const take = Math.min(Math.max(limit, 1), 200);
    const offset = Math.max(skip, 0);

    const pretty = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%s';
    const args = [
      'log',
      '--topo-order',
      `--skip=${offset}`,
      `-n${take + 1}`,
      `--pretty=format:${pretty}`
    ];
    const r = (ref ?? 'HEAD').trim() || 'HEAD';
    if (r === '--all') {
      args.push('--all');
    } else if (r !== 'HEAD') {
      if (r.startsWith('-') || !/^[^\s~^:?*\[\\]+$/.test(r) || r.includes('..')) {
        throw new Error(t('非法历史范围'));
      }
      args.push(r);
    }

    let raw: string;
    try {
      if (r === 'HEAD') {
        // Resolve the history starting point without reading the working tree or index.
        const head = (await git.raw(['rev-parse', '--revs-only', 'HEAD'])).trim();
        if (!head) {
          // rev-parse can also return no revision for a malformed ref. Require a valid symbolic HEAD.
          await git.raw(['symbolic-ref', '--quiet', 'HEAD']);
          return { commits: [], branchHeads: await this.readBranchHeads(root), hasMore: false };
        }
        args.push(head, '--');
      }
      raw = await git.raw(args);
    } catch (err) {
      throw new Error(gitErrMessage(err));
    }

    const lines = String(raw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const hasMore = lines.length > take;
    const slice = hasMore ? lines.slice(0, take) : lines;

    const commits: GitGraphCommit[] = slice.map((line) => {
      const [sha, parents, name, email, date, ...msgParts] = line.split('\x00');
      const message = msgParts.join('\x00');
      return {
        sha: sha || '',
        commit: {
          author: {
            name: name || 'unknown',
            email: email || undefined,
            date: date || new Date().toISOString()
          },
          message: message || ''
        },
        parents: (parents || '')
          .split(' ')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => ({ sha: p }))
      };
    });

    const branchHeads = await this.readBranchHeads(root);

    return { commits, branchHeads, hasMore };
  }

  private assertSha(sha: string): string {
    const s = (sha || '').trim();
    if (!/^[0-9a-fA-F]{7,40}$/.test(s)) throw new Error(t('非法 commit sha'));
    return s;
  }

  async commitFiles(repoPath: string, sha: string): Promise<GitCommitFilesResult> {
    const root = await this.assertAllowed(repoPath);
    const id = this.assertSha(sha);
    const git = this.client(root);
    try {
      let raw = '';
      try {
        raw = await git.raw(['diff-tree', '--no-commit-id', '-r', '--name-status', '-z', id]);
      } catch {
        raw = await git.raw(['show', '--name-status', '--format=', '-z', id]);
      }
      return { sha: id, files: parseNameStatusZ(raw) };
    } catch (err) {
      throw new Error(gitErrMessage(err));
    }
  }

  async commitDiff(
    repoPath: string,
    sha: string,
    filePath: string
  ): Promise<GitCommitDiffResult> {
    const root = await this.assertAllowed(repoPath);
    const id = this.assertSha(sha);
    const rel = filePath.replace(/\\/g, '/');
    if (!rel || rel.includes('\0')) throw new Error(t('非法文件路径'));
    const git = this.client(root);
    try {
      let diff = '';
      try {
        diff = await git.raw(['diff', `${id}^1`, id, '--', rel]);
      } catch {
        // --format= 去掉 commit 头，只留 patch，便于 react-diff-view 解析
        diff = await git.raw(['show', '--format=', '-p', id, '--', rel]);
      }
      return { sha: id, path: rel, diff: diff ?? '' };
    } catch (err) {
      throw new Error(gitErrMessage(err));
    }
  }

  /**
   * 取工作区单文件 diff。
   * @param untracked 由调用方（已持有 status）显式传入，避免主进程再跑一次 git status。
   *                  省略时 fallback 到 `git status --porcelain -- <rel>` 单文件查询，
   *                  比全量 status 便宜得多。
   */
  async diff(
    repoPath: string,
    filePath: string,
    staged = false,
    untracked?: boolean
  ): Promise<GitDiffResult> {
    const root = await this.assertAllowed(repoPath);
    const rel = filePath.replace(/\\/g, '/');
    const git = this.client(root);

    let diff = '';
    try {
      if (staged) {
        diff = await git.diff(['--cached', '--', rel]);
      } else {
        let isUntracked = untracked;
        if (isUntracked === undefined) {
          // 单文件 porcelain 查询，远比全量 status 便宜
          try {
            const out = await git.raw(['status', '--porcelain', '--', rel]);
            const line = String(out || '').trim();
            if (line) {
              const idx = line[0] ?? ' ';
              const wd = line[1] ?? ' ';
              isUntracked = idx === '?' || wd === '?';
            } else {
              isUntracked = false;
            }
          } catch {
            isUntracked = false;
          }
        }
        if (isUntracked) {
          diff = await this.diffUntracked(root, rel);
        } else {
          diff = await git.diff(['--', rel]);
        }
      }
    } catch (err) {
      throw new Error(gitErrMessage(err));
    }

    return { diff: diff ?? '', staged, path: rel };
  }

  /** 未跟踪文件：拼成 unified diff（全部为新增） */
  private async diffUntracked(repoPath: string, rel: string): Promise<string> {
    const abs = path.join(repoPath, rel);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      return '';
    }
    const lines = content.split(/\r?\n/);
    // 去掉末尾空行造成的多余 +
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const body = lines.map((l) => `+${l}`).join('\n');
    const n = lines.length || 1;
    return [
      `diff --git a/${rel} b/${rel}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${rel}`,
      `@@ -0,0 +1,${n} @@`,
      body
    ].join('\n');
  }

  async stage(repoPath: string, paths: string[]): Promise<GitActionResult> {
    const root = await this.assertAllowed(repoPath);
    try {
      await this.client(root).add(paths.map((p) => p.replace(/\\/g, '/')));
      this.invalidateSummary(root);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: gitErrMessage(err) };
    }
  }

  async unstage(repoPath: string, paths: string[]): Promise<GitActionResult> {
    const root = await this.assertAllowed(repoPath);
    try {
      await this.client(root).raw([
        'restore',
        '--staged',
        '--',
        ...paths.map((p) => p.replace(/\\/g, '/'))
      ]);
      this.invalidateSummary(root);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: gitErrMessage(err) };
    }
  }

  async discard(repoPath: string, paths: string[], mode: import('../../shared/types').GitDiscardMode = 'all'): Promise<GitActionResult> {
    const root = await this.assertAllowed(repoPath);
    if (mode !== 'all' && mode !== 'unstaged') return { ok: false, message: t('无效的丢弃范围') };
    const rels = [...new Set(paths.map((p) => p.replace(/\\/g, '/')).filter(Boolean))];
    if (rels.some(p => path.isAbsolute(p) || p.split('/').includes('..') || p.includes('\0'))) {
      return { ok: false, message: t('无效的文件路径') };
    }
    if (!rels.length) return { ok: true };

    const git = this.client(root);
    const errors: string[] = [];

    let status: StatusResult;
    try {
      status = await git.status();
    } catch (err) {
      return { ok: false, message: gitErrMessage(err) };
    }

    const byPath = new Map(
      status.files.map((f) => [f.path.replace(/\\/g, '/'), f] as const)
    );

    const untracked: string[] = [];
    const addedOnly: string[] = [];
    const restoreable: string[] = [];

    for (const rel of rels) {
      const f = byPath.get(rel);
      if (!f) {
        restoreable.push(rel);
        continue;
      }
      // simple-git：未跟踪多为 index/working_dir 均为 '?'
      if (f.index === '?' || f.working_dir === '?') {
        untracked.push(rel);
      } else if (f.index === 'A' && mode === 'all') {
        addedOnly.push(rel);
      } else {
        restoreable.push(rel);
      }
    }

    const unlinkRel = async (rel: string): Promise<void> => {
      const abs = path.join(root, ...rel.split('/'));
      try {
        if (this.operationScope.getStore()) await this.assertAllowed(root);
        await fs.unlink(abs);
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as { code?: string }).code
            : '';
        if (code !== 'ENOENT') errors.push(`${rel}: ${gitErrMessage(err)}`);
      }
    };

    // 并发 unlink：未跟踪/已 add 文件多时，串行 await 显著拖慢
    if (untracked.length) {
      await Promise.all(untracked.map((rel) => unlinkRel(rel)));
    }

    if (addedOnly.length) {
      try {
        await git.raw(['restore', '--staged', '--', ...addedOnly.map(rel => `:(literal)${rel}`)]);
        await Promise.all(addedOnly.map((rel) => unlinkRel(rel)));
      } catch (err) {
        errors.push(gitErrMessage(err));
      }
    }

    if (restoreable.length) {
      try {
        await git.raw(['restore', '--worktree', ...(mode === 'all' ? ['--staged'] : []), '--', ...restoreable.map(rel => `:(literal)${rel}`)]);
      } catch (err) {
        errors.push(gitErrMessage(err));
      }
    }

    // discard 改变了 index/worktree，summary 缓存必须失效
    this.invalidateSummary(root);

    if (errors.length) return { ok: false, message: errors.join('\n') };
    return { ok: true };
  }

  async stageAll(repoPath: string): Promise<GitActionResult> {
    const root = await this.assertAllowed(repoPath);
    try {
      await this.client(root).add(['-A']);
      this.invalidateSummary(root);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: gitErrMessage(err) };
    }
  }

  async commit(repoPath: string, message: string): Promise<GitActionResult> {
    const root = await this.assertAllowed(repoPath);
    const msg = message.trim();
    if (!msg) return { ok: false, message: t('提交说明不能为空') };
    try {
      await this.client(root).commit(msg);
      // commit 改变 HEAD 与 logs/HEAD，summary 与 branchHeads 都需失效
      this.invalidateSummary(root);
      this.branchHeadsCache.delete(this.key(root));
      return { ok: true };
    } catch (err) {
      return { ok: false, message: gitErrMessage(err) };
    }
  }

  async fetch(repoPath: string): Promise<GitActionResult> {
    return this.remoteOp(repoPath, (g) => g.fetch(), 'fetch');
  }

  async pull(repoPath: string): Promise<GitActionResult> {
    return this.remoteOp(repoPath, (g) => g.pull());
  }

  async push(repoPath: string): Promise<GitActionResult> {
    return this.remoteOp(repoPath, (g) => g.push(), 'push');
  }

  /** 推送指定分支并建立上游：开 PR 用（隔离 worktree 分支通常无 upstream，裸 push 会失败） */
  async pushBranch(repoPath: string, branch: string, expected?: { pushUrl: string; head: string; beforePush?: () => void }): Promise<GitActionResult> {
    const name = String(branch ?? '').trim();
    if (
      !name ||
      name.startsWith('-') ||
      name.includes('..') ||
      !/^[^\s~^:?*\[\\]+$/.test(name)
    ) {
      return { ok: false, message: t('非法分支名') };
    }
    return this.remoteOp(repoPath, async (g) => {
      if (expected) {
        const [pushUrl, head, current] = await Promise.all([
          g.raw(['remote', 'get-url', '--push', '--all', 'origin']),
          g.revparse(['HEAD']),
          g.raw(['symbolic-ref', '--short', 'HEAD'])
        ]);
        this.assertOperationScope();
        if (pushUrl.trim() !== expected.pushUrl || head.trim() !== expected.head || current.trim() !== name) {
          throw new Error(t('分支、提交或推送目标已变化，请重新打开 PR 创建表单'));
        }
        if (expected.beforePush) {
          expected.beforePush();
          // The approval is for an immutable commit; a concurrent ref update
          // must never turn this into a push of newly committed work.
          return g.raw(['push', 'origin', `${expected.head}:refs/heads/${name}`]);
        }
      }
      return g.raw(['push', '--set-upstream', 'origin', name]);
    });
  }

  /** Resolve a caller's current checkout without switching to the main worktree. */
  async checkoutForCwd(cwd: string): Promise<string | undefined> {
    const containing = findContainingWorkspace(cwd, this.workspaceRefs());
    let dir = path.resolve(cwd);
    while (true) {
      if (await this.hasGitRoot(dir)) return this.assertAllowed(dir);
      const parent = path.dirname(dir);
      if (dir === parent || (containing && pathKey(dir) === pathKey(path.resolve(containing.path)))) return undefined;
      dir = parent;
    }
  }

  /** Snapshot the effective origin, including Git URL rewriting and pushurl. */
  async githubPrContext(repoPath: string, branch?: string): Promise<{
    origin: string; pushUrl: string; head: string; worktree: boolean;
  }> {
    const root = await this.assertAllowed(repoPath);
    const git = this.client(root);
    const [url, push, identity] = await Promise.all([
      git.raw(['remote', 'get-url', 'origin']).catch(() => ''),
      git.raw(['remote', 'get-url', '--push', '--all', 'origin']).catch(() => ''),
      branch ? this.registeredWorktree(root) : Promise.resolve(null)
    ]);
    let head = '';
    if (branch && identity) {
      const current = (await git.raw(['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
      if (current === branch) head = (await git.revparse(['HEAD'])).trim();
    }
    return { origin: url.trim(), pushUrl: push.trim(), head, worktree: !!identity };
  }

  async listBranches(repoPath: string): Promise<GitBranchList> {
    const root = await this.assertAllowed(repoPath);
    const git = this.client(root);
    const br = await git.branch(['-a']);
    const current = br.current || null;
    const local: GitBranchList['local'] = [];
    const remote: GitBranchList['remote'] = [];

    for (const [ref] of Object.entries(br.branches)) {
      if (ref === 'HEAD') continue;
      if (ref.startsWith('remotes/')) {
        if (ref.endsWith('/HEAD')) continue;
        const remoteRef = ref.replace(/^remotes\//, ''); // origin/foo
        const slash = remoteRef.indexOf('/');
        const localName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
        remote.push({
          name: localName,
          ref,
          remote: remoteRef
        });
      } else {
        local.push({
          name: ref,
          ref,
          current: ref === current
        });
      }
    }

    local.sort((a, b) => {
      if (a.current) return -1;
      if (b.current) return 1;
      return a.name.localeCompare(b.name);
    });
    remote.sort((a, b) => (a.remote ?? a.name).localeCompare(b.remote ?? b.name));

    return { current, local, remote };
  }

  /**
   * 切换 / 新建 / 从远程检出。
   * stashMode: none | stash（仅暂存）| stash-reapply（暂存并在切换后 pop）
   */
  async checkout(repoPath: string, req: GitCheckoutRequest): Promise<GitActionResult> {
    const root = await this.assertAllowed(repoPath);
    const git = this.client(root);
    const name = (req.name || '').trim();
    if (!name) return { ok: false, message: t('分支名不能为空') };
    if (!/^[^\s~^:?*\[\\]+$/.test(name) || name.includes('..')) {
      return { ok: false, message: t('非法分支名') };
    }

    const stashMode = req.stashMode ?? 'none';
    let stashed = false;
    let stashRef: string | undefined;

    try {
      const st = await git.status();
      const dirty = !st.isClean();
      if (dirty && stashMode === 'none') {
        return {
          ok: false,
          message: t('工作区有未提交更改，请选择暂存方式后再切换')
        };
      }
      if (dirty && (stashMode === 'stash' || stashMode === 'stash-reapply')) {
        await git.stash([
          'push',
          '-u',
          '-m',
          `muster-switch-${Date.now()}`
        ]);
        stashed = true;
        stashRef = (await git.raw(['rev-parse', 'refs/stash'])).trim();
      }

      if (req.startPoint) {
        // 远程检出：已有同名本地则直接切；否则 -b 跟踪 startPoint
        const local = await git.branchLocal();
        if (local.all.includes(name)) {
          await git.checkout(name);
        } else {
          await git.checkout(['-b', name, req.startPoint]);
        }
      } else if (req.create) {
        await git.checkoutLocalBranch(name);
      } else {
        await git.checkout(name);
      }

      if (stashed && stashMode === 'stash-reapply') {
        let conflicts: string[] = [];
        try {
          await git.stash(['pop']);
          // simple-git can resolve a stash command whose exit left conflicts.
          conflicts = (await git.status()).conflicted;
          if (conflicts.length) throw new Error(t('存在需要手动解决的冲突'));
        } catch (err) {
          if (!conflicts.length) {
            try { conflicts = (await git.status()).conflicted; } catch { /* Keep the original recovery error. */ }
          }
          return {
            ok: true,
            warning: true,
            stashRef,
            conflicts,
            message: t('已切换到 {{name}}，但恢复临时保存的改动失败：{{error}}', {
              name,
              error: gitErrMessage(err)
            })
          };
        }
      }

      // checkout 改变 HEAD（与可能的工作区文件），summary 与 branchHeads 都需失效
      this.invalidateSummary(root);
      this.branchHeadsCache.delete(this.key(root));
      return { ok: true, message: t('已切换到 {{name}}', { name }) };
    } catch (err) {
      if (stashed) {
        try {
          await git.stash(['pop']);
          if ((await git.status()).conflicted.length) throw new Error(t('存在需要手动解决的冲突'));
        } catch (restoreError) {
          return { ok: false, warning: true, stashRef,
            message: `${gitErrMessage(err)}\n${t('恢复临时保存的改动失败：{{error}}', { error: gitErrMessage(restoreError) })}` };
        }
      }
      return { ok: false, message: gitErrMessage(err) };
    } finally {
      // A failed pop can still change HEAD/index/worktree. Never retain old facts.
      this.invalidateSummary(root);
      this.branchHeadsCache.delete(this.key(root));
    }
  }

  /** fetch/pull/push 等远端操作：refs 变化后失效 summary 与 branchHeads 缓存 */
  private async remoteOp(
    repoPath: string,
    fn: (g: SimpleGit) => Promise<unknown>,
    kind?: 'fetch' | 'push'
  ): Promise<GitActionResult> {
    const root = await this.assertAllowed(repoPath);
    const key = this.key(root);
    let identity: string | undefined;
    const attemptedAt = Date.now();
    try {
      const git = this.client(root);
      if (kind === 'fetch') {
        const st = await git.status();
        identity = JSON.stringify([st.current, st.tracking]);
      }
      const output = await fn(git);
      const completedAt = Date.now();
      if (identity) this.remoteChecks.set(key, { identity, value: { attemptedAt, checkedAt: completedAt } });
      const push = kind === 'push' ? output as PushResult : undefined;
      const pushed = push?.pushed;
      let destination = push?.repo;
      if (destination && /^[a-z][a-z\d+.-]*:\/\//i.test(destination)) {
        // Result details may contain an HTTPS remote with embedded credentials.
        try { const url = new URL(destination); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; destination = url.toString(); }
        catch { destination = destination.replace(/^[^/@\s]+@(?=[^/]+:)/, ''); }
      }
      return { ok: true, remote: { completedAt,
        destination,
        targets: push ? [...(pushed ?? []).map(item => `${item.local} → ${item.remote}`),
          ...(push.update ? [`${push.update.head.local} → ${push.update.head.remote}`] : [])] : undefined,
        unchanged: pushed?.length ? !push?.update && pushed.every(item => item.alreadyUpdated && !item.deleted && !item.new) : undefined } };
    } catch (err) {
      if (identity) {
        const previous = this.remoteChecks.get(key);
        this.remoteChecks.set(key, { identity, value: { attemptedAt,
          checkedAt: previous?.identity === identity ? previous.value.checkedAt : undefined, error: gitErrMessage(err) } });
      }
      return { ok: false, message: gitErrMessage(err) };
    } finally {
      // Even failed network commands can update refs or leave a merge in progress.
      this.invalidateSummary(root);
      this.branchHeadsCache.delete(key);
    }
  }

  // ---------- Worktree（P3.5 轻量版一等公民）----------

  /** `git worktree list --porcelain`（首条为主 worktree） */
  async worktreeList(repoPath: string): Promise<GitWorktreeInfo[]> {
    const root = await this.assertAllowed(repoPath);
    const out = await this.client(root).raw(['worktree', 'list', '--porcelain']);
    return parseWorktreePorcelain(String(out ?? '')).map((e, i) => ({
      ...e,
      main: i === 0
    }));
  }

  /** worktree 根目录：跟主仓所属工作区走，不跟 UI 活动工作区 */
  worktreesRoot(repoPath?: string): string {
    return resolveWorktreesRoot(repoPath || this.workspace(), this.workspaceRefs(), this.config.get().worktreeStorageRoot);
  }

  /**
   * 刷新指定工作区（缺省全部）的全部源根；只更新拓扑快照，不保存授权。
   */
  async refreshRepos(workspaceId?: string): Promise<RepoRefreshResult> {
    const targets = workspaceId === undefined ? this.config.get().workspaces : [requireWorkspace(this.config.get(), workspaceId)];
    const scopes = targets.map(w => this.listScope(w.id));
    const key = JSON.stringify(scopes.map(scope => scope.key));
    const inFlight = this.refreshReposInFlight.get(key);
    if (inFlight) return inFlight;
    const value = this.runRefreshRepos(scopes).finally(() => {
      if (this.refreshReposInFlight.get(key) === value) this.refreshReposInFlight.delete(key);
    });
    this.refreshReposInFlight.set(key, value);
    return value;
  }

  private async runRefreshRepos(scopes: RepoListScope[]): Promise<RepoRefreshResult> {
    const paths = scopes.flatMap(scope => sourceRootsFor(scope.workspace).map(r => r.path));
    await this.discovery.rootsMany(await Promise.all(paths.map(async p => fs.realpath(p).catch(() => path.resolve(p)))), true);
    this.summaryCache.clear();
    const repos = new Set<string>();
    const issues: GitRepoDiscoveryIssue[] = [];
    let issueCount = 0;
    for (const scope of scopes) {
      this.assertListScope(scope);
      // Read the freshly installed topology, rather than joining a summary read
      // that started before the explicit refresh. This does not rescan.
      const result = await this.startListRepos(false, scope);
      for (const repo of result.repos) repos.add(sourcePathKey(repo.path));
      issues.push(...result.issues); issueCount += result.issueCount;
    }
    for (const scope of scopes) this.assertListScope(scope);
    return { ok: true, count: repos.size, workspaceIds: scopes.map(scope => scope.workspace.id), issues: issues.slice(0, 100), issueCount };
  }

  /**
   * 新建 worktree：应用存储根 / 任务短标识 / 仓库名-短标识（不跟 UI 活动区）。
   * 主仓库 .git/info/exclude 追加 /.worktrees/（不碰用户 .gitignore）；
   * 可选 newBranch（isolate 的 ao/<id> 命名空间）或 branch（检出已有分支）。
   */
  async worktreeAdd(repoPath: string, args: GitWorktreeAddArgs): Promise<GitWorktreeAddResult> {
    return this.addWorktreeAt(repoPath, args);
  }

  private async addWorktreeAt(repoPath: string, args: GitWorktreeAddArgs, preparedPath?: string, beforeWrite?: () => Promise<void>, taskId?: string): Promise<GitWorktreeAddResult> {
    const root = await this.assertAllowed(repoPath);
    const identity = await this.repoIdentity(root);
    if (!identity) return { ok: false, message: t('无法确认 worktree 所属仓库，已保留：{{path}}', { path: root }) };
    const dirName = args.dirName?.trim();
    if (!dirName) {
      return { ok: false, message: t('缺少 worktree 目录名（dirName）') };
    }
    if (dirName === '.' || dirName === '..') return { ok: false, message: t('无效的 worktree 目录名') };
    let dir: string;
    try { dir = preparedPath ?? compactWorktreePath(findContainingWorkspace(identity.mainRepo, this.workspaceRefs())?.id ?? sourcePathKey(identity.mainRepo),
      taskId ?? dirName, sourcePathKey(identity.commonDir), identity.mainRepo, this.config.get().worktreeStorageRoot); }
    catch (err) { return { ok: false, message: gitErrMessage(err) }; }
    const branch = args.newBranch ?? args.branch;
    // 实际传给 worktree add 的起点 ref（回传给调用方做溯源/展示）
    const baseBranch = branch ? (args.baseRef ?? (args.newBranch ? 'HEAD' : branch)) : undefined;
    let reservation: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      if (this.operationScope.getStore()) await this.assertAllowed(root);
      await beforeWrite?.();
      // Never adopt even an empty pre-existing destination after a short-key
      // collision. Git's branch creation remains exclusive for concurrent adds.
      try { await fs.lstat(dir); return { ok: false, message: `Worktree destination already exists (possible short ID collision): ${dir}` }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await fs.mkdir(dir); // Atomic exclusive reservation: never reuse another creator's empty tree.
      reservation = await fs.lstat(dir);
      ensureWorktreesExclude(root);
      const gitArgs = ['worktree', 'add'];
      if (args.newBranch) gitArgs.push('-b', args.newBranch);
      gitArgs.push(dir);
      if (baseBranch) gitArgs.push(baseBranch);
      await this.client(root).raw(gitArgs);
    } catch (err) {
      let retained = false;
      if (reservation) {
        try {
          const current = await fs.lstat(dir);
          if (current.dev === reservation.dev && current.ino === reservation.ino) await fs.rmdir(dir);
          else retained = true;
        } catch (cleanupError) {
          // Only remove our still-empty reservation; retain populated/changed trees.
          retained = (cleanupError as NodeJS.ErrnoException).code !== 'ENOENT';
        }
      }
      return { ok: false, message: gitErrMessage(err) + (retained ? `；创建失败后目录已保留，请检查：${dir}` : '') };
    }

    let provisionMsg = '';
    if (args.provisionCommands?.length) {
      provisionMsg = await this.runWorktreeProvision(dir, args.provisionCommands);
    }
    return {
      ok: true,
      path: dir,
      branch: args.newBranch ?? branch,
      baseBranch,
      source: { mainRepo: identity.mainRepo, commonDir: identity.commonDir },
      message: provisionMsg || undefined
    };
  }

  /** 建后 provisioning：在 worktree cwd 依次执行项目级命令（失败不删除 worktree，只报错） */
  async runWorktreeProvision(worktreePath: string, commands: string[], environment?: Record<string, string>, beforeCommand?: () => void): Promise<string> {
    const errors: string[] = [];
    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (!trimmed) continue;
      beforeCommand?.();
      try {
        await execFileAsync(trimmed, {
          cwd: worktreePath,
          env: { ...gitCommandEnvironment(), ...environment },
          shell: true,
          windowsHide: true,
          timeout: 10 * 60_000,
          maxBuffer: 4 * 1024 * 1024
        });
      } catch (err) {
        errors.push(`${trimmed}: ${gitErrMessage(err)}`);
      }
    }
    return errors.length
      ? t('worktree 已创建，但 provision 命令失败：{{errors}}', { errors: errors.join('；') })
      : '';
  }

  /**
   * 删除 worktree。故意不带 --force：脏即失败（错误信息可辨识）；
   * 显式 force 仅用于「放弃改动并清理」确认后的调用。
   */
  async worktreeRemove(worktreePath: string, opts?: { force?: boolean }): Promise<GitActionResult> {
    const root = path.resolve(worktreePath);
    const identity = await this.registeredWorktree(root);
    if (!identity) return { ok: false, message: t('无法确认 worktree 所属仓库，已保留：{{path}}', { path: root }) };
    const mainRepo = identity.mainRepo;
    try {
      if (!opts?.force) {
        const ignored = await this.client(root).raw(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
        if (ignored) return { ok: false, message: t('worktree 有被 Git 忽略的文件，已保留') };
      }
      const args = ['worktree', 'remove'];
      if (opts?.force) args.push('--force');
      args.push(root);
      await this.client(mainRepo).raw(args);
    } catch (err) {
      const raw = gitErrMessage(err);
      const dirtyHint = /dirty|modified|contains/i.test(raw)
        ? t('（worktree 有未提交改动，已跳过清理；可在归档卡片右键「放弃并清理」）')
        : '';
      return { ok: false, message: `${raw}${dirtyHint}` };
    }
    this.clients.delete(this.key(root));
    this.summaryCache.delete(this.key(root));
    this.branchHeadsCache.delete(this.key(root));
    this.statusCache.delete(this.key(root));
    return { ok: true };
  }

  /** `git status --porcelain` 路径列表（中断快照未提交清单）；探测失败返回 null */
  async listUncommittedPaths(worktreePath: string): Promise<string[] | null> {
    try {
      // porcelain 首列是 XY 状态列（' M ' 行首空格是语义），必须原样 stdout——
      // 本仓 simple-git 客户端是 trimmed:true，首行状态列被 trim 会让
      // parsePorcelainPaths 把首个路径错切一位（与 mergeIsolate 修过的同款）
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z'], {
        cwd: path.resolve(worktreePath),
        env: gitCommandEnvironment(),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024
      });
      return parsePorcelainPaths(String(stdout ?? ''));
    } catch {
      return null;
    }
  }

  /** worktree 是否有未提交改动（脏检查） */
  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    try {
      const out = await this.client(path.resolve(worktreePath)).raw(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal']);
      return String(out ?? '').trim().length > 0;
    } catch {
      // 探测失败按脏处理（保守：宁可保留也不误删）
      return true;
    }
  }

  /** dirty 轻探测（新建任务预检提示用）：git 不可用返回 null（未知），不像 isWorktreeDirty 保守按脏 */
  async probeDirty(repoPath: string): Promise<boolean | null> {
    try {
      const out = await this.client(path.resolve(repoPath)).raw(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal']);
      return String(out ?? '').trim().length > 0;
    } catch {
      return null;
    }
  }

  /** Advisory only; the deletion transaction rechecks the registration and the refs. */
  async previewWorktreeRemoval(mainRepo: string, checkout: string, branch: string, target?: string) {
    try {
      const registered = (await this.worktreeList(mainRepo)).some(row => !row.main && row.branch === branch && pathKey(row.path) === pathKey(checkout));
      if (!registered) return 'verify' as const;
      if (await this.probeDirty(checkout) !== false ||
        String(await this.client(checkout).raw(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).length) return 'keep' as const;
      return await this.isBranchMergedIntoDefault(mainRepo, branch, target) ? 'remove-directory-and-branch' as const : 'remove-directory' as const;
    } catch { return 'verify' as const; }
  }

  /**
   * 优先按 .git/gitfile 和 Git 登记信息确认主检出；无 .git 时才向祖先查找。
   * 上探天花板是路径所属工作区（或调用方传入的目标工作区），不是 UI 活动工作区。
   */
  async resolveMainRepoFor(cwd: string, walkCeiling?: string): Promise<string | null> {
    const containing = findContainingWorkspace(cwd, this.workspaceRefs());
    const ceiling = walkCeiling?.trim()
      ? path.resolve(walkCeiling)
      : containing
        ? path.resolve(containing.path)
        : undefined;
    let cur = path.resolve(cwd);
    for (let i = 0; i < 8; i += 1) {
      const gitPath = path.join(cur, '.git');
      try {
        const st = await fs.stat(gitPath);
        if (st.isDirectory() || st.isFile()) {
          const identity = await this.repoIdentity(cur);
          return identity?.mainRepo ?? null;
        }
      } catch {
        /* 无 .git，继续向上 */
      }
      if (
        (ceiling && pathKey(cur) === pathKey(ceiling)) ||
        path.dirname(cur) === cur
      ) {
        return null;
      }
      cur = path.dirname(cur);
    }
    return null;
  }

  /** @deprecated 活动工作区根；隔离树请用目标会话工作区 / worktreesRoot(repo) */
  managedWorkspaceRoot(): string {
    return this.workspace();
  }

  /** ao/* 分支相对默认分支是否已无未合入提交（归档/关闭时决定能否整树清理） */
  async isBranchMergedIntoDefault(mainRepo: string, branch: string, targetBranch?: string): Promise<boolean> {
    const root = await this.assertAllowed(mainRepo);
    return isBranchMergedIntoDefault(root, branch, targetBranch);
  }

  /**
   * 会话隔离 worktree：完整会话身份生成短目录；分支仍为 ao/<id8>（与会话名无关）。
   * base 守卫：主仓 HEAD 停在别的 ao/* 分支（review 残留）或 detached 时改用默认分支——
   * 新任务静默继承旧隔离分支的未合入工作，integrate 时会被一并 merge 进主分支。
   * 结果 baseBranch 上报**实际起点分支名**（守卫回落时=默认分支；正常时=当前分支，
   * worktreeAdd 未显式传 baseRef 只回字面 'HEAD'），供会话记录 worktreeBaseBranch（R-18 从哪建回哪）。
   */
  async addSessionWorktree(
    mainRepo: string,
    sessionId: string,
    provisionCommands?: string[]
  ): Promise<GitWorktreeAddResult> {
    let baseRef: string | undefined;
    const head = await this.readHeadBranch(mainRepo);
    if (!head || head.startsWith('ao/')) {
      baseRef = await resolveDefaultBranch(mainRepo);
    }
    const res = await this.addWorktreeAt(mainRepo, {
      dirName: sessionWorktreeDirName(sessionId),
      newBranch: sessionWorktreeBranch(sessionId),
      baseRef,
      provisionCommands
    }, undefined, undefined, sessionId);
    if (res.ok) {
      // 实际起点分支名：baseRef（守卫回落）优先，否则当时的 HEAD 分支（detached 已被守卫兜住）
      res.baseBranch = baseRef ?? head ?? undefined;
    }
    return res;
  }

  /** 主仓嵌套仓发现（健全 + 残缺跳过清单） */
  async discoverNestedReposDetailedFor(mainRepo: string, options: { includeExcluded?: boolean; includeIgnored?: boolean; workspaceId?: string } = {}): Promise<NestedRepoDiscovery> {
    const root = await this.assertAllowed(mainRepo);
    const enclosing = this.workspaceRefs().map(w => w.path)
      .filter(scope => isPathInsideWorkspace(root, scope));
    await this.discovery.rootsMany(await Promise.all(enclosing.map(async p => fs.realpath(p).catch(() => path.resolve(p)))));
    const physicalRoot = await fs.realpath(root);
    if (options.includeExcluded) return this.discovery.nested(physicalRoot, [], options.includeIgnored);
    const workspace = options.workspaceId ? requireWorkspace(this.config.get(), options.workspaceId)
      : requireWorkspace(this.config.get(), findContainingWorkspace(root, this.workspaceRefs())?.id ?? this.activeWorkspaceId());
    const exclusions = repositoryExclusions(readWorkspaceFile(controlRootFor(workspace), { readonly: true }).git?.worktreeIsolationExclusions ?? []);
    const excludedPaths = await Promise.all(exclusions.flatMap(exclusion => {
      const source = sourceRootsFor(workspace).find(source => source.id === exclusion.rootId);
      return source ? [fs.realpath(source.path).then(physical => path.resolve(physical, exclusion.relativePath)).catch(() => path.resolve(source.path, exclusion.relativePath))] : [];
    }));
    return this.discovery.nested(physicalRoot, excludedPaths, options.includeIgnored);
  }

  /**
   * 多仓隔离组建组（R-18b 嵌套容器）：先建主仓 worktree 作容器根（addSessionWorktree），
   * 再逐嵌套仓按主检出内相对位置嵌进容器（每仓同名分支 ao/<id8>、注册在各仓自身 .git）。
   * repoSet 缺省=自动发现全量健全仓；传了=只含列出的（列不存在的报错；列出但残缺的跳过告警）。
   * 候选全部残缺则失败（不静默当成无嵌套仓）。
   * 任一失败**整组回滚**（嵌套部分由 addNestedWorktrees 自清，这里回收容器根+主分支），
   * 回滚失败时保留容器并报告路径；调用方在失败时抛错、不产生会话行。
   */
  async addSessionWorktreeGroup(
    mainRepo: string,
    sessionId: string,
    repoSet?: string[],
    provisionCommands?: string[]
  ): Promise<GitWorktreeAddGroupResult> {
    const root = await this.assertAllowed(mainRepo);
    const normalized = normalizeRepoSetInput(repoSet);
    if (!normalized.ok) return { ok: false, message: normalized.message };
    let discovery: NestedRepoDiscovery;
    try { discovery = repoSet !== undefined && !normalized.paths.length ? { healthy: [], skipped: [] }
      : await this.discoverNestedReposDetailedFor(root, { includeExcluded: repoSet !== undefined }); }
    catch (error) { return { ok: false, message: gitErrMessage(error) }; }
    const selected = selectHealthyNestedTargets(discovery, repoSet === undefined ? undefined : normalized.paths);
    if (!selected.ok) return { ok: false, message: selected.message };
    if (selected.skipped.length) {
      console.warn('[git]', formatNestedRepoSkipWarning(selected.skipped));
      for (const s of selected.skipped) {
        console.warn('[git] 残缺嵌套仓', s.path, s.reason, s.detail);
      }
    }
    const res = await this.addSessionWorktree(root, sessionId);
    if (!res.ok || !res.path) return res;
    const skipped = selected.skipped.length ? { skippedNestedRepos: selected.skipped } : {};
    if (!selected.targets.length) {
      const message = provisionCommands?.length ? await this.runWorktreeProvision(res.path, provisionCommands) : '';
      return { ...res, repos: [], ...skipped, ...(message ? { message } : {}) };
    }
    const nested = await addNestedWorktrees({
      mainRepo: root,
      sessionId,
      repoRelPaths: selected.targets,
      containerRoot: res.path
    });
    if (!nested.ok) {
      // 整组回滚：嵌套已建部分在 addNestedWorktrees 内自清；这里回收容器根与主分支
      if (nested.rollbackIncomplete) return { ok: false, message: nested.message + '；' + res.path };
      const removed = await this.worktreeRemove(res.path, { force: true });
      if (!removed.ok) return { ok: false, message: [nested.message, removed.message, res.path].join('；') };
      const branch = res.branch ?? sessionWorktreeBranch(sessionId);
      const del = await this.deleteMergedBranch(root, branch, res.baseBranch);
      if (!del.ok) {
        console.warn('[git] 建组回滚删主分支失败（残留可手动清理）', branch, del.message);
      }
      return { ok: false, message: nested.message };
    }
    const message = provisionCommands?.length ? await this.runWorktreeProvision(res.path, provisionCommands) : '';
    return { ...res, repos: nested.repos, ...skipped, ...(message ? { message } : {}) };
  }

  /** Capture an entire group without creating a branch, directory or exclude entry. */
  async prepareSessionWorktreeGroup(mainRepo: string, sessionId: string, repoSet: string[] | undefined, workspaceId: string): Promise<{ plan: PreparedWorktreeGroup; skipped: import('../../shared/types').NestedRepoSkipInfo[] }> {
    requireWorkspace(this.config.get(), workspaceId);
    const root = await this.assertAllowed(mainRepo);
    const normalized = normalizeRepoSetInput(repoSet);
    if (!normalized.ok) throw new Error(normalized.message);
    const discovery = repoSet !== undefined ? await inspectSelectedNestedRepos(root, normalized.paths)
      : await this.discoverNestedReposDetailedFor(root, { workspaceId });
    const selected = selectHealthyNestedTargets(discovery, repoSet === undefined ? undefined : normalized.paths);
    if (!selected.ok) throw new Error(selected.message);
    const identity = await this.repoIdentity(root);
    if (!identity) throw new Error(`cannot resolve source repository: ${root}`);
    const destination = compactWorktreePath(workspaceId, sessionId, sourcePathKey(identity.commonDir), identity.mainRepo, this.config.get().worktreeStorageRoot);
    const plan = await prepareWorktreeGroup(root, sessionId, selected.targets, path.dirname(destination), path.basename(destination));
    this.preparedWorktreeGroups.set(plan, JSON.stringify(plan));
    return { plan, skipped: selected.skipped };
  }

  /** Only a host-prepared, unmodified plan can choose an external destination. */
  async materializeSessionWorktreeGroup(plan: PreparedWorktreeGroup, beforeCreate?: () => Promise<void>): Promise<GitWorktreeAddGroupResult> {
    if (this.preparedWorktreeGroups.get(plan) !== JSON.stringify(plan)) throw new Error('unknown or modified worktree creation plan');
    await beforeCreate?.();
    await assertPreparedWorktreeGroupCurrent(plan);
    const res = await this.addWorktreeAt(plan.main.mainRepo, { dirName: sessionWorktreeDirName(plan.sessionId), newBranch: plan.branch, baseRef: plan.main.baseCommit }, plan.path,
      async () => { await beforeCreate?.(); await assertPreparedWorktreeGroupCurrent(plan); });
    if (!res.ok || !res.path) {
      const creationResiduals = await rollbackPreparedTrees([{ repo: plan.main, path: plan.path, branch: plan.branch, attempted: true }]);
      return { ...res, ...(creationResiduals.length ? { creationResiduals } : {}) };
    }
    res.baseBranch = plan.main.baseBranch;
    const nested = await addNestedWorktrees({ mainRepo: plan.main.mainRepo, sessionId: plan.sessionId,
      repoRelPaths: plan.nested.map(repo => repo.relativePath), containerRoot: res.path,
      prepared: plan.nested, beforeCreate: async () => { await beforeCreate?.(); await assertPreparedWorktreeGroupCurrent(plan); } });
    if (!nested.ok) {
      if (nested.rollbackIncomplete) return { ok: false, message: `${nested.message}；${res.path}`,
        creationResiduals: [...(nested.creationResiduals ?? []), { path: res.path, mainRepo: plan.main.mainRepo, branch: plan.branch, treeRemoved: false, message: 'dependent child was retained' }] };
      const creationResiduals = await rollbackPreparedTrees([{ repo: plan.main, path: res.path, branch: plan.branch }]);
      return { ok: false, message: nested.message, ...(creationResiduals.length ? { creationResiduals } : {}) };
    }
    return { ...res, repos: nested.repos };
  }

  /** 外部直跑纯 git 改动（多仓组合入/清理，不走 service 包装方法）后失效相关仓缓存 */
  invalidateRepoCaches(paths: string[]): void {
    for (const p of paths) {
      const k = this.key(path.resolve(p));
      this.clients.delete(k);
      this.summaryCache.delete(k);
      this.branchHeadsCache.delete(k);
      this.statusCache.delete(k);
    }
  }

  /**
   * 把隔离分支合入主仓目标分支。在主仓 cwd 执行，不进 worktree。
   * 脏 worktree / 与待合入重叠的脏主仓 / 冲突均失败，不产生半成品 merge。
   * 主仓脏但不重叠的文件不拦。第三参兼容旧调用（字符串 = targetBranch）。
   * target 缺省顺序（R-18）：显式 targetBranch ＞ baseBranch（建树起点，从哪建回哪）＞ 默认分支。
   */
  async mergeIsolateBranch(
    worktreePath: string,
    branch: string,
    targetOrOpts?: string | (MergeIsolateOptions & { targetBranch?: string; baseBranch?: string })
  ): Promise<GitMergeIsolateResult> {
    const wt = await this.assertAllowed(worktreePath);
    const mainRepo = await this.resolveMainRepoFor(wt);
    if (!mainRepo) {
      return { ok: false, message: t('找不到 {{path}} 对应的主仓库根', { path: wt }) };
    }
    const extra: MergeIsolateOptions & { targetBranch?: string; baseBranch?: string } =
      typeof targetOrOpts === 'string'
        ? { targetBranch: targetOrOpts }
        : targetOrOpts ?? {};
    const res = await mergeIsolateBranch({
      mainRepo,
      worktreePath: wt,
      branch,
      // Public callers cannot supply the task coordinator's commit/identity callbacks.
      targetBranch: extra.targetBranch,
      baseBranch: extra.baseBranch,
      message: extra.message,
      noFf: extra.noFf,
      stashMain: extra.stashMain,
      skipNpmInstall: extra.skipNpmInstall,
      skipTypecheck: extra.skipTypecheck,
      onGateFail: extra.onGateFail
    });
    if (res.ok) {
      this.invalidateSummary(mainRepo);
      this.invalidateSummary(wt);
    } else if (res.blockReason === 'dirty-overlap' && res.dirtyOverlap?.length) {
      try {
        mergeBlockedListener?.({ mainRepo, branch, files: res.dirtyOverlap });
      } catch (err) {
        console.error('[git] mergeBlocked listener failed', err);
      }
    }
    return res;
  }

  async deleteMergedBranch(mainRepo: string, branch: string, targetBranch?: string): Promise<GitDeleteBranchResult> {
    const root = await this.assertAllowed(mainRepo);
    return deleteMergedBranch(root, branch, targetBranch);
  }

  async deleteBranchForce(mainRepo: string, branch: string): Promise<GitDeleteBranchResult> {
    const root = await this.assertAllowed(mainRepo);
    return deleteBranchForce(root, branch);
  }

  // ---------- Hunk 级原子采纳（T5.5）----------

  private readonly adopter = createAdopter({ resolveIdentity: (root) => this.repoIdentity(root),
    beforeApply: async (repo) => { if (this.operationScope.getStore()) await this.assertAllowed(repo); } });

  /** 部分采纳预览：worktree 相对 merge-base 的完整 diff（临时索引生成，不碰 worktree 树） */
  async adoptPreview(worktreePath: string): Promise<GitAdoptPreviewResult> {
    const wt = await this.assertAllowed(worktreePath);
    return this.adopter.adoptPreview(wt);
  }

  /** 勾选 hunk 原子采纳到主仓（staged 不 commit）；成功后失效主仓缓存 */
  async adoptHunks(worktreePath: string, keys: GitAdoptHunkKey[]): Promise<GitAdoptHunksResult> {
    const wt = await this.assertAllowed(worktreePath);
    const res = await this.adopter.adoptHunks(wt, keys ?? []);
    if (res.ok && res.targetRepo) {
      this.invalidateSummary(res.targetRepo);
      this.branchHeadsCache.delete(this.key(res.targetRepo));
    }
    return res;
  }
}
