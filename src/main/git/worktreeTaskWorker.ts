/** Worker reads/snapshots the complete saved task topology, never the current default root. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppContext } from '../context';
import type { SessionMeta, SessionWorktreeGroup } from '../../shared/types';
import type { IntegrateWorktreeGroup } from '../../shared/integrateRequest';
import { sessionWorktreeGroups } from '../../shared/sessionWorktrees';
import { fallbackCommitMessage } from '../../shared/workerStatusGuard';
import { pathKey } from '../pathKey';
import { captureWorkspaceExecutionContext, assertWorkspaceExecutionContextCurrent } from '../workspaceExecutionContext';
import { workspaceRootUsesFor } from '../workspaceRootUses';
import { readGitDirectories } from './repoIdentity';
import { nestedRepoMainPath, nestedWorktreePath, sortNestedPaths } from './nestedRepos';
import { fallbackCommitDirtyTree, listDirtyPaths } from './workerDirtyGuard';
import { assertTaskWorktreeOperationIdle, beginTaskWorktreeOperation, taskWorktreeOwnership } from './worktreeTaskOperation';
import { gitCommandEnvironment } from './gitEnvironment';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const command = args[0] === 'worktree' ? args : ['--work-tree', path.resolve(cwd), ...args];
  const { stdout } = await exec('git', command, { cwd, windowsHide: true, env: gitCommandEnvironment(), encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
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
function available(gitDir: string): void {
  for (const marker of ['locked', 'index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    if (fs.existsSync(path.join(gitDir, marker))) throw new Error(`repository has an active Git operation: ${marker}`);
  }
}
function reason(error: unknown): string {
  return String((error as { stderr?: string })?.stderr || (error as Error)?.message || error).trim().slice(-4000);
}
export interface TaskWorkerSnapshotResult {
  groupId: string;
  rootId: string;
  repo: string;
  path: string;
  branch: string;
  status: 'not-started' | 'skipped' | 'committed' | 'failed';
  headCommit?: string;
  committed?: boolean;
  message?: string;
}
export interface TaskWorkerResult {
  paths: string[];
  committed: boolean;
  worktreeGroups: IntegrateWorktreeGroup[];
  snapshots: TaskWorkerSnapshotResult[];
  failure?: string;
  /** Host-only synchronous recheck before enqueueing a notice, never a tool result. */
  assertCurrent?: () => void;
}
interface Item {
  group: SessionWorktreeGroup;
  repo: string;
  main: string;
  tree: string;
  branch: string;
  mainPhysical?: string;
  treePhysical?: string;
  common?: string;
  privateGitDir?: string;
  sourceGitDir?: string;
  head?: string;
  result: TaskWorkerSnapshotResult;
}

