import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sourcePathKey } from '../workspacePaths';
import { pathKey } from '../pathKey';
import type { PreparedWorktreeRepo } from './worktreeCreatePlan';
import { readGitDirectories, resolveRegisteredWorktree } from './repoIdentity';
import { parsePorcelainPaths } from './mergeIsolate';
import { gitCommandArgs, gitCommandEnvironment } from './gitEnvironment';
import type { GitWorktreeCreationResidual } from '../../shared/types';

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', gitCommandArgs(args), { cwd, env: gitCommandEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** Reverse dependencies. A changed child retains the required containing tree. */
export async function rollbackPreparedTrees(items: readonly { repo: PreparedWorktreeRepo; path: string; branch: string; attempted?: boolean }[]): Promise<GitWorktreeCreationResidual[]> {
  const residuals: GitWorktreeCreationResidual[] = [];
  for (const item of [...items].reverse()) {
    let treeRemoved = false;
    try {
      const source = readGitDirectories(item.repo.mainRepo);
      if (!source || sourcePathKey(source.commonDir) !== item.repo.commonKey || sourcePathKey(item.repo.commonDir) !== item.repo.commonKey) throw new Error('source repository identity changed');
      if (residuals.some(child => !child.treeRemoved && pathKey(child.path).startsWith(pathKey(item.path) + '/'))) throw new Error('dependent child was retained');
      let registered = true;
      if (fs.existsSync(item.path)) {
        if (item.attempted) throw new Error('failed creation left a directory without verified ownership');
        const identity = await resolveRegisteredWorktree(item.path, [item.repo.mainRepo]);
        if (!identity || sourcePathKey(identity.commonDir) !== item.repo.commonKey) throw new Error('task repository identity changed');
        if ((await git(item.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== item.branch || (await git(item.path, ['rev-parse', 'HEAD'])).trim() !== item.repo.baseCommit) throw new Error('task branch changed after creation');
        const dirty = parsePorcelainPaths(await git(item.path, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all']));
        if (dirty.length) throw new Error(`task files changed after creation: ${dirty.slice(0, 20).join(', ')}`);
      } else {
        const listed = await git(item.repo.mainRepo, ['worktree', 'list', '--porcelain', '-z']);
        const record = listed.split('\0\0').map(value => value.split('\0')).find(fields => fields.some(field => field.startsWith('worktree ') && pathKey(field.slice(9)) === pathKey(item.path)));
        if (!record) {
          registered = false;
          let current = '';
          try { current = (await git(item.repo.mainRepo, ['rev-parse', '--verify', '--quiet', `refs/heads/${item.branch}`])).trim(); }
          catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
          if (!current) continue;
          if (item.attempted) throw new Error('failed creation left a branch without verified ownership');
          if (current !== item.repo.baseCommit) throw new Error('task branch changed after creation');
        } else if (item.attempted || !record.includes(`branch refs/heads/${item.branch}`)) throw new Error('missing task registration cannot be verified');
      }
      // Without --force: a write arriving after the checks still prevents deletion.
      if (registered) await git(item.repo.mainRepo, ['worktree', 'remove', item.path]);
      treeRemoved = true;
      // An empty tracked gitlink directory is the clean, uninitialized submodule
      // state. Its absence would look like a deletion to the containing tree.
      if (item.repo.kind === 'submodule' && fs.existsSync(path.dirname(item.path))) fs.mkdirSync(item.path, { recursive: true });
      const listed = await git(item.repo.mainRepo, ['worktree', 'list', '--porcelain', '-z']);
      if (listed.split('\0').includes(`branch refs/heads/${item.branch}`)) throw new Error('task branch is used by another worktree');
      // Compare-and-delete cannot erase a commit arriving after worktree removal.
      await git(item.repo.mainRepo, ['update-ref', '-d', `refs/heads/${item.branch}`, item.repo.baseCommit]);
    } catch (error) {
      residuals.push({ path: item.path, mainRepo: item.repo.mainRepo, branch: item.branch, treeRemoved,
        message: String((error as { stderr?: string; message?: string }).stderr ?? (error as Error).message ?? error).trim() });
    }
  }
  return residuals;
}
