import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionMeta, SessionWorktreeGroup, SessionWorktreeRepoCleanupResult } from '../../shared/types';
import { formatNotifyText } from '../../shared/types';
import { clearSessionWorktreeMetadata, sessionWorktreeGroups } from '../../shared/sessionWorktrees';
import { t } from '../../shared/i18n';
import { pathKey } from '../pathKey';
import { controlRootFor, requireSourceRoot, requireWorkspace, sourceRootsFor } from '../workspacePaths';
import { workspaceRootUsesFor } from '../workspaceRootUses';
import { readGitDirectories } from './repoIdentity';
import { nestedRepoMainPath, nestedWorktreePath, sortNestedPaths } from './nestedRepos';
import { resolveDefaultBranch } from './mergeIsolate';
import { beginTaskWorktreeOperation, taskWorktreeOwnership } from './worktreeTaskOperation';
import type { SessionWorktreeCtx } from './worktreeSessionOps';
import { gitCommandEnvironment } from './gitEnvironment';
import { worktreeSessionReferences } from '../storage/sessionDependencies';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: gitCommandEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}
function physical(folder: string): string {
  if (!fs.statSync(folder).isDirectory()) throw new Error(`not a directory: ${folder}`);
  return pathKey(fs.realpathSync(folder));
}
function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
/** Resolve the existing parent even when an externally removed checkout has no gitfile. */
function anchoredPath(folder: string): string {
  let ancestor = path.resolve(folder);
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  return pathKey(path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, folder)));
}
function available(gitDir: string): void {
  for (const marker of ['locked', 'index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    if (fs.existsSync(path.join(gitDir, marker))) throw new Error(`repository has an active Git operation: ${marker}`);
  }
}
function reason(error: unknown): string {
  return String((error as { stderr?: string })?.stderr || (error as Error)?.message || error).trim().slice(-4000);
}
function displayReason(message: string): string {
  if (message === 'task checkout has uncommitted changes') return t('worktree 有未提交改动，已保留');
  if (message === 'task checkout has ignored files') return t('worktree 有被 Git 忽略的文件，已保留');
  if (message === 'task branch has unmerged commits') return t('分支有未合入提交，已保留');
  if (message === 'unregistered task branch ownership cannot be verified') return t('无法确认未登记分支的归属，已保留');
  if (message === 'confirmed directory identity or source scope changed' || message === 'confirmed directory identity changed') return t('目录身份已变化，请重新检查。');
  if (message === 'worktree registration appeared after confirmation') return t('该目录仍有 Git worktree 登记，请使用普通清理。');
  if (message === 'unregistered directory contains a nested Git repository') return t('目录内包含其他 Git 仓库，已停止强制清理。');
  if (message === 'task checkout is still used by another session') return t('此 worktree 仍被其他会话引用，已保留。');
  return message;
}
function records(raw: string): string[][] { return raw.split('\0\0').filter(Boolean).map(record => record.split('\0')); }
function atPath(fields: string[], folder: string): boolean {
  return fields.some(field => field.startsWith('worktree ') && pathKey(field.slice(9)) === pathKey(folder));
}

/** Never recursively remove an unknown nested Git checkout or repository. */
async function assertNoNestedGit(folder: string): Promise<void> {
  const pending = [folder];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === '.git') throw new Error('unregistered directory contains a nested Git repository');
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(current, entry.name));
    }
  }
}

interface Item {
  group: SessionWorktreeGroup;
  repo: string;
  tree: string;
  main: string;
  branch: string;
  baseBranch?: string;
  common?: string;
  sourceGitDir?: string;
  sourcePhysical?: string;
  privateGitDir?: string;
  registered?: boolean;
  exists?: boolean;
  head?: string;
  targetHead?: string;
  gitlinkParent?: Item;
  previous?: SessionWorktreeRepoCleanupResult;
  detachedBranch?: 'unverified' | 'unmerged';
  forceUnregistered?: { dev: number; ino: number; mtimeMs: number };
  entry: SessionWorktreeRepoCleanupResult;
}