/** All roots/operation locks precede the first await; all members pass before any staging. */
export async function guardTaskWorktrees(ctx: AppContext, session: SessionMeta, snapshot: boolean): Promise<TaskWorkerResult> {
  const state = sessionWorktreeGroups(session);
  if (!state || (snapshot && state.borrowedFrom) || (state.groups.length < 2 && state.cwdPolicy !== 'source')) throw new Error('task worker guard requires owned worktree groups for snapshots');
  const groups = structuredClone(state), fingerprint = taskWorktreeOwnership(session);
  const operation = beginTaskWorktreeOperation(ctx.config, session.id, 'worker snapshot');
  const releases: Array<() => void> = [], items: Item[] = [];
  const result: TaskWorkerResult = { paths: [], committed: false, worktreeGroups: groups.groups.map(group => ({
    groupId: group.id, rootId: group.sourceRoot!.rootId, path: group.path, sourcePath: group.source!.mainRepo, branch: group.branch!,
    repos: [{ relativePath: '', path: group.path, branch: group.branch! }, ...group.repos.map(repo => ({ relativePath: repo.path, path: nestedWorktreePath(group.path, repo.path), branch: repo.branch }))]
  })), snapshots: [] };
  let current: Item | undefined;
  const assertOwner = () => {
    const latest = ctx.sessions.get(session.id);
    if (!latest || taskWorktreeOwnership(latest) !== fingerprint) throw new Error('worktree task ownership changed');
  };
  try {
    for (const rootId of new Set([session.sourceRoot?.rootId, ...groups.groups.map(group => group.sourceRoot!.rootId),
      ...(groups.sourceRoots ?? []).map(root => root.rootId)].filter((id): id is string => !!id))) {
      releases.push(workspaceRootUsesFor(ctx.config).acquire({ workspaceId: session.workspaceId!, rootId,
        kind: 'worktree', id: `${session.id}:worker`, sessionId: session.id, label: session.name }));
    }
    const scope = captureWorkspaceExecutionContext(ctx.config.get(), session);
    if (!scope) throw new Error('worktree task workspace identity is missing');
    const assertScope = () => { assertOwner(); assertWorkspaceExecutionContextCurrent(ctx.config.get(), scope); };
    for (const group of groups.groups) {
      for (const repo of [...sortNestedPaths(group.repos, true), { path: '', branch: group.branch! }]) {
        const item: Item = { group, repo: repo.path, branch: repo.branch,
          main: repo.path ? nestedRepoMainPath(group.source!.mainRepo, repo.path) : group.source!.mainRepo,
          tree: repo.path ? nestedWorktreePath(group.path, repo.path) : group.path,
          result: { groupId: group.id, rootId: group.sourceRoot!.rootId, repo: repo.path,
            path: repo.path ? nestedWorktreePath(group.path, repo.path) : group.path, branch: repo.branch, status: 'not-started' } };
        items.push(item); result.snapshots.push(item.result);
      }
    }
    const label = (item: Item) => `${item.group.sourceRoot!.rootId}/${item.group.id}/${item.repo || '.'}`;
    const assertIdentity = (item: Item) => {
      assertScope();
      const source = readGitDirectories(item.main), tree = readGitDirectories(item.tree);
      if (!source || !tree || physical(item.main) !== item.mainPhysical || physical(item.tree) !== item.treePhysical ||
        physical(source.commonDir) !== item.common || physical(tree.commonDir) !== item.common ||
        physical(source.gitDir) !== item.sourceGitDir || physical(tree.gitDir) !== item.privateGitDir ||
        item.privateGitDir === item.common || !inside(item.privateGitDir!, physical(path.join(item.common!, 'worktrees'))) ||
        pathKey(path.resolve(item.privateGitDir!, fs.readFileSync(path.join(item.privateGitDir!, 'gitdir'), 'utf8').trim())) !== pathKey(path.join(item.treePhysical!, '.git')) ||
        fs.readFileSync(path.join(item.privateGitDir!, 'HEAD'), 'utf8').trim() !== `ref: refs/heads/${item.branch}`) {
        throw new Error(`worktree repository identity/branch changed: ${label(item)}`);
      }
      available(item.privateGitDir!); available(item.sourceGitDir!); available(item.common!);
    };
    // Capture every physical Git identity and lock it synchronously before asynchronous probes.
    for (const item of items) {
      current = item; assertScope();
      item.mainPhysical = physical(item.main); item.treePhysical = physical(item.tree);
      if (!inside(item.mainPhysical, physical(item.group.source!.mainRepo)) || !inside(item.treePhysical, physical(item.group.path))) throw new Error(`nested repository outside its task/source container: ${label(item)}`);
      const source = readGitDirectories(item.main), tree = readGitDirectories(item.tree);
      if (!source || !tree) throw new Error(`missing task/source Git identity: ${label(item)}`);
      item.common = physical(source.commonDir); item.privateGitDir = physical(tree.gitDir); item.sourceGitDir = physical(source.gitDir);
      if (item.sourceGitDir !== item.common || (!item.repo && item.common !== physical(item.group.source!.commonDir))) throw new Error(`source repository identity changed: ${label(item)}`);
      assertIdentity(item); operation.holdRepository(item.common);
    }
    const readHead = async (item: Item) => {
      assertIdentity(item);
      const [head, branch] = (await git(item.tree, ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'])).trim().split(/\r?\n/);
      assertIdentity(item);
      if (branch !== `refs/heads/${item.branch}`) throw new Error(`worktree task branch changed: ${label(item)}`);
      return head!;
    };
    result.assertCurrent = () => {
      assertTaskWorktreeOperationIdle(ctx.config, session.id);
      for (const item of items) assertIdentity(item);
    };
    for (const item of items) {
      current = item;
      const records = (await git(item.main, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').filter(Boolean).map(record => record.split('\0'));
      assertIdentity(item);
      const primary = records[0];
      if (!primary || primary.includes('bare')) throw new Error(`source registration changed: ${label(item)}`);
      const atPrimary = (folder: string) => primary.some(field => {
        if (!field.startsWith('worktree ')) return false;
        try { return physical(field.slice(9)) === folder; } catch { return false; }
      });
      if (!atPrimary(item.mainPhysical!) || atPrimary(item.common!)) {
        // Git reports an absorbed submodule's primary git directory. Its local core.worktree
        // must resolve back to this exact source checkout; equality of common-dir alone is insufficient.
        const configured = (await git(item.main, ['config', '--local', '--get', 'core.worktree']).catch(() => '')).trim();
        assertIdentity(item);
        if (!configured || physical(path.resolve(item.common!, configured)) !== item.mainPhysical) {
          throw new Error(`source registration changed: ${label(item)}`);
        }
      }
      const listed = records.filter(fields => fields.some(field => {
        if (!field.startsWith('worktree ')) return false;
        try { return physical(field.slice(9)) === item.treePhysical; } catch { return false; }
      }));
      if (listed.length !== 1 || !listed[0]!.includes(`branch refs/heads/${item.branch}`) || listed[0]!.some(field => field.startsWith('locked'))) throw new Error(`task registration is missing, changed or locked: ${label(item)}`);
      item.head = await readHead(item); item.result.headCommit = item.head;
      if (!listed[0]!.includes(`HEAD ${item.head}`)) throw new Error(`task commit changed during preflight: ${label(item)}`);
    }
    const assertAll = async () => {
      // Parallel reads, no parallel writes. Recheck scope/identity after every subprocess.
      const checks = await Promise.allSettled(items.map(async item => {
        if ((await readHead(item)) !== item.head) throw new Error(`task commit changed after preflight: ${label(item)}`);
      }));
      const index = checks.findIndex(check => check.status === 'rejected');
      const failed = checks[index];
      if (failed?.status === 'rejected') { current = items[index]; throw failed.reason; }
      assertScope();
    };
    const readPaths = async () => {
      const paths: string[] = [];
      for (const item of items) {
        current = item; assertIdentity(item);
        paths.push(...(await listDirtyPaths(item.tree)).map(file => `${label(item)}: ${file}`));
        assertIdentity(item);
      }
      return paths;
    };
    await assertAll(); result.paths = await readPaths(); await assertAll();
    if (!snapshot || !result.paths.length) return result;
    for (const item of items) {
      current = item;
      assertIdentity(item);
      const before = item.head!;
      const snapped = await fallbackCommitDirtyTree(item.tree, {
        beforeWrite: async () => { await assertAll(); },
        afterCommit: async headCommit => {
          // A hook that creates another commit or switches branches cannot masquerade as this snapshot.
          assertIdentity(item);
          const [parents, message] = (await git(item.tree, ['show', '-s', '--format=%P%n%s', headCommit])).trim().split(/\r?\n/);
          if (parents !== before || message !== fallbackCommitMessage()) throw new Error(`host snapshot commit changed by hook: ${label(item)}`);
          item.head = headCommit; item.result.headCommit = headCommit; item.result.status = 'committed'; item.result.committed = true; result.committed = true;
          await assertAll();
        }
      });
      if (!snapped.ok) {
        if (snapped.committed) { result.committed = true; item.result.headCommit = snapped.headCommit; item.result.committed = true; }
        throw new Error(snapped.message || `host snapshot failed: ${label(item)}`);
      }
      item.result.status = snapped.committed ? 'committed' : 'skipped';
    }
    const remaining = await readPaths(); await assertAll();
    if (remaining.length) {
      current = items.find(item => remaining.some(file => file.startsWith(`${label(item)}: `)));
      throw new Error(`worktree remains dirty after host snapshot: ${remaining.join(', ')}`);
    }
    return result;
  } catch (error) {
    const message = reason(error);
    result.failure = `${current ? `${current.result.rootId}/${current.group.id}/${current.repo || '.'}: ` : ''}${message}`;
    if (current) { current.result.status = 'failed'; current.result.message = message; }
    return result;
  } finally {
    for (const release of releases) release();
    operation.release();
  }
}
