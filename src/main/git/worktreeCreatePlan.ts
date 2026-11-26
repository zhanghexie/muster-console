import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorktreeRepoRef } from '../../shared/types';
import { pathKey } from '../pathKey';
import { sourcePathKey } from '../workspacePaths';
import { executionPathKey } from '../workspaceExecutionContext';
import { isPathInsideWorkspace } from './scan';
import { readGitDirectories, resolveRepoIdentity } from './repoIdentity';
import { resolveDefaultBranch, parsePorcelainPaths } from './mergeIsolate';
import { sessionWorktreeBranch, sessionWorktreeDirName } from './worktree';
import { nestedRepoMainPath, sortNestedPaths } from './nestedRepos';
import { gitCommandArgs, gitCommandEnvironment } from './gitEnvironment';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', gitCommandArgs(args), { cwd, env: gitCommandEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export interface PreparedWorktreeRepo {
  relativePath: string;
  mainRepo: string;
  commonDir: string;
  commonKey: string;
  headCommit: string;
  headBranch: string;
  baseCommit: string;
  baseBranch: string;
  kind: WorktreeRepoRef['kind'];
  dirtyPaths: string[];
}

/** Host-only preparation. A directory array alone never authorizes repository writes. */
export interface PreparedWorktreeGroup {
  sessionId: string;
  branch: string;
  path: string;
  storagePath: string;
  storageKey: string;
  main: PreparedWorktreeRepo;
  nested: PreparedWorktreeRepo[];
}

