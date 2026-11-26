/** Task-wide preflight and durable, sequential integration of independent Git groups. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionMeta, SessionWorktreeGroup, SessionWorktreeGroupIntegrationResult, SessionWorktreeRepoResult } from '../../shared/types';
import { projectPrimaryWorktree, sessionWorktreeGroups } from '../../shared/sessionWorktrees';
import { t } from '../../shared/i18n';
import { pathKey } from '../pathKey';
import { captureWorkspaceExecutionContext, assertWorkspaceExecutionContextCurrent } from '../workspaceExecutionContext';
import { workspaceRootUsesFor } from '../workspaceRootUses';
import { readGitDirectories, resolveRegisteredWorktree } from './repoIdentity';
import { nestedRepoMainPath, nestedWorktreePath, precheckRepoMerge, formatRepoPrecheckFailure, sortNestedPaths } from './nestedRepos';
import { mergeIsolateBranch, resolveDefaultBranch } from './mergeIsolate';
import type { IntegrateWorktreeOpts } from './worktreeIntegrate';
import type { SessionWorktreeCtx } from './worktreeSessionOps';
import { isTaskGitlinkChange, type TaskGitlinkMerge } from './submoduleMergeState';
import { beginTaskWorktreeOperation, taskWorktreeOwnership } from './worktreeTaskOperation';
import { gitCommandEnvironment } from './gitEnvironment';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: gitCommandEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function physical(folder: string): string {
  if (!fs.statSync(folder).isDirectory()) throw new Error(`not a directory: ${folder}`);
  return pathKey(fs.realpathSync(folder));
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertGitAvailable(gitDir: string): void {
  for (const marker of ['index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    if (fs.existsSync(path.join(gitDir, marker))) throw new Error(`repository has an active Git operation: ${marker}`);
  }
}

interface Item {
  group: SessionWorktreeGroup;
  repo: string;
  main: string;
  tree: string;
  branch: string;
  baseBranch?: string;
  baseCommit?: string;
  common?: string;
  gitDir?: string;
  sourceGitDir?: string;
  mainPhysical?: string;
  treePhysical?: string;
  headCommit?: string;
  targetCommit?: string;
  entry: SessionWorktreeRepoResult;
  previous?: SessionWorktreeRepoResult;
  gitlinkParent?: Item;
}

export interface TaskIntegrateResult {
  ok: boolean;
  groups: SessionWorktreeGroupIntegrationResult[];
  message: string;
  warnings: string[];
}

/** No Git writes until every selected group and nested repository has passed preflight. */
export async function integrateTaskWorktrees(ctx: SessionWorktreeCtx, session: SessionMeta,
  input?: IntegrateWorktreeOpts): Promise<TaskIntegrateResult> {
  const opts = { ...input };
  const state = sessionWorktreeGroups(session);
  if (!state || state.borrowedFrom || (state.groups.length < 2 && state.cwdPolicy !== 'source')) throw new Error('task integration requires multiple worktree groups');
  const groups = structuredClone(state);
  const fingerprint = taskWorktreeOwnership(session);
  const operation = beginTaskWorktreeOperation(ctx.config, session.id, 'integration');
  const releases: Array<() => void> = [];
  const items: Item[] = [];
  const completed = new Set<Item>();
  let current: Item | undefined;
  const results = (): SessionWorktreeGroupIntegrationResult[] => groups.groups.map(group => ({
    groupId: group.id, rootId: group.sourceRoot!.rootId, path: group.path,
    repos: structuredClone(items.filter(item => item.group.id === group.id).map(item => item.entry))
  }));
  const assertOwner = () => {
    if (ctx.findSession(session.id) !== session || taskWorktreeOwnership(session) !== fingerprint) throw new Error('worktree task ownership changed');
  };
  const save = () => {
    assertOwner();
    for (const group of session.worktreeGroups!.groups) {
      group.integration = structuredClone(items.filter(item => item.group.id === group.id).map(item => item.entry));
    }
    ctx.persist(); ctx.flushPersist?.(); ctx.broadcast();
  };
  try {
    // Root uses precede path validation and the first asynchronous Git lookup.
    for (const rootId of new Set([session.sourceRoot?.rootId, ...groups.groups.map(group => group.sourceRoot!.rootId),
      ...(groups.sourceRoots ?? []).map(root => root.rootId)].filter((id): id is string => !!id))) {
      releases.push(workspaceRootUsesFor(ctx.config).acquire({ workspaceId: ctx.workspaceIdFor(session), rootId,
        kind: 'worktree', id: `${session.id}:integrate`, sessionId: session.id, label: session.name }));
    }
    const scope = captureWorkspaceExecutionContext(ctx.config.get(), session);
    if (!scope) throw new Error('worktree task workspace identity is missing');
    const assertScope = () => { assertOwner(); assertWorkspaceExecutionContextCurrent(ctx.config.get(), scope); };
    for (const group of groups.groups) {
      const previous = group.integration ?? [];
      for (const repo of [...sortNestedPaths(group.repos, true), { path: '', branch: group.branch!, baseBranch: group.baseBranch, baseCommit: group.baseCommit }]) {
        const saved = previous.find(entry => entry.repo === repo.path && entry.branch === repo.branch);
        const target = opts.targetBranch?.trim() || saved?.target || repo.baseBranch;
        items.push({ group, repo: repo.path, branch: repo.branch, baseBranch: repo.baseBranch, baseCommit: repo.baseCommit, previous: saved,
          main: repo.path ? nestedRepoMainPath(group.source!.mainRepo, repo.path) : group.source!.mainRepo,
          tree: repo.path ? nestedWorktreePath(group.path, repo.path) : group.path,
          entry: { repo: repo.path, branch: repo.branch, status: 'not-started', ...(target ? { target } : {}) } });
      }
    }
    save();
    // Capture actual registration and common-dir identity, not just a pathname or saved result.
    for (const item of items) {
      current = item;
      assertScope();
      item.mainPhysical = physical(item.main); item.treePhysical = physical(item.tree);
      if (!inside(item.mainPhysical, physical(item.group.source!.mainRepo)) || !inside(item.treePhysical, physical(item.group.path))) throw new Error('nested repository is outside its task/source container');
      const identity = await resolveRegisteredWorktree(item.tree, [item.main]);
      assertScope();
      const source = readGitDirectories(item.main);
      if (!identity || !source || physical(identity.mainRepo) !== item.mainPhysical ||
        physical(identity.commonDir) !== physical(source.commonDir) ||
        (item.repo === '' && physical(identity.commonDir) !== physical(item.group.source!.commonDir))) {
        throw new Error(t('无法确认 worktree 所属仓库，已保留：{{path}}', { path: item.tree }));
      }
      item.common = physical(identity.commonDir);
      item.gitDir = physical(readGitDirectories(item.tree)!.gitDir);
      item.sourceGitDir = physical(source.gitDir);
      assertGitAvailable(item.gitDir); assertGitAvailable(item.sourceGitDir);
      operation.holdRepository(item.common);
      item.entry.target ||= await resolveDefaultBranch(item.main);
      const [head, target, branch] = (await git(item.tree, ['rev-parse', 'HEAD',
        `refs/heads/${item.entry.target}^{commit}`, '--symbolic-full-name', 'HEAD'])).split(/\r?\n/);
      if (branch !== `refs/heads/${item.branch}`) throw new Error('worktree task branch changed');
      item.headCommit = head;
      item.entry.headCommit = head;
      item.targetCommit = target;
      item.entry.targetCommit = item.targetCommit;
      const currentBranch = await git(item.main, ['symbolic-ref', '--short', 'HEAD']).catch(() => '');
      if (currentBranch !== item.entry.target) {
        const records = (await git(item.main, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
        if (records.some(record => record.split('\0').includes(`branch refs/heads/${item.entry.target}`))) throw new Error('target branch is checked out in another worktree');
      }
      assertScope();
    }
    // Classify actual task gitlinks. An independent nested repository is not a submodule.
    for (const child of items) {
      if (!child.repo) continue;
      current = child;
      const parent = items.filter(other => other.group.id === child.group.id && other !== child &&
        (!other.repo || child.repo.startsWith(`${other.repo}/`))).sort((a, b) => b.repo.length - a.repo.length)[0]!;
      const relative = parent.repo ? child.repo.slice(parent.repo.length + 1) : child.repo;
      const treeEntry = await git(parent.tree, ['ls-tree', '-z', parent.headCommit!, '--', relative]);
      if (treeEntry.startsWith('160000 commit ')) child.gitlinkParent = parent;
      assertScope();
    }
    const assertIdentity = (item: Item) => {
      assertScope();
      const source = readGitDirectories(item.main), tree = readGitDirectories(item.tree);
      if (physical(item.main) !== item.mainPhysical || physical(item.tree) !== item.treePhysical || !source || !tree ||
        physical(source.commonDir) !== item.common || physical(tree.commonDir) !== item.common ||
        physical(source.gitDir) !== item.sourceGitDir || physical(tree.gitDir) !== item.gitDir ||
        pathKey(tree.gitDir) === pathKey(tree.commonDir)) throw new Error('worktree repository identity changed');
      assertGitAvailable(item.gitDir!); assertGitAvailable(item.sourceGitDir!);
    };
    const assertItem = async (item: Item, targetUnchanged: boolean) => {
      assertIdentity(item);
      // One Git read returns task HEAD, target commit and symbolic branch in the same repository.
      const [head, target, branch] = (await git(item.tree, ['rev-parse', 'HEAD',
        `refs/heads/${item.entry.target}^{commit}`, '--symbolic-full-name', 'HEAD'])).split(/\r?\n/);
      if (branch !== `refs/heads/${item.branch}` || head !== item.headCommit) throw new Error('worktree source commit changed after preflight');
      if (targetUnchanged && target !== item.targetCommit) {
        throw new Error('worktree target commit changed after preflight');
      }
      assertIdentity(item);
    };
    const sourceGitlinks = (parent: Item): TaskGitlinkMerge[] => items.flatMap(child => {
      if (child.group.id !== parent.group.id || !child.repo || !child.entry.mergedCommit) return [];
      return child.gitlinkParent === parent ? [{ relativePath: parent.repo ? child.repo.slice(parent.repo.length + 1) : child.repo,
        sourcePath: child.mainPhysical!, commonDir: child.common!, taskCommit: child.headCommit!, mergedCommit: child.entry.mergedCommit }] : [];
    });
    const preflightFailures: string[] = [];
    // Read-only merge rehearsal across the whole task, before any checkout/stash/merge.
    for (const item of items) {
      current = item;
      await assertItem(item, true);
      const pre = await precheckRepoMerge({ repoMain: item.main, worktreePath: item.tree, branch: item.branch,
        target: item.entry.target!, label: `${item.group.sourceRoot!.rootId}/${item.repo || '.'}`, stashMain: opts.stashMain,
        sourceCommit: item.headCommit, sourceGitlinks: sourceGitlinks(item) });
      assertScope();
      if (!pre.ok) {
        item.entry.conflicts = pre.conflicts;
        item.entry.status = 'failed'; item.entry.message = pre.message;
        preflightFailures.push(formatRepoPrecheckFailure(pre));
        continue;
      }
      if (pre.alreadyMerged) {
        // A saved completion is never trusted. Live ancestry decides what can be skipped.
        item.entry.status = 'already-merged';
        if (item.previous && item.previous.headCommit === item.headCommit && item.previous.target === item.entry.target) {
          item.entry.warnings = item.previous.warnings; item.entry.gates = item.previous.gates;
          item.entry.mergedCommit = item.previous.mergedCommit;
        }
      } else if (item.baseCommit && item.headCommit === item.baseCommit) item.entry.status = 'skipped-unchanged';
    }
    if (preflightFailures.length) {
      current = undefined;
      throw new Error(t('多仓组全或无预检失败：\n{{reports}}\n整组拒绝合入，全部仓零改动；请在隔离分支解决后重试',
        { reports: preflightFailures.join('\n\n') }));
    }
    // Catch ref changes during a later group's rehearsal before the first Git mutation.
    for (const item of items) { current = item; await assertItem(item, true); }
    save();
    for (const item of items) {
      current = item;
      if (item.entry.status !== 'not-started') continue;
      const gitlinks = sourceGitlinks(item);
      const guard = async (stage: 'checkout' | 'stash' | 'merge') => {
        // All unfinished members remain pinned, including groups not yet reached.
        for (const other of items) {
          try { await assertItem(other, !completed.has(other)); }
          catch (error) { current = other; throw error; }
        }
        if (stage !== 'checkout' && await git(item.main, ['symbolic-ref', '--short', 'HEAD']) !== item.entry.target) throw new Error('main checkout branch changed during integration');
        if ((await git(item.tree, ['status', '--porcelain'])).trim()) throw new Error(t('worktree 有未提交改动。请先在隔离目录提交，再合入。'));
        for (const link of gitlinks) {
          if (!(await isTaskGitlinkChange(item.main, item.headCommit!, link))) throw new Error('source submodule state changed during integration');
        }
        // Close directory/gitfile changes during the asynchronous ref/status reads.
        for (const other of items) assertIdentity(other);
        if (stage !== 'checkout' && fs.readFileSync(path.join(item.sourceGitDir!, 'HEAD'), 'utf8').trim() !== `ref: refs/heads/${item.entry.target}`) throw new Error('main checkout branch changed during integration');
      };
      await guard('checkout');
      const merge = await mergeIsolateBranch({ ...opts, mainRepo: item.main, worktreePath: item.tree,
        branch: item.branch, sourceCommit: item.headCommit, targetBranch: item.entry.target, baseBranch: item.baseBranch,
        sourceGitlinks: gitlinks,
        skipNpmInstall: item.repo ? true : opts.skipNpmInstall, skipTypecheck: item.repo ? true : opts.skipTypecheck,
        beforeWrite: guard });
      // Persist a completed repository before another asynchronous operation can fail.
      item.entry.status = merge.ok ? (merge.alreadyMerged ? 'already-merged' : 'merged') : 'failed';
      item.entry.message = merge.message;
      item.entry.warnings = merge.warnings; item.entry.gates = merge.gates; item.entry.conflicts = merge.conflicts;
      item.entry.mergedCommit = merge.mergedCommit;
      if (merge.ok) completed.add(item);
      save();
      ctx.git?.invalidateRepoCaches([item.main, item.tree]);
      if (!merge.ok) throw new Error(merge.message);
    }
    // Workers can still be writing while hooks run. Never accept their later unmerged work.
    for (const item of items) {
      current = item;
      await assertItem(item, false);
      if ((await git(item.tree, ['status', '--porcelain'])).trim()) throw new Error('worktree became dirty during integration');
      if (item.entry.status !== 'skipped-unchanged') await git(item.main, ['merge-base', '--is-ancestor', item.headCommit!, `refs/heads/${item.entry.target}`]);
    }
    assertScope();
    projectPrimaryWorktree(session);
    return { ok: true, groups: results(), warnings: items.flatMap(item => item.entry.warnings ?? []),
      message: t('跨组任务合入完成：{{groups}} 组、{{repos}} 个仓', { groups: groups.groups.length, repos: items.length }) };
  } catch (error) {
    const reason = String((error as Error).message ?? error);
    if (current && !completed.has(current)) {
      current.entry.status = 'failed'; current.entry.message = reason;
    } else if (current) {
      current.entry.message = `${current.entry.message ?? ''}\n${reason}`.trim();
    }
    // Do not replace a new owner's collection. Earlier completed entries were already persisted.
    if (ctx.findSession(session.id) === session && taskWorktreeOwnership(session) === fingerprint && items.length) save();
    return { ok: false, groups: results(), warnings: items.flatMap(item => item.entry.warnings ?? []),
      message: t('跨组任务合入停止：{{reason}}。已完成仓不回滚；请查看逐仓结果，修复后重试。', { reason }) };
  } finally {
    for (const release of releases) release();
    operation.release();
  }
}
