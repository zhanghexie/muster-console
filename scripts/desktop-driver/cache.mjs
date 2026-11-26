// Internal output policy. The public entry point fixes projectRoot to this checkout.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(first, second) {
  return path.relative(first, second) === '' && path.relative(second, first) === '';
}

// Check every existing ancestor, including the selected root, without following links.
export function assertUnlinkedDirectory(directory) {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Directory or ancestor is a link or not a directory: ${current}`);
  }
  const actual = fs.realpathSync.native(absolute);
  if (!samePath(absolute, actual)) throw new Error(`Directory resolves to another path: ${absolute}`);
}

function git(projectRoot, args) {
  const env = { ...process.env };
  // Do not let inherited Git overrides redirect these checks to another repository or index.
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  const result = spawnSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8', windowsHide: true, env, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error(`Git cache validation failed: ${result.error.message}`);
  return result;
}

function assertNoNestedGit(parent, projectRoot) {
  let current = parent;
  while (!samePath(current, projectRoot)) {
    try {
      fs.lstatSync(path.join(current, '.git'));
      throw new Error(`Nested Git worktree is not an allowed cache: ${current}`);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    const next = path.dirname(current);
    if (samePath(next, current)) throw new Error('Cache is not inside the project');
    current = next;
  }
}

function assertOutsideGit(directory) {
  let current = directory;
  for (;;) {
    try {
      fs.lstatSync(path.join(current, '.git'));
      throw new Error('Driver preparation must be outside every Git worktree or in the controlled project cache');
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (samePath(parent, current)) break;
    current = parent;
  }
}

function assertControlledCache(projectRoot, parent, target) {
  const cache = path.join(projectRoot, '.tmp', 'desktop-driver');
  if (!within(cache, parent)) throw new Error('Only the project .tmp/desktop-driver cache is allowed inside a Git worktree');
  assertUnlinkedDirectory(cache);
  assertNoNestedGit(parent, projectRoot);

  const top = git(projectRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.stdout.trim()) throw new Error(`Unable to verify the project Git worktree: ${top.stderr.trim()}`);
  const reported = fs.realpathSync.native(path.resolve(top.stdout.trim()));
  if (!samePath(reported, projectRoot)) throw new Error('Project path is not the Git worktree root');

  // Check the root and the proposed output. An ignored ancestor keeps the whole
  // cache ignored; --no-index also tests the rule when tracked files exist.
  for (const item of [cache, target]) {
    const relative = path.relative(projectRoot, item).split(path.sep).join('/');
    const ignored = git(projectRoot, ['check-ignore', '--quiet', '--no-index', '--', relative]);
    if (ignored.status === 1) throw new Error(`Controlled cache path is not Git-ignored: ${relative}`);
    if (ignored.status !== 0) throw new Error(`Unable to check Git ignore rules: ${ignored.stderr.trim()}`);
  }
  // Case-insensitive pathspec is conservative on case-sensitive filesystems and
  // prevents Windows/macOS indexes with differently cased names being missed.
  const tracked = git(projectRoot, ['ls-files', '--cached', '-z', '--', ':(icase,literal).tmp/desktop-driver']);
  if (tracked.status !== 0) throw new Error(`Unable to check tracked cache files: ${tracked.stderr.trim()}`);
  if (tracked.stdout.length) throw new Error('Controlled cache contains Git-tracked files');
}

function validateLocation(output, projectRoot) {
  if (typeof output !== 'string' || !path.isAbsolute(output)) throw new Error('Output must be an absolute path');
  if (output.split(/[\\/]+/).includes('..')) throw new Error('Output path cannot contain parent traversal');
  const absolute = path.resolve(output), project = path.resolve(projectRoot), parent = path.dirname(absolute);
  if (samePath(absolute, path.parse(absolute).root)) throw new Error('Output cannot be a filesystem root');
  assertUnlinkedDirectory(project);
  assertUnlinkedDirectory(parent);
  if (within(project, parent)) assertControlledCache(project, parent, absolute);
  else assertOutsideGit(parent);
  return { parent, target: absolute, projectRoot: project };
}

// Exported for isolated fixture tests; production supplies its own fixed projectRoot.
export function outputLocation(output, projectRoot) {
  const location = validateLocation(output, projectRoot), absolute = location.target;
  try { fs.lstatSync(absolute); throw new Error('Output already exists; choose a new directory'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return location;
}

// Build inputs must still satisfy the cache rules even if they were valid when prepared.
export function existingLocation(output, projectRoot) {
  const location = validateLocation(output, projectRoot);
  assertUnlinkedDirectory(location.target);
  if (within(location.projectRoot, location.target)) assertNoNestedGit(location.target, location.projectRoot);
  return location;
}

export function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) throw new Error(`Cannot identify owned directory: ${directory}`);
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(first, second) { return first.dev === second.dev && first.ino === second.ino; }

export function cleanupOwnedScratch(scratch, parent, identity) {
  assertUnlinkedDirectory(parent);
  const current = directoryIdentity(scratch);
  if (!sameIdentity(current, identity)) throw new Error('Scratch directory was replaced; cleanup refused');
  const resolved = fs.realpathSync.native(scratch);
  if (!samePath(resolved, scratch) || !samePath(path.dirname(resolved), parent) || !path.basename(resolved).startsWith('.cua-driver-')) {
    throw new Error('Scratch path escaped its parent; cleanup refused');
  }
  fs.rmSync(resolved, { recursive: true });
}

// Revalidate the policy immediately before exclusive creation; never replace an
// existing target. On failure, preserve the target and clean only owned scratch.
export function publishContents(contents, location) {
  const current = outputLocation(location.target, location.projectRoot);
  if (!samePath(current.parent, location.parent)) throw new Error('Output parent changed before publication');
  fs.mkdirSync(current.target, { mode: 0o700 });
  let identity;
  try { identity = directoryIdentity(current.target); }
  catch (error) { throw new Error(`Cannot identify new output directory; preserved at ${current.target}: ${error.message}`, { cause: error }); }
  try {
    assertUnlinkedDirectory(current.target);
    if (!sameIdentity(directoryIdentity(current.target), identity)) throw new Error('Output directory was replaced before publication');
    fs.renameSync(contents, path.join(current.target, 'contents'));
  } catch (error) {
    throw new Error(`Publication failed; output path was not removed: ${current.target}: ${error.message}`, { cause: error });
  }
}