async function prepareRepo(mainRepo: string, relativePath: string, branch: string, pinned?: string): Promise<PreparedWorktreeRepo> {
  const identity = await resolveRepoIdentity(mainRepo, [mainRepo]);
  if (!identity || pathKey(identity.mainRepo) !== pathKey(identity.root) || pathKey(identity.root) !== sourcePathKey(mainRepo)) throw new Error(`repository is not a primary checkout: ${mainRepo}`);
  const headBranch = (await git(mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const headCommit = (await git(mainRepo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const baseBranch = headBranch !== 'HEAD' && !headBranch.startsWith('ao/') ? headBranch : await resolveDefaultBranch(mainRepo);
  const baseCommit = (await git(mainRepo, ['rev-parse', '--verify', `${pinned ?? baseBranch}^{commit}`])).trim();
  try {
    await git(mainRepo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    throw new Error(`task branch already exists: ${mainRepo}: ${branch}`);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  const dirty = await git(mainRepo, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all']);
  return { relativePath, mainRepo: await fs.realpath(identity.mainRepo), commonDir: await fs.realpath(identity.commonDir),
    commonKey: sourcePathKey(identity.commonDir), headCommit, headBranch, baseCommit, baseBranch,
    kind: pinned ? 'submodule' : 'independent', dirtyPaths: parsePorcelainPaths(dirty) };
}

/** Read all nested baselines, including parent gitlinks, before any tree is created. */
export async function prepareWorktreeGroup(mainRepo: string, sessionId: string, nestedPaths: string[], storageRoot: string, directoryName = sessionWorktreeDirName(sessionId)): Promise<PreparedWorktreeGroup> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/.test(sessionId)) throw new Error('invalid task session identity');
  if (!directoryName || directoryName === '.' || directoryName === '..' || /[\\/:*?"<>|\x00]/.test(directoryName)) throw new Error('invalid task worktree directory name');
  const branch = sessionWorktreeBranch(sessionId);
  const main = await prepareRepo(mainRepo, '', branch);
  const nested: PreparedWorktreeRepo[] = [];
  const storageKey = executionPathKey(storageRoot);
  // Use a captured physical destination so a later storage Junction retarget cannot
  // redirect either the creation or the rollback to another task's directory.
  const target = path.resolve(storageKey, directoryName);
  for (const { path: relativePath } of sortNestedPaths(nestedPaths.map(path => ({ path })))) {
    const parent = nested.filter(repo => relativePath.startsWith(`${repo.relativePath}/`))
      .sort((a, b) => b.relativePath.length - a.relativePath.length)[0] ?? main;
    const localPath = parent.relativePath ? relativePath.slice(parent.relativePath.length + 1) : relativePath;
    const entry = await git(parent.mainRepo, ['ls-tree', parent.baseCommit, '--', localPath]);
    const pinned = /^160000 commit ([a-f0-9]+)\t/.exec(entry.trim())?.[1];
    nested.push(await prepareRepo(nestedRepoMainPath(main.mainRepo, relativePath), relativePath, branch, pinned));
  }
  const identities = new Set<string>();
  for (const repo of [main, ...nested]) {
    if (identities.has(repo.commonKey)) throw new Error(`duplicate source repository: ${repo.mainRepo}`);
    identities.add(repo.commonKey);
    // Ignore independent children in their enclosing repo's untracked status.
    const descendants = nested.filter(other => other.relativePath.startsWith(repo.relativePath ? `${repo.relativePath}/` : '') && other !== repo)
      .map(other => repo.relativePath ? other.relativePath.slice(repo.relativePath.length + 1) : other.relativePath);
    repo.dirtyPaths = repo.dirtyPaths.filter(file => !descendants.some(child => file === child || file.startsWith(`${child}/`)));
    if (isPathInsideWorkspace(storageKey, sourcePathKey(repo.mainRepo))) throw new Error(`worktree storage must be outside every source repository: ${repo.mainRepo}`);
  }
  try { await fs.lstat(target); throw new Error(`task worktree directory already exists: ${target}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Reject an unwritable/broken nearest existing ancestor without creating directories.
  let ancestor = storageRoot;
  for (;;) {
    try { if (!(await fs.stat(ancestor)).isDirectory()) throw new Error(`not a directory: ${ancestor}`); await fs.access(ancestor, constants.W_OK); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  for (const repo of [main, ...nested]) { Object.freeze(repo.dirtyPaths); Object.freeze(repo); }
  Object.freeze(nested);
  return Object.freeze({ sessionId, branch, path: target, storagePath: storageRoot, storageKey, main, nested });
}

/** A prepared branch/ref or Junction must not silently change during an await. */
export async function assertPreparedWorktreeGroupCurrent(plan: PreparedWorktreeGroup): Promise<void> {
  if (executionPathKey(plan.storagePath) !== plan.storageKey) throw new Error('worktree storage identity changed');
  for (const repo of [plan.main, ...plan.nested]) {
    const dirs = readGitDirectories(repo.mainRepo);
    if (!dirs || sourcePathKey(dirs.commonDir) !== repo.commonKey || sourcePathKey(repo.commonDir) !== repo.commonKey) throw new Error(`source repository identity changed: ${repo.mainRepo}`);
    if ((await git(repo.mainRepo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== repo.headCommit
      || (await git(repo.mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== repo.headBranch) throw new Error(`source repository baseline changed: ${repo.mainRepo}`);
    // A pinned submodule may deliberately start behind its current source HEAD.
    if (repo.kind !== 'submodule' && (await git(repo.mainRepo, ['rev-parse', '--verify', `${repo.baseBranch}^{commit}`])).trim() !== repo.baseCommit) throw new Error(`source repository baseline changed: ${repo.mainRepo}`);
  }
}

/** A source-only/untracked directory cannot be used as the task's mapped cwd. */
export async function assertPreparedWorktreeCwd(plan: PreparedWorktreeGroup, sourceCwd: string): Promise<void> {
  const repo = [...plan.nested].reverse().find(repo => isPathInsideWorkspace(sourceCwd, repo.mainRepo)) ?? plan.main;
  const relative = path.relative(repo.mainRepo, sourceCwd).split(path.sep).join('/');
  if (!relative) return;
  try {
    if (isPathInsideWorkspace(sourceCwd, repo.mainRepo) && (await git(repo.mainRepo, ['cat-file', '-t', `${repo.baseCommit}:${relative}`])).trim() === 'tree') return;
  } catch { /* A missing object/path has the same actionable source-only cwd diagnosis. */ }
  throw new Error(`working directory is missing from the committed baseline: ${sourceCwd}`);
}