/** A missing directory is not authority to prune other sessions' registrations. */
function registeredPrivateDirectory(item: Item): string {
  const root = path.join(item.common!, 'worktrees');
  const matches = fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory() || fs.lstatSync(dir).isSymbolicLink()) return [];
    try {
      const back = path.resolve(dir, fs.readFileSync(path.join(dir, 'gitdir'), 'utf8').trim());
      const common = path.resolve(dir, fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim());
      return anchoredPath(back) === anchoredPath(path.join(item.tree, '.git')) && physical(common) === item.common ? [physical(dir)] : [];
    } catch { return []; }
  });
  if (matches.length !== 1) throw new Error('missing task registration cannot be verified');
  return matches[0]!;
}

/** Verify target and compare-delete task ref in one Git transaction. */
async function deleteMergedRef(item: Item): Promise<void> {
  const input = `start\nverify refs/heads/${item.entry.target} ${item.targetHead}\ndelete refs/heads/${item.branch} ${item.head}\nprepare\ncommit\n`;
  await new Promise<void>((resolve, reject) => {
    const child = execFile('git', ['update-ref', '--stdin'], { cwd: item.main, env: gitCommandEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 15_000 },
      (error, _stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve());
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export type TaskCleanupMode = 'archive' | 'close' | 'discard';
export interface TaskCleanupResult { ok: boolean; message: string; }
export interface ForceUnregisteredDirectory { path: string; dev: number; ino: number; mtimeMs: number; }
interface TaskCleanupOptions {
  release?: () => Promise<void>;
  forceUnregistered?: ForceUnregisteredDirectory;
  forceBranches?: boolean;
  /** The read-only preflight may account for confirmed dependents. Apply requires them to be gone. */
  storage?: { preflight?: ReadonlySet<string> };
}

/** Read every member first, then remove independent safe trees deepest-first, retaining their owner. */
export async function cleanupTaskWorktrees(ctx: SessionWorktreeCtx, session: SessionMeta, mode: TaskCleanupMode,
  opts?: TaskCleanupOptions): Promise<TaskCleanupResult> {
  const state = sessionWorktreeGroups(session);
  if (state?.borrowedFrom) {
    if (opts?.storage) throw new Error('a borrowed worktree has no cleanup ownership');
    const operation = beginTaskWorktreeOperation(ctx.config, session.id, 'release-reference');
    const fingerprint = taskWorktreeOwnership(session);
    try {
      await opts?.release?.();
      if (ctx.findSession(session.id) !== session || taskWorktreeOwnership(session) !== fingerprint) throw new Error('borrowed worktree reference changed');
      clearSessionWorktreeMetadata(session); ctx.persist(); ctx.flushPersist?.(); ctx.broadcast();
      return { ok: true, message: '已解除任务目录引用，未删除所有者的 worktree' };
    } finally { operation.release(); }
  }
  if (!state || (!opts?.storage && state.groups.length < 2 && state.cwdPolicy !== 'source')) throw new Error('task cleanup requires multiple worktree groups');
  if (opts?.forceUnregistered) {
    const selected = state.groups.filter(group => pathKey(group.path) === pathKey(opts.forceUnregistered!.path));
    if (mode !== 'discard' || selected.length !== 1 || selected[0].repos.length || state.groups.some(group => group !== selected[0] &&
      (inside(pathKey(group.path), pathKey(selected[0].path)) || inside(pathKey(selected[0].path), pathKey(group.path))))) {
      throw new Error('force removal requires a confirmed worktree directory without nested task repositories');
    }
  }
  const groups = structuredClone(state), fingerprint = taskWorktreeOwnership(session);
  const operation = beginTaskWorktreeOperation(ctx.config, session.id, 'cleanup');
  const releases: Array<() => void> = [], items: Item[] = [];
  let stopped: string | undefined;
  const checking = opts?.storage?.preflight;
  const assertOwner = () => {
    if (ctx.findSession(session.id) !== session || taskWorktreeOwnership(session) !== fingerprint) throw new Error('worktree task ownership changed');
  };
  const save = () => {
    assertOwner();
    if (checking) return;
    for (const group of session.worktreeGroups!.groups) {
      if (opts?.forceUnregistered && pathKey(group.path) !== pathKey(opts.forceUnregistered.path)) continue;
      group.cleanup = structuredClone(items.filter(item => item.group.id === group.id).map(item => item.entry));
    }
    // Hidden runtime rows are normally excluded from persistence; residual ownership must survive restart.
    delete session.hidden;
    ctx.persist(); ctx.flushPersist?.(); ctx.broadcast();
  };
  const retain = (item: Item, message: string) => { item.entry.status = 'retained'; item.entry.message = message; };
  const retainAncestors = () => {
    for (const item of items) {
      const child = items.find(child => child.group.id === item.group.id && child !== item && child.entry.status === 'retained' &&
        !child.entry.treeRemoved && inside(pathKey(child.tree), pathKey(item.tree)));
      if (child && !item.entry.treeRemoved) retain(item, `dependent child retained: ${child.repo}`);
    }
  };
  try {
    for (const rootId of new Set([session.sourceRoot?.rootId, ...groups.groups.map(group => group.sourceRoot!.rootId),
      ...(groups.sourceRoots ?? []).map(root => root.rootId)].filter((id): id is string => !!id))) {
      releases.push(workspaceRootUsesFor(ctx.config).acquire({ workspaceId: ctx.workspaceIdFor(session), rootId,
        kind: 'worktree', id: `${session.id}:cleanup`, sessionId: session.id, label: session.name }));
    }
    for (const group of groups.groups) {
      for (const repo of [...sortNestedPaths(group.repos, true), { path: '', branch: group.branch!, baseBranch: group.baseBranch }]) {
        const previous = group.cleanup?.find(entry => entry.repo === repo.path && entry.branch === repo.branch);
        const target = group.integration?.find(entry => entry.repo === repo.path && entry.branch === repo.branch)?.target || repo.baseBranch;
        items.push({ group, repo: repo.path, branch: repo.branch, baseBranch: repo.baseBranch, previous,
          tree: repo.path ? nestedWorktreePath(group.path, repo.path) : group.path,
          main: repo.path ? nestedRepoMainPath(group.source!.mainRepo, repo.path) : group.source!.mainRepo,
          entry: { repo: repo.path, branch: repo.branch, status: 'not-started', treeRemoved: false, branchRemoved: false, ...(target ? { target } : {}) } });
      }
    }
    const workspaceId = ctx.workspaceIdFor(session);
    const workspaceConfig = () => {
      const config = ctx.config.get();
      return opts?.storage ? { ...config, workspaces: [...config.workspaces, ...(config.closedWorkspaces ?? [])] } : config;
    };
    const workspace = requireWorkspace(workspaceConfig(), workspaceId);
    const control = physical(controlRootFor(workspace));
    const sources = [session.sourceRoot, ...groups.groups.map(group => group.sourceRoot), ...(groups.sourceRoots ?? [])]
      .filter((source): source is NonNullable<SessionMeta['sourceRoot']> => !!source)
      .map(source => ({ source, physical: source.physicalPath ?? physical(source.path) }));
    const assertScope = () => {
      assertOwner();
      const config = workspaceConfig();
      const live = requireWorkspace(config, workspaceId);
      if (physical(controlRootFor(live)) !== control) throw new Error('workspace management folder changed');
      for (const { source, physical: expected } of sources) {
        const root = requireSourceRoot(live, source.rootId);
        if (physical(root.path) !== expected || physical(source.path) !== expected) throw new Error('source folder changed');
      }
      if (opts?.storage && worktreeSessionReferences(session, ctx.sessions?.() ?? []).some(other => other.id !== session.id && !checking?.has(other.id))) {
        throw new Error('task checkout is still used by another session');
      }
      for (const group of groups.groups) {
        if (anchoredPath(group.path) !== pathKey(group.path)) throw new Error('task container physical path changed');
        if (opts?.storage && config.workspaces.some(workspace =>
          [controlRootFor(workspace), ...sourceRootsFor(workspace).map(root => root.path)].some(root => inside(anchoredPath(root), pathKey(group.path))))) {
          throw new Error(t('此 worktree 已登记为工作区文件夹，请先在工作区设置中解除引用。'));
        }
        if (!opts?.storage && ctx.sessions?.().some(other => other.id !== session.id && ((!other.archived && other.cwd && inside(anchoredPath(other.cwd), pathKey(group.path))) ||
          (other.worktreePath && inside(anchoredPath(other.worktreePath), pathKey(group.path))) || other.worktreeGroups?.borrowedFrom === session.id || other.worktreeGroups?.groups.some(ref => inside(pathKey(ref.path), pathKey(group.path)))))) {
          throw new Error('task checkout is still used by another session');
        }
      }
    };
    if (opts?.release) await opts.release();
    assertScope(); save();
    const seen = new Set<string>();
    let duplicate = false;
    const assertIdentity = (item: Item) => {
      assertScope();
      const source = readGitDirectories(item.main);
      if (!source || physical(item.main) !== item.sourcePhysical || physical(source.commonDir) !== item.common ||
        physical(source.gitDir) !== item.sourceGitDir || !inside(physical(item.main), physical(item.group.source!.mainRepo)) ||
        !inside(anchoredPath(item.tree), pathKey(item.group.path)) || anchoredPath(item.tree) !== pathKey(item.tree)) throw new Error('worktree repository identity changed');
      available(item.sourceGitDir!);
      for (const child of items) {
        if (child === item || child.group.id !== item.group.id || !child.entry.treeRemoved || !inside(pathKey(child.tree), pathKey(item.tree)) || !fs.existsSync(child.tree)) continue;
        if (child.gitlinkParent !== item || !fs.statSync(child.tree).isDirectory() || fs.readdirSync(child.tree).length) throw new Error('a directory appeared in a removed child checkout');
      }
      if (item.registered && !item.entry.treeRemoved) {
        available(item.privateGitDir!);
        if (fs.readFileSync(path.join(item.privateGitDir!, 'HEAD'), 'utf8').trim() !== `ref: refs/heads/${item.branch}`) throw new Error('worktree task branch changed');
        if (item.exists) {
          const tree = readGitDirectories(item.tree);
          if (!tree || physical(tree.commonDir) !== item.common || physical(tree.gitDir) !== item.privateGitDir ||
            physical(item.tree) !== pathKey(item.tree) || physical(tree.gitDir) === item.common) throw new Error('worktree task identity changed');
        } else if (fs.existsSync(item.tree)) throw new Error('a directory appeared at the missing task path');
      }
    };
    const checkRefs = async (item: Item) => {
      assertIdentity(item);
      const head = (await git(item.main, ['rev-parse', '--verify', '--quiet', `refs/heads/${item.branch}`])).trim();
      if (head !== item.head) throw new Error('worktree task commit changed after preflight');
      if (item.registered && !item.entry.treeRemoved && item.exists && mode !== 'discard' &&
        (await git(item.tree, ['status', '--porcelain', '-z', '--untracked-files=all'])).length) throw new Error('task checkout has uncommitted changes');
      if (item.registered && !item.entry.treeRemoved && item.exists && mode !== 'discard') {
        const ignored = (await git(item.tree, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']))
          .split('\0').filter(Boolean);
        // Nested task checkouts are inspected independently before their parent.
        const ownedChildren = items.filter(child => child !== item && child.group.id === item.group.id && inside(pathKey(child.tree), pathKey(item.tree)));
        if (ignored.some(file => !ownedChildren.some(child => inside(pathKey(path.resolve(item.tree, file)), pathKey(child.tree))))) {
          throw new Error('task checkout has ignored files');
        }
      }
      assertIdentity(item);
    };
    // No removals until all sources, registrations, locks, dirtiness and refs have been inspected.
    for (const item of items) {
      try {
        assertScope();
        if (opts?.forceUnregistered && pathKey(item.group.path) !== pathKey(opts.forceUnregistered.path)) {
          retain(item, 'outside the confirmed directory');
          continue;
        }
        const source = readGitDirectories(item.main);
        if (!source || physical(source.gitDir) !== physical(source.commonDir)) throw new Error('source is not the primary checkout');
        item.sourcePhysical = physical(item.main); item.sourceGitDir = physical(source.gitDir); item.common = physical(source.commonDir);
        if (!inside(item.sourcePhysical, physical(item.group.sourceRoot!.path)) || !inside(item.sourcePhysical, physical(item.group.source!.mainRepo)) ||
          (!item.repo && item.common !== physical(item.group.source!.commonDir))) throw new Error('source repository identity changed');
        item.entry.commonDir = item.common;
        if (seen.has(item.common)) { duplicate = true; throw new Error('duplicate task repository common directory'); }
        seen.add(item.common); operation.holdRepository(item.common);
        available(item.sourceGitDir);
        const listed = records(await git(item.main, ['worktree', 'list', '--porcelain', '-z']));
        assertScope();
        const registration = listed.filter(fields => atPath(fields, item.tree));
        if (registration.length > 1) throw new Error('ambiguous task registration');
        item.exists = fs.existsSync(item.tree); item.registered = !!registration.length;
        if (item.registered) {
          const record = registration[0]!;
          if (!record.includes(`branch refs/heads/${item.branch}`) || record.some(field => field.startsWith('locked'))) throw new Error('task registration branch changed or locked');
          item.privateGitDir = registeredPrivateDirectory(item);
          if (!record.some(field => field.startsWith('HEAD '))) throw new Error('task registration has no HEAD');
        } else {
          // A prior verified removal can leave only a gitlink's empty directory.
          const empty = item.exists && item.previous?.treeRemoved && item.repo && fs.statSync(item.tree).isDirectory() && fs.readdirSync(item.tree).length === 0;
          if (item.exists && !empty) {
            if (!opts?.forceUnregistered || item.repo || pathKey(item.tree) !== pathKey(opts.forceUnregistered.path)) throw new Error('unregistered directory at the task path; ownership is unknown');
            const stat = fs.lstatSync(item.tree);
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== opts.forceUnregistered.dev || stat.ino !== opts.forceUnregistered.ino || stat.mtimeMs !== opts.forceUnregistered.mtimeMs ||
                physical(item.tree) !== pathKey(item.tree) || inside(pathKey(item.main), pathKey(item.tree)) || inside(pathKey(item.group.sourceRoot!.path), pathKey(item.tree))) {
              throw new Error('confirmed directory identity or source scope changed');
            }
            item.forceUnregistered = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
            continue;
          }
          item.entry.treeRemoved = true;
        }
        let head = '';
        try { head = (await git(item.main, ['rev-parse', '--verify', '--quiet', `refs/heads/${item.branch}`])).trim(); }
        catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
        if (!head) {
          if (item.registered) throw new Error('registered task branch is missing');
          item.entry.branchRemoved = true; item.entry.status = 'removed'; continue;
        }
        if (!item.registered && !(item.previous?.treeRemoved && item.previous.headCommit === head && item.previous.commonDir === item.common)) {
          if (mode !== 'close') throw new Error('unregistered task branch ownership cannot be verified');
          // The missing checkout cannot prove ownership of this ref. Detach only on
          // explicit session deletion and retain the ref regardless of merge state.
          item.detachedBranch = 'unverified';
          retain(item, 'unregistered task branch ownership cannot be verified; branch retained');
          continue;
        }
        item.head = head; item.entry.headCommit = head;
        if (item.registered && !registration[0]!.includes(`HEAD ${head}`)) throw new Error('task registration commit changed');
        await checkRefs(item);
        if (opts?.storage && opts.forceBranches) continue;
        item.entry.target ||= await resolveDefaultBranch(item.main);
        item.targetHead = (await git(item.main, ['rev-parse', `refs/heads/${item.entry.target}^{commit}`])).trim();
        try { await git(item.main, ['merge-base', '--is-ancestor', head, item.targetHead]); }
        catch (error) {
          if ((error as { code?: unknown }).code !== 1) throw error;
          if (mode === 'archive') throw new Error('task branch has unmerged commits');
        }
      } catch (error) { retain(item, reason(error)); }
    }
    if (duplicate) throw new Error('duplicate task repository common directory');
    for (const child of items) {
      if (!child.repo || child.entry.status === 'retained') continue;
      const parent = items.filter(parent => parent.group.id === child.group.id && parent !== child &&
        (!parent.repo || child.repo.startsWith(`${parent.repo}/`))).sort((a, b) => b.repo.length - a.repo.length)[0]!;
      if (parent.entry.status === 'retained' || !parent.registered || !parent.exists) continue;
      try {
        const relative = parent.repo ? child.repo.slice(parent.repo.length + 1) : child.repo;
        if ((await git(parent.tree, ['ls-tree', '-z', 'HEAD', '--', relative])).startsWith('160000 commit ')) child.gitlinkParent = parent;
        assertIdentity(parent);
      } catch (error) { retain(child, reason(error)); }
    }
    retainAncestors(); save();
    // Catch later-group writes/identity changes before the first deletion.
    for (const item of items) {
      if (item.entry.status !== 'not-started') continue;
      if (item.forceUnregistered) continue;
      try { await checkRefs(item); } catch (error) { retain(item, reason(error)); }
    }
    retainAncestors(); save();
    if (checking) {
      const blocked = items.filter(item => item.entry.status === 'retained');
      return { ok: !blocked.length, message: blocked.map(item => `${item.tree}: ${displayReason(item.entry.message ?? '')}`).join('\n') };
    }
    for (const item of items) {
      if (item.entry.status !== 'not-started') continue;
      try {
        if (item.forceUnregistered) {
          assertIdentity(item);
          const stat = fs.lstatSync(item.tree);
          const expected = item.forceUnregistered;
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.mtimeMs !== expected.mtimeMs || physical(item.tree) !== pathKey(item.tree)) throw new Error('confirmed directory identity changed');
          const live = records(await git(item.main, ['worktree', 'list', '--porcelain', '-z']));
          if (live.some(fields => fields.some(field => field.startsWith('worktree ') && inside(pathKey(field.slice(9)), pathKey(item.tree))))) throw new Error('worktree registration appeared after confirmation');
          await assertNoNestedGit(item.tree);
          assertIdentity(item);
          const current = fs.lstatSync(item.tree);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino || current.mtimeMs !== expected.mtimeMs) throw new Error('confirmed directory identity changed');
          await fs.promises.rm(item.tree, { recursive: true, force: false });
          item.entry.treeRemoved = true;
          item.detachedBranch = 'unverified';
          retain(item, 'unregistered task branch ownership cannot be verified; branch retained');
          save();
          continue;
        }
        // Earlier independent removals must not invalidate the remaining members.
        assertScope(); await checkRefs(item);
        if (!item.entry.treeRemoved) {
          for (const delay of [0, 600, 1600, 3200]) {
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            await checkRefs(item);
            const live = records(await git(item.main, ['worktree', 'list', '--porcelain', '-z'])).find(fields => atPath(fields, item.tree));
            if (!live || !live.includes(`branch refs/heads/${item.branch}`) || live.some(field => field.startsWith('locked'))) throw new Error('task registration changed after preflight');
            assertIdentity(item);
            try {
              await git(item.main, ['-c', 'submodule.recurse=false', 'worktree', 'remove', ...(mode === 'discard' || opts?.forceBranches ? ['--force'] : []), item.tree]);
              break;
            } catch (error) {
              if (delay === 3200 || !/permission denied|unable to unlink|directory not empty|could not remove|failed to delete/i.test(reason(error))) throw error;
            }
          }
          if (opts?.storage && fs.lstatSync(item.tree, { throwIfNoEntry: false })) {
            throw new Error(t('Git 已移除登记，但目录仍存在。已保留分支，请检查目录内的文件或链接。'));
          }
          item.entry.treeRemoved = true; save();
          if (item.gitlinkParent && fs.existsSync(item.gitlinkParent.tree)) {
            assertIdentity(item.gitlinkParent);
            if (anchoredPath(item.tree) !== pathKey(item.tree)) throw new Error('gitlink directory identity changed');
            fs.mkdirSync(item.tree, { recursive: true });
          }
        }
        assertIdentity(item);
        const listed = records(await git(item.main, ['worktree', 'list', '--porcelain', '-z']));
        if (listed.some(fields => fields.includes(`branch refs/heads/${item.branch}`))) throw new Error('task branch is used by another worktree');
        if (opts?.forceBranches && opts.storage) {
          assertIdentity(item);
          await git(item.main, ['update-ref', '-d', `refs/heads/${item.branch}`, item.head!]);
          item.entry.branchRemoved = true; item.entry.status = 'removed'; delete item.entry.message;
          save(); ctx.git?.invalidateRepoCaches([item.main, item.tree]);
          continue;
        }
        if (opts?.forceBranches) {
          if (!ctx.git) throw new Error('GitService 不可用');
          const forced = await ctx.git.deleteBranchForce(item.main, item.branch);
          if (!forced.ok) throw new Error(forced.message ?? t('分支删除失败'));
          item.entry.branchRemoved = true; item.entry.status = 'removed'; delete item.entry.message;
          save(); ctx.git.invalidateRepoCaches([item.main, item.tree]);
          continue;
        }
        try { await git(item.main, ['merge-base', '--is-ancestor', item.head!, `refs/heads/${item.entry.target}`]); }
        catch (error) {
          if ((error as { code?: unknown }).code !== 1) throw error;
          if (mode !== 'close') throw new Error('task branch has unmerged commits; branch retained');
          item.detachedBranch = 'unmerged';
          retain(item, 'task branch has unmerged commits; branch retained');
          save();
          continue;
        }
        assertIdentity(item);
        await deleteMergedRef(item);
        item.entry.branchRemoved = true; item.entry.status = 'removed'; delete item.entry.message;
        save(); ctx.git?.invalidateRepoCaches([item.main, item.tree]);
      } catch (error) { retain(item, reason(error)); retainAncestors(); save(); }
    }
    assertScope();
    if (opts?.forceUnregistered) {
      const selected = items.find(item => item.forceUnregistered && item.entry.treeRemoved);
      if (selected) {
        const message = t('目录已删除，分支 {{branch}} 已保留。', { branch: selected.branch });
        ctx.notify.push({ workspaceId: ctx.workspaceIdFor(session), sessionId: session.id, sessionName: session.name,
          label: t('遗留 worktree'), text: formatNotifyText(session.name, message), toast: true });
        return { ok: true, message };
      }
    }
    if (items.every(item => item.entry.status === 'removed' || item.detachedBranch)) {
      const fallback = session.sourceRoot?.cwd ?? groups.groups.find(group => group.id === groups.primaryGroupId)!.source!.mainRepo;
      clearSessionWorktreeMetadata(session);
      if (session.meta) { delete session.meta.orphanWorktree; delete session.meta.worktreeCleanupIssue; }
      if (groups.cwdPolicy !== 'source') session.cwd = fallback; ctx.persist(); ctx.flushPersist?.(); ctx.broadcast();
      const detached = items.filter(item => item.detachedBranch).map(item => `${item.main}: ${item.branch} (${item.detachedBranch === 'unmerged' ? t('未合入') : t('归属未确认')})`);
      const message = detached.length ? t('会话关联的以下分支已保留：{{branches}}', { branches: detached.join('\n') })
        : t('任务 worktree 清理完成：{{repos}} 个仓', { repos: items.length });
      if (detached.length) ctx.notify.push({ workspaceId: ctx.workspaceIdFor(session), sessionId: session.id, sessionName: session.name,
        label: t('遗留 worktree'), text: formatNotifyText(session.name, message), toast: true });
      return { ok: true, message };
    }
  } catch (error) {
    if (checking) return { ok: false, message: displayReason(reason(error)) };
    if (ctx.findSession(session.id) !== session || taskWorktreeOwnership(session) !== fingerprint) return { ok: false, message: reason(error) };
    stopped = reason(error);
    for (const item of items) if (item.entry.status === 'not-started') retain(item, stopped);
    save();
  } finally { for (const release of releases) release(); operation.release(); }
  session.meta = { ...session.meta, orphanWorktree: items.some(item => !item.entry.treeRemoved && /uncommitted|ignored files/.test(item.entry.message ?? '')) ? 'dirty' :
    items.some(item => item.entry.treeRemoved && !item.entry.branchRemoved) ? 'unmerged' : 'locked' };
  const details = [...items.filter(item => item.entry.status === 'retained').map(item => `${item.group.sourceRoot!.rootId}/${item.repo || '.'}: ${item.tree} (${displayReason(item.entry.message ?? '')})`), ...(stopped ? [displayReason(stopped)] : [])].join('\n');
  const message = t('任务 worktree 已保留：{{details}}', { details });
  session.meta.worktreeCleanupIssue = message;
  ctx.persist(); ctx.flushPersist?.(); ctx.broadcast();
  ctx.notify.push({ workspaceId: ctx.workspaceIdFor(session), sessionId: session.id, sessionName: session.name,
    label: t('遗留 worktree'), text: formatNotifyText(session.name, message), update: true, updateKey: `worktree:${session.id}`, toast: true });
  return { ok: false, message };
}
