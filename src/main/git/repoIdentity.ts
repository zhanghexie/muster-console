import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathKey } from '../pathKey';
import { gitCommandEnvironment } from './gitEnvironment';

const exec = promisify(execFile);

/** Git prints canonical paths while Windows callers may use \\?\ or Junction aliases. */
function physicalKey(value: string): string {
  const real = fs.realpathSync.native(value);
  const canonical = real.startsWith('\\\\?\\UNC\\') ? `\\\\${real.slice(8)}`
    : real.startsWith('\\\\?\\') ? real.slice(4) : real;
  return pathKey(canonical);
}

/** Git's gitfile and commondir paths are relative to their containing directories. */
export function readGitDirectories(root: string): { gitDir: string; commonDir: string } | null {
  try {
    const dotGit = path.join(root, '.git');
    const stat = fs.statSync(dotGit);
    let gitDir = dotGit;
    if (stat.isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!match) return null;
      gitDir = path.resolve(root, match[1]!.trim());
    } else if (!stat.isDirectory()) return null;
    const commonFile = path.join(gitDir, 'commondir');
    const commonDir = fs.existsSync(commonFile)
      ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim())
      : gitDir;
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd, windowsHide: true, env: gitCommandEnvironment(), encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024
  });
  return stdout;
}

export interface RepoIdentity {
  root: string;
  commonDir: string;
  mainRepo: string;
  linked: boolean;
}

/** Resolve the registered primary checkout, without inferring it from directory ancestry. */
export async function resolveRepoIdentity(cwd: string, mainCandidates: string[] = []): Promise<RepoIdentity | null> {
  try {
    while (!fs.existsSync(cwd) && path.dirname(cwd) !== cwd) cwd = path.dirname(cwd);
    if (fs.existsSync(cwd) && !fs.statSync(cwd).isDirectory()) cwd = path.dirname(cwd);
    const root = path.resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
    const commonDir = path.resolve((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const raw = await git(root, ['worktree', 'list', '--porcelain', '-z']);
    const records = raw.split('\0\0').map((record) => record.split('\0'));
    const first = records[0];
    // A bare repository has no primary checkout to integrate into.
    if (!first || first.includes('bare')) return null;
    const entry = first.find((field) => field.startsWith('worktree '));
    if (!entry) return null;
    const rootDirs = readGitDirectories(root);
    const primaryPath = path.resolve(entry.slice('worktree '.length));
    const coreWorktree = await git(root, ['config', '--local', '--get', 'core.worktree']).then(value => value.trim(), () => '');
    const corePath = coreWorktree ? path.resolve(commonDir, coreWorktree) : undefined;
    const physical = physicalKey;
    const commonKey = physical(commonDir), primaryKey = physical(primaryPath);
    // --separate-git-dir reports the metadata directory as its primary record.
    // Only known source checkouts (or the current primary itself) can resolve it.
    const knownSources = new Set(mainCandidates.flatMap(candidate => {
      try { return [physical(candidate)]; } catch { return []; }
    }));
    if (rootDirs && physical(rootDirs.gitDir) === commonKey) knownSources.add(physical(root));
    const candidates = [
      ...(rootDirs && pathKey(rootDirs.gitDir) === pathKey(rootDirs.commonDir) ? [root] : []),
      ...mainCandidates,
      ...(corePath ? [corePath] : []),
      primaryPath
    ];
    const matches = candidates.filter((candidate) => {
      const dirs = readGitDirectories(candidate);
      if (!dirs) return false;
      try {
        const candidateKey = physical(candidate);
        if (physical(dirs.gitDir) !== commonKey || physical(dirs.commonDir) !== commonKey) return false;
        return (primaryKey !== commonKey && candidateKey === primaryKey)
          || Boolean(corePath && candidateKey === physical(corePath))
          || (primaryKey === commonKey && !corePath && knownSources.has(candidateKey));
      } catch { return false; }
    });
    if (new Set(matches.map(physical)).size !== 1) return null;
    const mainRepo = matches[0]!;
    // Never adopt a stale/missing main registration or a replacement repository.
    const mainCommon = path.resolve((await git(mainRepo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (physical(mainCommon) !== commonKey) return null;
    const listed = records.some((fields) => fields.some((field) => {
      if (!field.startsWith('worktree ')) return false;
      try { return physical(field.slice(9)) === physical(root); } catch { return false; }
    }));
    if (!listed && physical(root) !== physical(mainRepo)) return null;
    return { root, commonDir, mainRepo, linked: physical(root) !== physical(mainRepo) };
  } catch {
    return null;
  }
}

/** A missing/broken gitfile must not fall through to an unrelated enclosing repo. */
export async function resolveRegisteredWorktree(root: string, mainCandidates: string[] = []): Promise<RepoIdentity | null> {
  const dirs = readGitDirectories(root);
  if (!dirs) return null;
  const identity = await resolveRepoIdentity(root, mainCandidates);
  if (!identity || !identity.linked) return null;
  try {
    const physical = physicalKey;
    if (physical(identity.root) !== physical(root)) return null;
    const privateDir = physical(dirs.gitDir), common = physical(dirs.commonDir);
    if (!privateDir.startsWith(`${common}/worktrees/`)) return null;
    const back = fs.readFileSync(path.join(dirs.gitDir, 'gitdir'), 'utf8').trim();
    if (!path.isAbsolute(back) || physical(path.dirname(back)) !== physical(root) || path.basename(back) !== '.git') return null;
    return identity;
  } catch { return null; }
}
