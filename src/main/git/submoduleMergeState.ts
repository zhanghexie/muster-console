/** Allow only an attributable gitlink change from this task's completed nested merge. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathKey } from '../pathKey';
import { readGitDirectories } from './repoIdentity';
import { gitCommandEnvironment } from './gitEnvironment';

const exec = promisify(execFile);
export interface TaskGitlinkMerge {
  relativePath: string;
  sourcePath: string;
  commonDir: string;
  taskCommit: string;
  mergedCommit: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: gitCommandEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** No staged gitlink edit, uncommitted child work, replacement repo or unrelated child HEAD. */
export async function isTaskGitlinkChange(main: string, taskCommit: string, approval: TaskGitlinkMerge): Promise<boolean> {
  const relative = approval.relativePath;
  if (!relative || /[\\:\0]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) return false;
  try {
    const child = path.join(main, ...relative.split('/'));
    const dirs = readGitDirectories(child);
    if (!dirs || pathKey(fs.realpathSync(child)) !== approval.sourcePath || pathKey(fs.realpathSync(dirs.commonDir)) !== approval.commonDir) return false;
    const head = await git(main, ['ls-tree', '-z', 'HEAD', '--', relative]);
    const incoming = await git(main, ['ls-tree', '-z', taskCommit, '--', relative]);
    const index = await git(main, ['ls-files', '--stage', '-z', '--', relative]);
    const oldLink = /^160000 commit ([a-f0-9]+)\t/.exec(head)?.[1];
    const newLink = /^160000 commit ([a-f0-9]+)\t/.exec(incoming)?.[1];
    // A stage other than 0, or a user's staged gitlink, is never ours to discard.
    if (!oldLink || newLink !== approval.taskCommit || index !== `160000 ${oldLink} 0\t${relative}\0`) return false;
    if ((await git(child, ['rev-parse', 'HEAD'])).trim() !== approval.mergedCommit || (await git(child, ['status', '--porcelain'])).trim()) return false;
    await git(child, ['merge-base', '--is-ancestor', approval.taskCommit, approval.mergedCommit]);
    return true;
  } catch { return false; }
}

/** The caller still rejects every other overlap using its existing dirty-file policy. */
export async function filterTaskGitlinkOverlaps(main: string, taskCommit: string, overlap: string[], approvals?: readonly TaskGitlinkMerge[]): Promise<string[]> {
  const rejected: string[] = [];
  for (const relative of overlap) {
    const approval = approvals?.find(item => item.relativePath === relative);
    if (!approval || !(await isTaskGitlinkChange(main, taskCommit, approval))) rejected.push(relative);
  }
  return rejected;
}
