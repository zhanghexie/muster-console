/**
 * R-18b 多仓隔离组·嵌套容器：
 * 主仓 worktree 作容器根（应用管理目录下的 `<id8>/`），主仓工作区内的嵌套独立 git 仓
 * 按「主检出内相对位置」镜像嵌进容器（`git -C <嵌套仓> worktree add <容器>/<相对路径> -b ao/<id8>`，
 * 注册在各仓自身 .git）——目录结构与真实工程一致（UE 天然可用），零链接机制；
 * 并发任务各建容器、同仓多 worktree 不同 ao 分支互不冲突（git 自动给同名注册名加序号）。
 *
 * 本模块无 electron 依赖，离线单测走 test/multi-repo-worktree.mjs（真 git fixture）。
 * 发现阶段校验每个候选：`.git/HEAD` 存在且 `git --git-dir=… rev-parse --verify HEAD^{commit}` 成功；
 * 残缺仓跳过告警（不进 repoSet），全部残缺则建组失败（不静默空组）。
 * 工程记账三点（docs/plans/collab-retro-plan.md 链四）：
 * 1. 创建有序（容器根先、嵌套后）+ 任一失败整组回滚（不留半组树/分支）；
 * 2. 组级合入全或无预检（merge-tree --write-tree 冲突预演，git≥2.38；旧版降级跳过预演，
 *    真合小窗口失败按已合/未合清单报告、不自动回滚——人工裁定，见文档边界）；
 * 3. 清理逐仓 remove（嵌套先、容器根后——Windows 目录锁：嵌套树在容器内，
 *    直接删根会连目录一起删但留下悬空注册）+ 删已合入分支（对该仓 base 校验）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type {
  GitRepoIntegrateEntry,
  GitWorktreeCreationResidual,
  MergeIsolateOptions,
  NestedRepoSkipInfo,
  NestedRepoUnhealthyReason,
  WorktreeRepoRef
} from '../../shared/types';
import { t } from '../../shared/i18n';
import { sessionWorktreeBranch, ensureGitDirectoryExcludes } from './worktree';
import { readGitDirectories, resolveRegisteredWorktree } from './repoIdentity';
import { SKIP_DIR_NAMES } from '../workspaceSkipDirs';
import { pathKey } from '../pathKey';
import { filterGitignoreExcludedRepos } from './gitignoreFilter';
import type { PreparedWorktreeRepo } from './worktreeCreatePlan';
import { rollbackPreparedTrees } from './worktreeRollback';
import { filterTaskGitlinkOverlaps, type TaskGitlinkMerge } from './submoduleMergeState';
import { gitCommandArgs, gitCommandEnvironment } from './gitEnvironment';
import {
  deleteMergedBranch,
  deleteBranchForce,
  intersectPaths,
  mergeIsolateBranch,
  parsePorcelainPaths,
  posixPath,
  resolveDefaultBranch
} from './mergeIsolate';

const execFileAsync = promisify(execFile);

const GIT_EXEC_OPTS = {
  windowsHide: true,
  encoding: 'utf8',
  timeout: 60_000,
  maxBuffer: 4 * 1024 * 1024
} as const;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', gitCommandArgs(args), { cwd, ...GIT_EXEC_OPTS, env: gitCommandEnvironment() });
  return String(stdout ?? '').trim();
}

async function gitAllowFail(
  cwd: string,
  args: string[]
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const out = await git(cwd, args);
    return { ok: true, out, err: '' };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    const stdout = typeof err.stdout === 'string' ? err.stdout.trim() : '';
    return { ok: false, out: stdout, err: stderr || String(err.message ?? e) };
  }
}

/** 原样 stdout（不 trim）：porcelain 首行行首空格是 XY 状态列语义，trim 会错切首个路径 */
async function gitAllowFailRaw(
  cwd: string,
  args: string[]
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout } = await execFileAsync('git', gitCommandArgs(args), { cwd, ...GIT_EXEC_OPTS, env: gitCommandEnvironment() });
    return { ok: true, out: String(stdout ?? ''), err: '' };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    return { ok: false, out: stdout, err: stderr || String(err.message ?? e) };
  }
}

/** 带退出码的 git（merge-tree 用 exit 1 区分冲突与错误） */
async function gitCode(
  cwd: string,
  args: string[]
): Promise<{ code: number; out: string; err: string }> {
  try {
    const out = await git(cwd, args);
    return { code: 0, out, err: '' };
  } catch (e) {
    const err = e as { code?: number; stderr?: string; stdout?: string; message?: string };
    return {
      code: typeof err.code === 'number' ? err.code : -1,
      out: typeof err.stdout === 'string' ? err.stdout.trim() : '',
      err: (typeof err.stderr === 'string' ? err.stderr.trim() : '') || String(err.message ?? e)
    };
  }
}

function errMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    if (stderr) return stderr;
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 发现 ----------

/** 扫描跳过的目录名：.git 本体 / 宿主容器根 / 依赖目录 */
const SCAN_SKIP_DIRS = new Set([...SKIP_DIR_NAMES, '.muster']);
/** 嵌套仓发现深度上限（相对主仓根的目录层数） */
export const NESTED_REPO_SCAN_DEPTH = 32;

/** 解析工作树的 git 目录（普通 .git/ 或 gitfile 的 gitdir:） */
export function resolveNestedGitDir(repoAbs: string): string | null {
  return readGitDirectories(repoAbs)?.gitDir ?? null;
}

