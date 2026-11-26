import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitCommandArgs, gitCommandEnvironment } from './git/gitEnvironment';

type GitRunner = (cwd: string, args: string[]) => string;

function runGit(cwd: string, args: string[]): string {
  try {
    // On Windows CreateProcess can reject a long cwd before Git starts. Keep
    // the process cwd short and let Git resolve the target with longpaths on.
    const commandArgs = process.platform === 'win32' ? ['-C', path.toNamespacedPath(cwd), ...args] : args;
    return execFileSync('git', gitCommandArgs(commandArgs), {
      cwd: process.platform === 'win32' ? path.parse(cwd).root : cwd,
      env: gitCommandEnvironment(), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    }).trim();
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    const hint = process.platform === 'win32' ? ' Use a shorter sandbox/project path if Windows or Git reports a path-length error.' : '';
    throw new Error(`[devSandbox:git] git ${args.join(' ')} in ${cwd} failed: ${e.stderr || e.message || String(err)}${hint}`);
  }
}

function writeFiles(baseDir: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(baseDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function assertOwnRepository(repoDir: string, git: GitRunner): void {
  const gitDir = path.join(repoDir, '.git');
  if (!fs.lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`[devSandbox:git] missing local .git directory: ${repoDir}`);
  }
  const actual = fs.realpathSync.native(git(repoDir, ['rev-parse', '--show-toplevel']));
  const expected = fs.realpathSync.native(repoDir);
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(actual) !== normalize(expected)) {
    throw new Error(`[devSandbox:git] repository root mismatch: expected ${expected}, got ${actual}`);
  }
}

/** An incomplete previous init is an error, not a successfully seeded workspace. */
export function needsSeedRepo(repoDir: string): boolean {
  if (!fs.existsSync(path.join(repoDir, '.git'))) return true;
  assertOwnRepository(repoDir, runGit);
  try { runGit(repoDir, ['rev-parse', '--verify', 'HEAD']); }
  catch (error) { throw new Error(`[devSandbox:git] incomplete demo repository ${repoDir}; reset the development sandbox. ${String(error)}`); }
  return false;
}

/** Seed only a real repository rooted at repoDir. Any Git failure aborts seeding. */
export function seedSingleRepo(
  repoDir: string,
  initialFiles: Record<string, string | Buffer>,
  initialCommit: string,
  extraBranch?: { branchName: string; files: Record<string, string | Buffer>; commitMsg: string },
  uncommittedModifications?: Record<string, string | Buffer>,
  git: GitRunner = runGit
): void {
  fs.mkdirSync(repoDir, { recursive: true });
  const gitDir = path.join(repoDir, '.git');
  if (fs.existsSync(gitDir)) throw new Error(`[devSandbox:git] repository already exists: ${repoDir}`);
  writeFiles(repoDir, initialFiles);
  git(repoDir, ['init', '-b', 'main']);

  const mutate = (args: string[]): void => { assertOwnRepository(repoDir, git); git(repoDir, args); };
  mutate(['config', '--local', 'user.name', 'Muster Console Demo']);
  mutate(['config', '--local', 'user.email', 'demo@muster.local']);
  mutate(['add', '.']);
  mutate(['commit', '-m', initialCommit]);
  if (extraBranch) {
    mutate(['checkout', '-b', extraBranch.branchName]);
    writeFiles(repoDir, extraBranch.files);
    mutate(['add', '.']);
    mutate(['commit', '-m', extraBranch.commitMsg]);
    mutate(['checkout', 'main']);
  }
  if (uncommittedModifications) writeFiles(repoDir, uncommittedModifications);
}
