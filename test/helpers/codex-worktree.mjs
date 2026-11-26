import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function fixtureGit(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd, env: { ...env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

export function codexWorktreeFixture(source, tree, rootId = 'source', rootPath = source) {
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fixtureGit(source, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(source, 'src', 'baseline.txt'), 'tracked');
  fixtureGit(source, 'add', '--', 'src/baseline.txt');
  fixtureGit(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
  const branch = 'ao/f29c1e9d';
  fixtureGit(source, 'worktree', 'add', '-qb', branch, tree);
  const sourceRoot = { rootId, path: rootPath, cwd: source };
  const worktreeSource = { mainRepo: source, commonDir: path.join(source, '.git') };
  const group = { id: source, path: tree, sourceRoot, source: worktreeSource, branch, repos: [] };
  return { cwd: source, sourceRoot, worktreePath: tree, worktreeBranch: branch, worktreeSource,
    worktreeGroups: { version: 1, cwdPolicy: 'source', revision: 1, primaryGroupId: group.id, groups: [group] } };
}