async function verifyHeadWithGitDir(gitDir: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    // 必须 --git-dir 钉死该仓：缺 HEAD 时 `git -C <残缺仓>` 会向上发现主仓并误报成功。
    // `--verify HEAD` 只要求 SHA 字面可解析，对象丢失仍 exit 0；剥 commit 才核对象库。
    await execFileAsync('git', ['--git-dir', gitDir, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      env: gitCommandEnvironment(),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return { ok: true };
  } catch (e) {
    const err = e as { code?: unknown; stderr?: unknown; message?: string };
    if (err.code === 'ENOENT') {
      // PATH 无 git：HEAD 文件已在则无法核对象，放行（建树路径本身也需要 git）
      return { ok: true };
    }
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    return { ok: false, detail: stderr.trim() || String(err.message ?? e) };
  }
}

/**
 * 嵌套仓健全性：`.git/HEAD` 存在且 `git --git-dir=… rev-parse --verify HEAD^{commit}` 成功。
 * 先查 HEAD 文件再调 git——缺 HEAD 时 git 会把父仓当成仓库（事故：ao/<id8> already exists）。
 * 字面 `rev-parse --verify HEAD` 在对象丢失时仍成功（只回 SHA），必须剥到 commit。
 * 异步执行：逐候选调用在建组/派活的主进程路径上，残缺仓/慢盘/杀软扫描下
 * 同步 execFile 会把 UI 卡到单仓超时上限（15s/仓）。
 */
export async function inspectNestedRepoHealth(
  repoAbs: string
): Promise<{ ok: true } | { ok: false; reason: NestedRepoUnhealthyReason; detail: string }> {
  const gitDir = resolveNestedGitDir(repoAbs);
  if (!gitDir) {
    return { ok: false, reason: 'missing-head', detail: t('.git 无法解析') };
  }
  const headFile = path.join(gitDir, 'HEAD');
  try {
    if (!fs.statSync(headFile).isFile()) {
      return { ok: false, reason: 'missing-head', detail: t('.git/HEAD 缺失') };
    }
  } catch {
    return { ok: false, reason: 'missing-head', detail: t('.git/HEAD 缺失') };
  }
  const verified = await verifyHeadWithGitDir(gitDir);
  if (!verified.ok) {
    return { ok: false, reason: 'lost-objects', detail: verified.detail };
  }
  return { ok: true };
}

export interface NestedRepoDiscovery {
  /** 健全仓（可进 repoSet / 建树） */
  healthy: string[];
  /** 有 .git 但不健全（跳过并告警） */
  skipped: NestedRepoSkipInfo[];
}

/** Explicit selections must not disappear behind a Gitignore-filtered discovery cache. */
export async function inspectSelectedNestedRepos(mainRepo: string, wanted: readonly string[]): Promise<NestedRepoDiscovery> {
  const result: NestedRepoDiscovery = { healthy: [], skipped: [] };
  const root = await fs.promises.realpath(mainRepo);
  const normalized = normalizeRepoSetInput([...wanted]);
  if (!normalized.ok) throw new Error(normalized.message);
  const candidates = new Set(normalized.paths.flatMap(relative => relative.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  for (const relative of candidates) {
    const folder = path.join(root, relative);
    try {
      const physical = await fs.promises.realpath(folder);
      const offset = path.relative(root, physical);
      if (offset === '..' || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) throw new Error('selected nested repository escapes source root');
      await fs.promises.lstat(path.join(folder, '.git'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const health = await inspectNestedRepoHealth(folder);
    if (health.ok) result.healthy.push(relative);
    else result.skipped.push({ path: relative, reason: health.reason, detail: health.detail });
  }
  return result;
}

/**
 * 扫描主仓工作区内的嵌套独立 git 仓（含 .git 目录或 gitfile 的子目录）。
 * 深度上限 NESTED_REPO_SCAN_DEPTH；跳过 .git/.worktrees/node_modules 与符号链接；
 * 主仓 .gitignore（含各级父目录级联）命中的子树不入发现结果（gitignoreFilter，
 * 与 GitRepoDiscoveryCache.nested 的自动隔离语义一致，浏览 roots 保留完整拓扑）；发现嵌套仓后继续异步下钻；
 * 建树父先子后，清理顺序相反。
 * 每个候选做健全性校验（异步 git，不卡主进程）：不健全的进 skipped、不进 healthy。
 * 主仓是否跟踪不区分（嵌套独立仓本就 untracked）。
 */
export async function discoverNestedReposDetailed(
  mainRepo: string,
  opts?: { depth?: number; skipDirs?: Set<string> }
): Promise<NestedRepoDiscovery> {
  const depthMax = opts?.depth ?? NESTED_REPO_SCAN_DEPTH;
  const skip = opts?.skipDirs ?? SCAN_SKIP_DIRS;
  const root = path.resolve(mainRepo);
  const healthy: string[] = [];
  const skipped: NestedRepoSkipInfo[] = [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (skip.has(e.name)) continue;
      const child = path.join(dir, e.name);
      let hasGit = false;
      try {
        const st = await fs.promises.stat(path.join(child, '.git'));
        hasGit = st.isFile() || st.isDirectory();
      } catch {
        hasGit = false;
      }
      if (hasGit) {
        const dirs = readGitDirectories(child);
        if (dirs && pathKey(dirs.gitDir) !== pathKey(dirs.commonDir)) continue;
        const rel = posixPath(path.relative(root, child));
        if (!seen.has(rel)) {
          seen.add(rel);
          candidates.push(child);
        }
      }
      if (depth + 1 < depthMax) await walk(child, depth + 1);
    }
  };
  await walk(root, 0);
  // 主仓自身也要进过滤输入：包围仓判定需要它（范围根永不被过滤，仅作为嵌套仓的规则源）
  const scopeRepos = resolveNestedGitDir(root) ? [root, ...candidates] : candidates;
  for (const child of await filterGitignoreExcludedRepos(root, scopeRepos)) {
    if (pathKey(child) === pathKey(root)) continue;
    const rel = posixPath(path.relative(root, child));
    const health = await inspectNestedRepoHealth(child);
    if (health.ok) healthy.push(rel);
    else skipped.push({ path: rel, reason: health.reason, detail: health.detail });
  }
  healthy.sort();
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { healthy, skipped };
}

export function nestedRepoSkipSymptom(skip: NestedRepoSkipInfo): string {
  if (skip.reason === 'missing-directory') return t('仓库目录已消失');
  if (skip.reason === 'identity-changed') return t('仓库身份已变化，请刷新仓库');
  return skip.reason === 'missing-head' ? t('.git/HEAD 缺失') : t('HEAD 指向丢失对象');
}

export function formatNestedRepoSkipList(skipped: NestedRepoSkipInfo[]): string {
  return skipped
    .map((s) => t('{{repo}}（{{symptom}}）', { repo: s.path, symptom: nestedRepoSkipSymptom(s) }))
    .join('、');
}

/** 部分残缺：跳过并告警（桌面通知 / 日志 / 简报） */
export function formatNestedRepoSkipWarning(skipped: NestedRepoSkipInfo[]): string {
  if (!skipped.length) return '';
  return t('跳过残缺嵌套仓 {{n}} 个：{{list}}。请修复或删除这些仓后再纳入隔离组。', {
    n: skipped.length,
    list: formatNestedRepoSkipList(skipped)
  });
}

/** 候选全残缺：建组失败（不静默当成「无嵌套仓」） */
export function formatAllNestedReposUnhealthyError(skipped: NestedRepoSkipInfo[]): string {
  return t('嵌套仓全部残缺，无法组建隔离组：{{list}}。请修复或删除这些仓后重试。', {
    list: formatNestedRepoSkipList(skipped)
  });
}

/** 容器内嵌套仓 worktree 路径 = 主检出内相对位置的镜像 */
export function nestedWorktreePath(containerRoot: string, relPath: string): string {
  return path.join(containerRoot, ...relPath.split('/').filter(Boolean));
}

/** 嵌套仓主检出的绝对路径 */
export function nestedRepoMainPath(mainRepo: string, relPath: string): string {
  return path.join(mainRepo, ...relPath.split('/').filter(Boolean));
}

/** 组级结果里主仓的 repo 标识（空串） */
export const MAIN_REPO_LABEL = '';

function repoLabel(rel: string): string {
  return rel || t('（主仓）');
}

/**
 * repoSet 入参规整：主仓相对路径列表（分隔符归一 posix、去空去重）。
 * 绝对路径 / 越出主仓（..）非法。调用方须另行保留省略与显式空数组的区别。
 */
export function normalizeRepoSetInput(
  list: unknown
): { ok: true; paths: string[] } | { ok: false; message: string } {
  if (list === undefined || list === null) return { ok: true, paths: [] };
  if (!Array.isArray(list)) return { ok: false, message: t('repoSet 必须是主仓相对路径数组') };
  const out: string[] = [];
  const bad: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) {
      bad.push(String(item));
      continue;
    }
    const rel = posixPath(item.trim()).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!rel || path.isAbsolute(item.trim()) || rel.split('/').includes('..')) {
      bad.push(item.trim());
      continue;
    }
    if (!out.includes(rel)) out.push(rel);
  }
  if (bad.length) {
    return { ok: false, message: t('repoSet 含非法路径（须为主仓相对路径）：{{items}}', { items: bad.join('、') }) };
  }
  return { ok: true, paths: out };
}

// ---------- 建组 ----------

async function readHeadBranch(cwd: string): Promise<string> {
  const out = await gitAllowFail(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return out.ok ? out.out.trim() : '';
}

/** 嵌套仓 base 守卫（同主仓 addSessionWorktree 语义）：detached/ao 残留回落默认分支 */
async function resolveNestedBase(repoMain: string): Promise<{ baseRef?: string; baseBranch?: string }> {
  const head = await readHeadBranch(repoMain);
  if (head && head !== 'HEAD' && !head.startsWith('ao/')) {
    return { baseBranch: head };
  }
  let def = '';
  try {
    def = await resolveDefaultBranch(repoMain);
  } catch {
    def = '';
  }
  return def ? { baseRef: def, baseBranch: def } : {};
}

/**
 * 主仓 common `.git/info/exclude` 追加各嵌套仓相对路径（`/<rel>/`）：
 * 嵌套仓目录在主仓视角是 untracked，不排除会让容器 worktree 恒脏——
 * 零改动过滤与 mergeIsolateBranch 的脏树拒绝全被误触，Worker `git add .` 也会
 * 把插件内容误提交进主仓。git 对 linked worktree 读的是 common dir 的 info/exclude
 * （实测 git 2.54，per-worktree info/exclude 不生效），故主检出同样被隐藏——
 * 主仓本就不跟踪嵌套独立仓，status 更干净是可接受副作用（文档记边界）。
 * 幂等：已包含的行不重复追加。
 */
export function ensureNestedReposExclude(mainRepo: string, relPaths: string[]): void {
  for (const rel of relPaths) {
    const parent = relPaths.filter((p) => rel.startsWith(p + '/'))
      .sort((a, b) => b.length - a.length)[0] ?? '';
    ensureGitDirectoryExcludes(nestedRepoMainPath(mainRepo, parent), [parent ? rel.slice(parent.length + 1) : rel]);
  }
}

export function sortNestedPaths<T extends { path: string }>(repos: readonly T[], deepestFirst = false): T[] {
  return [...repos].sort((a, b) => {
    const depth = a.path.split('/').length - b.path.split('/').length;
    return (deepestFirst ? -depth : depth) || a.path.localeCompare(b.path);
  });
}

/**
 * 逐嵌套仓建树（创建有序：调用方先建好主仓容器根）。任一失败**整组回滚**
 * （已建树 --force 拆除 + 分支 -D 删除，不留半组；容器根由调用方回滚）。
 * 独立仓执行 base 守卫；submodule 起点取父仓 gitlink 的 commit。
 */
export async function addNestedWorktrees(opts: {
  mainRepo: string;
  sessionId: string;
  repoRelPaths: string[];
  containerRoot: string;
  /** Task-wide preflight pins all nested commits before any group is materialized. */
  prepared?: readonly PreparedWorktreeRepo[];
  beforeCreate?: () => Promise<void>;
}): Promise<{ ok: true; repos: WorktreeRepoRef[] } | { ok: false; message: string; rollbackIncomplete?: boolean; creationResiduals?: GitWorktreeCreationResidual[] }> {
  const branch = sessionWorktreeBranch(opts.sessionId);
  const created: WorktreeRepoRef[] = [];
  const createdWts: Array<{ repo: string; worktree: string; attempted?: boolean }> = [];
  const rollback = async () => {
    const creationResiduals = opts.prepared ? await rollbackPreparedTrees(createdWts.map(item => ({
      repo: opts.prepared!.find(repo => repo.relativePath === item.repo)!, path: item.worktree, branch, attempted: item.attempted
    }))) : [];
    const leftovers = opts.prepared ? creationResiduals.map(item => `${item.path}；${item.branch}；${item.message}`)
      : await rollbackNestedWorktrees(opts.mainRepo, branch, createdWts);
    return { creationResiduals, leftovers };
  };
  for (const { path: rel } of sortNestedPaths(opts.repoRelPaths.map((path) => ({ path })))) {
    const repoMain = nestedRepoMainPath(opts.mainRepo, rel);
    const wt = nestedWorktreePath(opts.containerRoot, rel);
    try {
      await opts.beforeCreate?.();
      const parent = created.filter((r) => rel.startsWith(`${r.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? '';
      const localPath = parent ? rel.slice(parent.length + 1) : rel;
      const parentTree = nestedWorktreePath(opts.containerRoot, parent);
      const entry = await git(parentTree, ['ls-tree', 'HEAD', '--', localPath]);
      const pinned = /^160000 commit ([a-f0-9]+)\t/.exec(entry)?.[1];
      const prepared = opts.prepared?.find(repo => repo.relativePath === rel);
      if (opts.prepared && !prepared) throw new Error(`missing prepared nested repository: ${rel}`);
      const dirs = readGitDirectories(repoMain);
      if (prepared && (!dirs || pathKey(dirs.commonDir) !== pathKey(prepared.commonDir))) throw new Error(`nested repository identity changed: ${rel}`);
      const base = prepared ? { baseRef: prepared.baseCommit, baseBranch: prepared.baseBranch } : await resolveNestedBase(repoMain);
      const baseRef = prepared?.baseCommit ?? pinned ?? base.baseRef;
      const baseBranch = base.baseBranch;
      const args = ['worktree', 'add', '-b', branch, wt];
      if (baseRef) args.push(baseRef);
      const attempted = { repo: rel, worktree: wt, attempted: true };
      if (opts.prepared) createdWts.push(attempted);
      await git(repoMain, args);
      if (opts.prepared) attempted.attempted = false;
      else createdWts.push({ repo: rel, worktree: wt });
      const baseCommit = await git(wt, ['rev-parse', 'HEAD']);
      created.push({ path: rel, branch, baseCommit, kind: prepared?.kind ?? (pinned ? 'submodule' : 'independent'), ...(baseBranch ? { baseBranch } : {}) });
    } catch (err) {
      const { leftovers, creationResiduals } = await rollback();
      return {
        ok: false,
        rollbackIncomplete: leftovers.length > 0,
        ...(creationResiduals.length ? { creationResiduals } : {}),
        message: t('嵌套仓 {{repo}} 建树失败: {{error}}', {
          repo: rel,
          error: [errMessage(err), leftovers.length ? t('回滚未完成，已保留容器：{{detail}}', { detail: leftovers.join('；') }) : t('本组已建部分已回滚')].join('；')
        })
      };
    }
  }
  try {
    ensureNestedReposExclude(opts.mainRepo, opts.repoRelPaths);
  } catch (error) {
    const { leftovers, creationResiduals } = await rollback();
    return { ok: false, rollbackIncomplete: leftovers.length > 0, message: [errMessage(error), ...leftovers].join('；'), ...(creationResiduals.length ? { creationResiduals } : {}) };
  }
  return { ok: true, repos: created };
}

/** 建组失败回滚：--force 拆已建树 + 无条件删新建分支（刚从 base 建出，无新工作可丢） */
export async function rollbackNestedWorktrees(
  mainRepo: string,
  branch: string,
  items: Array<{ repo: string; worktree: string }>
): Promise<string[]> {
  const errors: string[] = [];
  for (const it of [...items].sort((a, b) => b.repo.split('/').length - a.repo.split('/').length)) {
    const repoMain = nestedRepoMainPath(mainRepo, it.repo);
    const removed = await gitAllowFail(repoMain, ['worktree', 'remove', '--force', it.worktree]);
    if (!removed.ok) { errors.push(it.worktree + ': ' + removed.err); break; }
    const deleted = await gitAllowFail(repoMain, ['branch', '-D', branch]);
    if (!deleted.ok) errors.push(repoMain + ': ' + deleted.err);
  }
  return errors;
}

// ---------- 零改动双检（负担优化·事后） ----------

/**
 * 零改动双检：树脏（`status --porcelain -uall`）或分支相对 base 有领先提交
 * （`rev-list --count base..branch`）任一非零即「有改动」。只查提交漏「改了没提交」，
 * 只查脏漏「提交后又还原」——双检缺一不可。判不了按有改动处理（宁可多合不漏合）。
 */
export async function isRepoUnchanged(opts: {
  repoMain: string;
  worktreePath: string;
  branch: string;
  baseBranch?: string;
}): Promise<boolean> {
  try {
    const dirty = await git(opts.worktreePath, ['status', '--porcelain', '-uall']);
    if (dirty.trim()) return false;
  } catch {
    return false;
  }
  let base = opts.baseBranch?.trim() || '';
  if (!base) {
    try {
      base = await resolveDefaultBranch(opts.repoMain);
    } catch {
      return false;
    }
  }
  if (!base) return false;
  const ahead = await gitAllowFail(opts.worktreePath, ['rev-list', '--count', `${base}..${opts.branch}`]);
  if (!ahead.ok) return false;
  const n = Number.parseInt(ahead.out, 10);
  return Number.isFinite(n) && n <= 0;
}

// ---------- 组级合入（全或无预检 + 逐仓真合） ----------

let mergeTreeWriteTreeCap: boolean | null = null;
/** NUL name-only section ends at the first empty field; diagnostic messages are not paths. */
export function parseMergeTreeConflictPaths(output: string): string[] {
  const fields = output.split('\0').slice(1);
  const end = fields.indexOf('');
  return [...new Set((end < 0 ? fields : fields.slice(0, end)).filter(Boolean))];
}

export function formatRepoPrecheckFailure(pre: Extract<RepoMergePrecheck, { ok: false }>): string {
  return [pre.message, ...(pre.conflicts ?? []).map(file => `  - ${JSON.stringify(file)}`)].filter(Boolean).join('\n');
}

/** `git merge-tree --write-tree` 需要 git ≥ 2.38；探测一次进程内缓存（同一台机同一 git） */
export async function supportsMergeTreeWriteTree(repo: string): Promise<boolean> {
  if (mergeTreeWriteTreeCap !== null) return mergeTreeWriteTreeCap;
  const r = await gitCode(repo, ['merge-tree', '--write-tree', 'HEAD', 'HEAD']);
  mergeTreeWriteTreeCap = r.code === 0;
  return mergeTreeWriteTreeCap;
}

export type RepoMergePrecheck =
  | { ok: true; alreadyMerged?: boolean }
  | {
      ok: false;
      reason: 'dirty-worktree' | 'dirty-overlap' | 'conflict' | 'error';
      message: string;
      conflicts?: string[];
    };

/**
 * 单仓合入预检（不动任何工作区/引用）：
 * 1) 树脏拒绝（同单仓 merge 语义）；2) 已合入→跳过；
 * 3) 该仓主检出脏文件与待合入重叠拒绝（stashMain 让路，同单仓）；
 * 4) `merge-tree --write-tree` 冲突预演（exit 1=冲突，stdout 首行后为冲突文件）。
 *    预演只往对象库写树对象，工作区/索引/引用零改动（gc 可回收，无观察面）。
 *    git < 2.38 无 merge-tree --write-tree → 跳过冲突预演（降级语义，文档记边界），
 *    本地状态检查（脏/重叠）不受影响。
 */
export async function precheckRepoMerge(opts: {
  repoMain: string;
  worktreePath: string;
  branch: string;
  target: string;
  label: string;
  stashMain?: boolean;
  sourceGitlinks?: readonly TaskGitlinkMerge[];
  sourceCommit?: string;
}): Promise<RepoMergePrecheck> {
  try {
    const dirty = await git(opts.worktreePath, ['status', '--porcelain']);
    if (dirty.trim()) {
      return {
        ok: false,
        reason: 'dirty-worktree',
        message: t('{{repo}}: 隔离树有未提交改动（先在隔离目录提交再合入）', { repo: repoLabel(opts.label) })
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: t('{{repo}}: 状态检查失败 {{error}}', { repo: repoLabel(opts.label), error: errMessage(err) })
    };
  }

  const anc = await gitAllowFail(opts.repoMain, ['merge-base', '--is-ancestor', opts.branch, opts.target]);
  if (anc.ok) return { ok: true, alreadyMerged: true };

  if (!opts.stashMain) {
    const mergeFilesOut = await gitAllowFailRaw(opts.repoMain, [
      'diff',
      '--name-only',
      '-z',
      `${opts.target}...${opts.branch}`
    ]);
    const mergeFiles = mergeFilesOut.out
      ? mergeFilesOut.out.split('\0').map(posixPath).filter(Boolean)
      : [];
    const dirtyOut = await gitAllowFailRaw(opts.repoMain, ['status', '--porcelain', '-z']);
    const dirtyPaths = dirtyOut.ok ? parsePorcelainPaths(dirtyOut.out) : [];
    const overlap = await filterTaskGitlinkOverlaps(opts.repoMain, opts.sourceCommit ?? `refs/heads/${opts.branch}`,
      intersectPaths(dirtyPaths, mergeFiles), opts.sourceGitlinks);
    if (overlap.length) {
      return {
        ok: false,
        reason: 'dirty-overlap',
        conflicts: overlap.slice(0, 20),
        message: t(
          '{{repo}}: 主检出有未提交改动与待合入文件重叠（不是合并冲突）。重叠 {{count}} 个：{{files}}。请提交/挪开，或传 stashMain:true 让路',
          { repo: repoLabel(opts.label), count: overlap.length, files: overlap.slice(0, 20).join('、') }
        )
      };
    }
  }

  if (await supportsMergeTreeWriteTree(opts.repoMain)) {
    const mt = await gitCode(opts.repoMain, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '-z',
      opts.target,
      opts.branch
    ]);
    if (mt.code === 1) {
      const conflicts = parseMergeTreeConflictPaths(mt.out).slice(0, 20);
      return {
        ok: false,
        reason: 'conflict',
        conflicts,
        message: t('{{repo}}: 合入 {{target}} 有冲突（{{count}} 个：{{files}}）', {
          repo: repoLabel(opts.label),
          target: opts.target,
          count: conflicts.length,
          files: conflicts.slice(0, 20).join('、')
        })
      };
    }
    if (mt.code !== 0) {
      return {
        ok: false,
        reason: 'error',
        message: t('{{repo}}: 冲突预演失败 {{error}}', { repo: repoLabel(opts.label), error: mt.err })
      };
    }
  }
  return { ok: true };
}

export interface IntegrateRepoGroupOpts {
  mainRepo: string;
  containerRoot: string;
  mainBranch: string;
  mainBaseBranch?: string;
  repos: WorktreeRepoRef[];
  merge?: MergeIsolateOptions & { targetBranch?: string };
}

export interface IntegrateRepoGroupResult {
  ok: boolean;
  /** 逐仓清单（含主仓 repo=''；按嵌套在前、主仓殿后的固定顺序） */
  entries: GitRepoIntegrateEntry[];
  message: string;
}

interface GroupItem {
  label: string;
  repoMain: string;
  worktree: string;
  branch: string;
  baseBranch?: string;
}

/**
 * 组级合入：
 * 1) 零改动过滤——逐仓双检（脏+领先提交）皆零的仓排除出合入与验收；
 * 2) 全或无预检——待合仓逐个预检（脏树/脏重叠/merge-tree 冲突预演），任一失败
 *    **整组拒绝**（错误列阻断仓+文件），全部仓零改动；
 * 3) 逐仓真合——嵌套先、主仓后（主仓可能引用嵌套产物），target 对称=各自 base
 *    （显式 targetBranch 对每仓生效，该仓缺此分支则整组拒）；
 *    预检后真合失败的小窗口：**不自动回滚已合仓**（误 reset 比残留更危险），
 *    停止后续合入并报告已合/未合清单，人工裁定后重试（已合仓重试按已合入跳过）；
 * 4) 仓级闸（install/typecheck）一期只在主仓跑（嵌套仓不 provision 闸，文档记边界）。
 */
export async function integrateRepoGroup(opts: IntegrateRepoGroupOpts): Promise<IntegrateRepoGroupResult> {
  const items: GroupItem[] = [
    ...sortNestedPaths(opts.repos, true).map((r) => ({
      label: r.path,
      repoMain: nestedRepoMainPath(opts.mainRepo, r.path),
      worktree: nestedWorktreePath(opts.containerRoot, r.path),
      branch: r.branch,
      ...(r.baseBranch ? { baseBranch: r.baseBranch } : {})
    })),
    {
      label: MAIN_REPO_LABEL,
      repoMain: opts.mainRepo,
      worktree: opts.containerRoot,
      branch: opts.mainBranch,
      ...(opts.mainBaseBranch ? { baseBranch: opts.mainBaseBranch } : {})
    }
  ];
  const explicitTarget = opts.merge?.targetBranch?.trim() || '';
  const statusByRepo = new Map<string, GitRepoIntegrateEntry>();
  const entryOf = (it: GroupItem): GitRepoIntegrateEntry => {
    const cur = statusByRepo.get(it.label);
    if (cur) return cur;
    const fresh: GitRepoIntegrateEntry = { repo: it.label, branch: it.branch, status: 'blocked' };
    statusByRepo.set(it.label, fresh);
    return fresh;
  };
  const assemble = (finalEntries: GitRepoIntegrateEntry[]): GitRepoIntegrateEntry[] => {
    // 固定顺序输出：嵌套（声明序）在前、主仓殿后
    const byRepo = new Map(finalEntries.map((e) => [e.repo, e]));
    return items.map((it) => byRepo.get(it.label) ?? entryOf(it));
  };

  for (const item of items) {
    const identity = await resolveRegisteredWorktree(item.worktree, [item.repoMain]);
    const source = readGitDirectories(item.repoMain);
    const current = await readHeadBranch(item.worktree);
    if (!identity || !source || pathKey(identity.commonDir) !== pathKey(source.commonDir) || current !== item.branch) {
      return { ok: false, entries: items.map((it) => ({ repo: it.label, branch: it.branch, status: 'blocked' as const })),
        message: t('无法确认 worktree 所属仓库，已保留：{{path}}', { path: item.worktree }) };
    }
  }

  // 1) 零改动过滤
  const toMerge: GroupItem[] = [];
  for (const it of items) {
    const unchanged = await isRepoUnchanged({
      repoMain: it.repoMain,
      worktreePath: it.worktree,
      branch: it.branch,
      ...(it.baseBranch ? { baseBranch: it.baseBranch } : {})
    });
    if (unchanged) {
      statusByRepo.set(it.label, {
        repo: it.label,
        branch: it.branch,
        status: 'skipped-unchanged',
        message: t('零改动（无脏文件、无领先提交），排除出合入与验收')
      });
      continue;
    }
    toMerge.push(it);
  }

  // 2) 全或无预检
  interface Prechecked {
    it: GroupItem;
    target: string;
    alreadyMerged: boolean;
  }
  const prechecked: Prechecked[] = [];
  const preflightFailures: Extract<RepoMergePrecheck, { ok: false }>[] = [];
  for (const it of toMerge) {
    let target = explicitTarget;
    if (!target) {
      target = it.baseBranch?.trim() || '';
      if (!target) {
        try {
          target = await resolveDefaultBranch(it.repoMain);
        } catch {
          target = '';
        }
      }
    }
    if (!target) {
      const failed: GitRepoIntegrateEntry[] = [
        ...[...statusByRepo.values()],
        { repo: it.label, branch: it.branch, status: 'failed', message: t('无法解析合入目标分支') }
      ];
      return {
        ok: false,
        entries: assemble(failed),
        message: t('{{repo}}: 无法解析合入目标分支（既无 base 记录也无默认分支），整组拒绝、零改动', {
          repo: repoLabel(it.label)
        })
      };
    }
    if (explicitTarget) {
      const verify = await gitAllowFail(it.repoMain, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${explicitTarget}`
      ]);
      if (!verify.ok) {
        const failed: GitRepoIntegrateEntry[] = [
          ...[...statusByRepo.values()],
          {
            repo: it.label,
            branch: it.branch,
            status: 'failed',
            message: t('该仓没有分支 {{target}}，显式 target 对每仓生效、整组拒绝', { target: explicitTarget })
          }
        ];
        return {
          ok: false,
          entries: assemble(failed),
          message: t('{{repo}}: 没有分支 {{target}}（显式 target 对每仓生效），整组拒绝、零改动', {
            repo: repoLabel(it.label),
            target: explicitTarget
          })
        };
      }
    }
    // RED-PROBE 移除（验证记录见 docs/journal/2026-09-21.md）
    const pre: RepoMergePrecheck = await precheckRepoMerge({
      repoMain: it.repoMain,
      worktreePath: it.worktree,
      branch: it.branch,
      target,
      label: it.label,
      stashMain: opts.merge?.stashMain
    });
    if (!pre.ok) {
      statusByRepo.set(it.label, { repo: it.label, branch: it.branch, target, status: 'failed',
        message: pre.message, ...(pre.conflicts?.length ? { conflicts: pre.conflicts } : {}) });
      preflightFailures.push(pre);
      continue;
    }
    prechecked.push({ it, target, alreadyMerged: pre.alreadyMerged === true });
  }

  if (preflightFailures.length) {
    return { ok: false, entries: assemble([...statusByRepo.values()]),
      message: t('多仓组全或无预检失败：\n{{reports}}\n整组拒绝合入，全部仓零改动；请在隔离分支解决后重试',
        { reports: preflightFailures.map(formatRepoPrecheckFailure).join('\n\n') }) };
  }

  // 3) 逐仓真合：嵌套先、主仓后
  const mergedLabels: string[] = [];
  for (const p of prechecked) {
    const isMain = p.it.label === MAIN_REPO_LABEL;
    if (p.alreadyMerged) {
      statusByRepo.set(p.it.label, {
        repo: p.it.label,
        branch: p.it.branch,
        target: p.target,
        status: 'already-merged',
        message: t('已在 {{target}} 上，无需再 merge', { target: p.target })
      });
      continue;
    }
    const res = await mergeIsolateBranch({
      mainRepo: p.it.repoMain,
      worktreePath: p.it.worktree,
      branch: p.it.branch,
      targetBranch: p.target,
      ...(p.it.baseBranch ? { baseBranch: p.it.baseBranch } : {}),
      ...(opts.merge?.message?.trim() ? { message: opts.merge.message } : {}),
      noFf: opts.merge?.noFf,
      stashMain: opts.merge?.stashMain,
      // 一期简化：仓级闸只在主仓跑；嵌套仓显式跳过
      skipNpmInstall: isMain ? opts.merge?.skipNpmInstall : true,
      skipTypecheck: isMain ? opts.merge?.skipTypecheck : true,
      onGateFail: opts.merge?.onGateFail
    });
    if (!res.ok) {
      const pending = prechecked
        .filter((x) => x !== p && !mergedLabels.includes(x.it.label) && !statusByRepo.get(x.it.label))
        .map(
          (x): GitRepoIntegrateEntry => ({
            repo: x.it.label,
            branch: x.it.branch,
            target: x.target,
            status: 'blocked',
            message: t('前序仓真合失败，停止后续合入（不自动回滚）')
          })
        );
      const failed: GitRepoIntegrateEntry[] = [
        ...[...statusByRepo.values()],
        {
          repo: p.it.label,
          branch: p.it.branch,
          target: res.target ?? p.target,
          status: 'failed',
          message: res.message,
          ...(res.conflicts?.length ? { conflicts: res.conflicts } : {})
        },
        ...pending
      ];
      return {
        ok: false,
        entries: assemble(failed),
        message: t(
          '{{repo}} 真合失败（预检后小窗口，概率极小）：{{error}}。已合入：{{merged}}；未合：{{pending}}。不自动回滚已合仓——请人工裁定后重试（已合仓重试会按已合入跳过）',
          {
            repo: repoLabel(p.it.label),
            error: res.message,
            merged: mergedLabels.length ? mergedLabels.map(repoLabel).join('、') : t('无'),
            pending: pending.length ? pending.map((x) => repoLabel(x.repo)).join('、') : t('无')
          }
        )
      };
    }
    mergedLabels.push(p.it.label);
    statusByRepo.set(p.it.label, {
      repo: p.it.label,
      branch: p.it.branch,
      target: res.target,
      status: res.alreadyMerged ? 'already-merged' : 'merged',
      ...(res.message ? { message: res.message } : {}),
      ...(res.warnings?.length ? { message: res.warnings.join(' ') } : {})
    });
  }

  const entries = assemble([...statusByRepo.values()]);
  const skipped = entries.filter((e) => e.status === 'skipped-unchanged').length;
  const mergedCount = entries.filter((e) => e.status === 'merged' || e.status === 'already-merged').length;
  return {
    ok: true,
    entries,
    message: t('多仓组合入完成：{{merged}} 个仓已合入、{{skipped}} 个零改动仓跳过（主仓+{{nested}} 嵌套仓）', {
      merged: mergedCount,
      skipped,
      nested: opts.repos.length
    })
  };
}

// ---------- 逐仓清理 ----------

export interface NestedCleanupEntry {
  repo: string;
  removed: boolean;
  kept?: 'dirty' | 'unmerged' | 'error';
  message?: string;
  safeToRemove?: boolean;
}

/** 逐仓拆树前的 Windows 锁释放重试节奏（对齐 sessions 的 WORKTREE_RELEASE_DELAYS_MS） */
const REMOVE_RETRY_DELAYS_MS = [0, 600, 1600];

/**
 * 单个嵌套仓的归档/删除清理：树脏或分支未合入（对该仓 base/target 校验，不是默认分支）
 * → 保留；干净已合入 → `worktree remove` + 删已合入分支。目录不存在时 prune 注册并视为已清。
 * force=true（「放弃并清理」确认后）：跳过脏/未合入保留判断强拆树，分支仍只删已合入
 * （未合入分支保留并在 message 说明，与单仓 discardWorktree 语义一致）。
 */
export async function cleanupNestedWorktree(opts: {
  mainRepo: string;
  repo: string;
  containerRoot: string;
  branch: string;
  baseBranch?: string;
  targetBranch?: string;
  force?: boolean;
  forceBranch?: boolean;
  checkOnly?: boolean;
  ownedChildren?: string[];
}): Promise<NestedCleanupEntry> {
  const repoMain = nestedRepoMainPath(opts.mainRepo, opts.repo);
  const wt = nestedWorktreePath(opts.containerRoot, opts.repo);
  const base = { repo: opts.repo, removed: false } as NestedCleanupEntry;
  const link = await gitAllowFail(path.dirname(wt), ['ls-files', '--stage', '--', path.basename(wt)]);
  const isGitlink = link.ok && /^160000 /.test(link.out);
  if (isGitlink && fs.existsSync(wt) && fs.readdirSync(wt).length === 0) {
    const listed = await gitAllowFail(repoMain, ['worktree', 'list', '--porcelain', '-z']);
    if (listed.ok && !listed.out.split('\0').some((field) => field.startsWith('worktree ') && pathKey(field.slice(9)) === pathKey(wt))) {
      if (opts.forceBranch) {
        const del = await deleteBranchForce(repoMain, opts.branch);
        if (!del.ok) return { repo: opts.repo, removed: false, kept: 'error', message: del.message };
      }
      return { repo: opts.repo, removed: true };
    }
  }

  if (!fs.existsSync(wt)) {
    // 容器/嵌套树已被外部删除：清悬空注册（幂等）
    if (opts.checkOnly) return { repo: opts.repo, removed: true };
    const pruned = await gitAllowFail(repoMain, ['worktree', 'prune']);
    if (!pruned.ok) return { ...base, kept: 'error', message: pruned.err };
    if (opts.forceBranch) {
      const del = await deleteBranchForce(repoMain, opts.branch);
      if (!del.ok) return { ...base, kept: 'error', message: del.message };
    }
    return { repo: opts.repo, removed: true, message: t('树已不存在，已 prune 悬空注册') };
  }

  const identity = await resolveRegisteredWorktree(wt, [repoMain]);
  const sourceDirs = readGitDirectories(repoMain);
  if (!identity || !sourceDirs || pathKey(identity.commonDir) !== pathKey(sourceDirs.commonDir) || (await readHeadBranch(wt)) !== opts.branch) {
    return { ...base, kept: 'error', message: t('无法确认 worktree 所属仓库，已保留：{{path}}', { path: wt }) };
  }

  if (!opts.force) {
    try {
      const dirty = await git(wt, ['status', '--porcelain']);
      if (dirty.trim()) {
        return { ...base, kept: 'dirty', message: t('有未提交改动，保留') };
      }
      const ignored = (await git(wt, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      const inside = (file: string, parent: string) => {
        const relative = path.relative(pathKey(parent), pathKey(file));
        return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
      };
      if (ignored.some(file => !(opts.ownedChildren ?? []).some(child => inside(path.resolve(wt, file), child)))) {
        return { ...base, kept: 'dirty', message: t('worktree 有被 Git 忽略的文件，已保留') };
      }
    } catch (err) {
      return { ...base, kept: 'error', message: errMessage(err) };
    }

    let target = opts.targetBranch?.trim() || opts.baseBranch?.trim() || '';
    if (!target) {
      try {
        target = await resolveDefaultBranch(repoMain);
      } catch {
        target = '';
      }
    }
    if (!target) return { ...base, kept: 'error', message: t('无法确认合入目标，已保留 worktree') };
    if (target) {
      const anc = await gitAllowFail(repoMain, ['merge-base', '--is-ancestor', opts.branch, target]);
      if (!anc.ok) {
        return {
          ...base,
          kept: 'unmerged',
          message: t('分支 {{branch}} 相对 {{target}} 有未合入提交，保留', { branch: opts.branch, target })
        };
      }
    }
  }

  if (opts.checkOnly) return { ...base, safeToRemove: true };

  let lastErr = '';
  for (const ms of REMOVE_RETRY_DELAYS_MS) {
    if (ms) await sleep(ms);
    if (!fs.existsSync(wt)) break;
    const rm = await gitAllowFail(repoMain, [
      'worktree',
      'remove',
      ...(opts.force ? ['--force'] : []),
      wt
    ]);
    if (rm.ok) {
      lastErr = '';
      break;
    }
    lastErr = rm.err;
  }
  if (fs.existsSync(wt)) {
    return { ...base, kept: 'error', message: lastErr || t('worktree remove 失败') };
  }
  // Empty gitlink directories represent an uninitialized submodule; absence reads as a deletion.
  if (isGitlink) await fs.promises.mkdir(wt, { recursive: true });
  const del = opts.forceBranch
    ? await deleteBranchForce(repoMain, opts.branch)
    : await deleteMergedBranch(repoMain, opts.branch, opts.targetBranch ?? opts.baseBranch);
  return {
    repo: opts.repo,
    removed: true,
    ...(del.ok ? {} : { kept: 'error' as const, message: t('分支 {{branch}} 未删（{{reason}}）', { branch: opts.branch, reason: del.message ?? '' }) })
  };
}

/** 容器根丢失后的兜底：逐嵌套仓 prune 悬空注册（heal 路径用） */
export async function pruneNestedWorktrees(mainRepo: string, relPaths: string[]): Promise<void> {
  for (const rel of relPaths) {
    await gitAllowFail(nestedRepoMainPath(mainRepo, rel), ['worktree', 'prune']);
  }
}

// ---------- 事前提示（负担优化·事前） ----------

/**
 * repoSet 与发现清单的匹配（Windows 大小写不敏感）：命中项改用发现清单的拼写
 * （路径拼接以真实大小写为准），未命中项原样返回（调用方报错）。
 */
export function matchRepoSetToDiscovered(
  wanted: string[],
  discovered: string[]
): { matched: string[]; missing: string[] } {
  const byLower = new Map(discovered.map((p) => [p.toLowerCase(), p]));
  const matched: string[] = [];
  const missing: string[] = [];
  for (const w of wanted) {
    const hit = byLower.get(w.toLowerCase());
    if (hit !== undefined && !matched.includes(hit)) matched.push(hit);
    else if (hit === undefined) missing.push(w);
  }
  return { matched, missing };
}

export type SelectHealthyNestedResult =
  | { ok: true; targets: string[]; skipped: NestedRepoSkipInfo[] }
  | { ok: false; message: string; skipped: NestedRepoSkipInfo[] };

/**
 * 从发现结果里挑可建树的嵌套仓。
 * wanted 省略 = 自动全量健全仓；空数组 = 仅主仓。非空 repoSet 先按发现清单匹配，
 * 再把残缺项剔除。全部候选残缺 → 失败（不静默空组）；磁盘上零嵌套仓 → 成功、targets=[]。
 */
export function selectHealthyNestedTargets(
  discovery: NestedRepoDiscovery,
  wanted?: string[]
): SelectHealthyNestedResult {
  if (wanted !== undefined && !wanted.length) return { ok: true, targets: [], skipped: [] };
  const brokenAncestor = discovery.skipped.find((bad) => discovery.healthy.some((p) => p.startsWith(bad.path + '/')));
  if (brokenAncestor) return { ok: false, skipped: discovery.skipped, message: formatAllNestedReposUnhealthyError([brokenAncestor]) };
  const allPaths = [...discovery.healthy, ...discovery.skipped.map((s) => s.path)];
  const skippedByLower = new Map(discovery.skipped.map((s) => [s.path.toLowerCase(), s]));

  if (wanted !== undefined) {
    const { matched, missing } = matchRepoSetToDiscovered(wanted, allPaths);
    if (missing.length) {
      return {
        ok: false,
        skipped: discovery.skipped,
        message: t('repoSet 列出的嵌套仓不存在：{{missing}}（主仓内发现的嵌套仓：{{found}}）', {
          missing: missing.join('、'),
          found: allPaths.length ? allPaths.join('、') : t('无')
        })
      };
    }
    const targets: string[] = [];
    const skippedFromWanted: NestedRepoSkipInfo[] = [];
    for (const p of matched) {
      const bad = skippedByLower.get(p.toLowerCase());
      if (bad) skippedFromWanted.push({ ...bad, path: p });
      else targets.push(p);
    }
    if (!targets.length) {
      return {
        ok: false,
        skipped: skippedFromWanted,
        message: formatAllNestedReposUnhealthyError(skippedFromWanted)
      };
    }
    const withAncestors = discovery.healthy.filter((p) => targets.some((t) => t === p || t.startsWith(p + '/')));
    return { ok: true, targets: withAncestors, skipped: discovery.skipped };
  }

  if (!discovery.healthy.length && discovery.skipped.length) {
    return {
      ok: false,
      skipped: discovery.skipped,
      message: formatAllNestedReposUnhealthyError(discovery.skipped)
    };
  }
  return { ok: true, targets: discovery.healthy, skipped: discovery.skipped };
}

function shortRepoList(paths: string[]): string {
  return paths.length <= 6 ? paths.join('、') : t('{{n}} 个', { n: paths.length });
}

/** 派活简报列明隔离容器内的嵌套仓；显式 repoSet 控制范围。 */
export function buildNestedRepoBriefNote(input: { repoSet?: string[]; discovered: string[] }): string {
  const container = input.repoSet ?? input.discovered;
  if (!container.length) return '';
  if (input.repoSet?.length) {
    return t('本次隔离容器含指定插件仓：{{list}}', { list: shortRepoList(container) });
  }
  return t(
    '隔离容器含全部 {{n}} 个嵌套仓：{{list}}（跨插件任务可用 sessions.create 的 repoSet 声明预计涉及范围）',
    { n: container.length, list: shortRepoList(container) }
  );
}
