/** Private, path-scoped stash objects. Never touches the worktree-shared refs/stash. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitCommandArgs, gitCommandEnvironment } from './gitEnvironment';

function snapshotGit(repo: string, index: string) {
  return (args: string[], input?: string, privateIndex = false): Promise<string> => new Promise((resolve, reject) => {
    const child = execFile('git', gitCommandArgs(args), { cwd: repo, windowsHide: true,
      env: { ...gitCommandEnvironment(), ...(privateIndex ? { GIT_INDEX_FILE: index } : {}), GIT_LITERAL_PATHSPECS: '1' },
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
    (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
    child.stdin?.end(input);
  });
}

export async function saveIntegrateSnapshot(repo: string, paths: string[]): Promise<string> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-index-'));
  const run = snapshotGit(repo, path.join(temp, 'index'));
  try {
    const head = (await run(['rev-parse', 'HEAD'])).trim();
    await run(['read-tree', head], undefined, true);
    const staged = await run(['diff', '--cached', '--binary', '--full-index', head, '--', ...paths]);
    if (staged) await run(['apply', '--cached', '--binary', '-'], staged, true);
    const indexTree = (await run(['write-tree'], undefined, true)).trim();
    const indexCommit = (await run(['commit-tree', indexTree, '-p', head, '-m', 'muster integrate index'])).trim();
    await run(['add', '-A', '--', ...paths], undefined, true);
    const workTree = (await run(['write-tree'], undefined, true)).trim();
    const oid = (await run(['commit-tree', workTree, '-p', head, '-p', indexCommit, '-m', 'muster integrate snapshot'])).trim();
    const ref = `refs/muster/integrate/${randomUUID()}`;
    // Pin before clearing anything. Any failure retains the recovery object and names it.
    await run(['update-ref', ref, oid]);
    try {
      await run(['reset', '-q', head, '--', ...paths]);
      const tracked = (await run(['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean);
      if (tracked.length) await run(['restore', '--source', head, '--staged', '--worktree', '--', ...tracked]);
      // Restored CRLF files can retain an old racily-clean stat entry. Refresh only
      // the selected entries without staging content or touching unrelated WIP.
      if (tracked.length) await run(['add', '--refresh', '--', ...tracked]);
      await run(['clean', '-fd', '--', ...paths]);
    } catch (error) {
      throw new Error(`${String(error)}; recovery: git stash apply --index ${ref}`);
    }
    return ref;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** Apply through an isolated index, then copy only owned paths back to the real index.
 * Otherwise stash --index can reject unrelated staged files or unstage them. */
export async function restoreIntegrateSnapshot(repo: string, ref: string, paths: string[]): Promise<void> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-restore-'));
  const run = snapshotGit(repo, path.join(temp, 'index'));
  try {
    await run(['read-tree', 'HEAD'], undefined, true);
    await run(['stash', 'apply', '--index', ref], undefined, true);
    const entries = await run(['ls-files', '--stage', '-z', '--', ...paths], undefined, true);
    await run(['update-index', '--force-remove', '--', ...paths]);
    if (entries) await run(['update-index', '-z', '--index-info'], entries);
    await run(['update-ref', '-d', ref]);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
