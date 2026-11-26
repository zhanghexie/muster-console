import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createExtensionAtomicRenamer, ExtensionAtomicRenameError } from './extensionAtomicRename';
import { validateExtensionManifest } from '../../shared/extensionManifest';
import type { ExtensionManifest } from '../../shared/extensionManifest';
import type { ExtensionCenterPackageArtifact } from '../../shared/extensionCenter';

const EXCLUDED_ROOT_NAMES = new Set(['data', 'cache', '.git']);
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ExtensionPackageFile { path: string; bytes: Buffer; executable: boolean }
export interface ExtensionPackageSnapshot {
  fingerprint: string;
  directories: string[];
  files: ExtensionPackageFile[];
  /** Excluded entries are never copied or discarded by a directory replacement. */
  excluded: string[];
}

export function encodeExtensionPackage(extensionId: string, snapshot: ExtensionPackageSnapshot): Buffer {
  const artifact: ExtensionCenterPackageArtifact = {
    schemaVersion: 1, extensionId, fingerprint: snapshot.fingerprint, directories: snapshot.directories,
    files: snapshot.files.map(file => ({ path: file.path, bytesBase64: file.bytes.toString('base64'), ...(file.executable ? { executable: true } : {}) })),
  };
  return Buffer.from(JSON.stringify(artifact));
}

/** Match the module loader's interpretation using only captured package bytes. */
export function createExtensionModuleFormatResolver(snapshot: ExtensionPackageSnapshot): (relative: string) => 'module' | 'commonjs' | 'json' {
  const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  const sources = new Map(snapshot.files.map(file => [key(file.path), file.bytes]));
  return relative => {
    assertExtensionPackagePath(relative);
    const extension = path.posix.extname(relative).toLowerCase();
    if (extension === '.mjs') return 'module';
    if (extension === '.cjs') return 'commonjs';
    if (extension === '.json') return 'json';
    if (extension !== '.js') throw new Error('This module type cannot be bound to reviewed bytes');
    let parent = path.posix.dirname(relative);
    for (;;) {
      const file = parent === '.' ? 'package.json' : `${parent}/package.json`;
      const bytes = sources.get(key(file));
      if (bytes) {
        let parsed: { type?: unknown };
        try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid package.json in approved extension: ${file}`); }
        return parsed.type === 'module' ? 'module' : 'commonjs';
      }
      if (parent === '.') break;
      parent = path.posix.dirname(parent);
    }
    return 'commonjs';
  };
}

function hashString(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4); length.writeUInt32BE(bytes.length);
  hash.update(length).update(bytes);
}

function assertSnapshotPaths(snapshot: Pick<ExtensionPackageSnapshot, 'directories' | 'files'>): void {
  const seen = new Set<string>();
  for (const rel of [...snapshot.directories, ...snapshot.files.map(file => file.path)]) {
    assertExtensionPackagePath(rel);
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate extension package path: ${rel}`);
    seen.add(key);
  }
}

export function assertExtensionPackagePath(rel: string): void {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || rel.includes('\\') || rel.includes('\0') || path.posix.isAbsolute(rel)
    || rel.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment))
    || EXCLUDED_ROOT_NAMES.has(rel.split('/')[0].toLowerCase())) throw new Error(`Invalid extension package path: ${rel}`);
}

/** Hashes the bytes themselves, paths, empty directories and executable flags. */
export function fingerprintExtensionSnapshot(snapshot: Pick<ExtensionPackageSnapshot, 'directories' | 'files'>): string {
  assertSnapshotPaths(snapshot);
  const hash = createHash('sha256').update('muster-extension\0');
  for (const directory of [...snapshot.directories].sort()) { hash.update('d'); hashString(hash, directory); }
  for (const file of [...snapshot.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update('f'); hashString(hash, file.path); hash.update(file.executable ? '1' : '0');
    const length = Buffer.allocUnsafe(8); length.writeBigUInt64BE(BigInt(file.bytes.length));
    hash.update(length).update(file.bytes);
  }
  return `package-extension:${hash.digest('hex')}`;
}

/** Hash private captured buffers in bounded chunks so large packages yield to the event loop. */
export async function fingerprintExtensionSnapshotAsync(snapshot: Pick<ExtensionPackageSnapshot, 'directories' | 'files'>): Promise<string> {
  assertSnapshotPaths(snapshot);
  const hash = createHash('sha256').update('muster-extension\0');
  let entries = 0;
  for (const directory of [...snapshot.directories].sort()) {
    hash.update('d'); hashString(hash, directory);
    if (++entries % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  for (const file of [...snapshot.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update('f'); hashString(hash, file.path); hash.update(file.executable ? '1' : '0');
    const length = Buffer.allocUnsafe(8); length.writeBigUInt64BE(BigInt(file.bytes.length)); hash.update(length);
    for (let offset = 0; offset < file.bytes.length; offset += 4 * 1024 * 1024) {
      hash.update(file.bytes.subarray(offset, offset + 4 * 1024 * 1024));
      if (offset + 4 * 1024 * 1024 < file.bytes.length) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (++entries % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return `package-extension:${hash.digest('hex')}`;
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode;
}

/** Read files without importing, evaluating or following a package symlink. */
export function captureExtensionPackage(dir: string): ExtensionPackageSnapshot {
  const rootStat = fs.lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Extension package root must be a real directory');
  const directories: string[] = [];
  const files: ExtensionPackageFile[] = [];
  const excluded: string[] = [];
  let bytes = 0;
  const walk = (relative: string): void => {
    const absolute = path.join(dir, ...relative.split('/').filter(Boolean));
    const before = fs.lstatSync(absolute);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Extension directory changed during capture');
    const names = fs.readdirSync(absolute).sort();
    for (const name of names) {
      if (!relative && EXCLUDED_ROOT_NAMES.has(name.toLowerCase())) { excluded.push(name); continue; }
      const rel = relative ? `${relative}/${name}` : name;
      const file = path.join(absolute, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Extension package contains a symbolic link: ${rel}`);
      if (stat.isDirectory()) { directories.push(rel); walk(rel); continue; }
      if (!stat.isFile() || files.length + 1 > MAX_FILES || (bytes += stat.size) > MAX_BYTES) throw new Error('Extension package exceeds capture limits');
      // open + fstat catches replacement between lstat and read. On Unix O_NOFOLLOW
      // also closes the symlink race; Windows checks the opened identity below.
      const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0));
      const fd = fs.openSync(file, flags);
      try {
        const opened = fs.fstatSync(fd);
        if (!sameFile(stat, opened) || !opened.isFile()) throw new Error(`Extension file changed during capture: ${rel}`);
        const content = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        if (!sameFile(opened, after) || content.length !== opened.size || !sameFile(after, fs.lstatSync(file))) throw new Error(`Extension file changed during capture: ${rel}`);
        files.push({ path: rel, bytes: content, executable: (stat.mode & 0o111) !== 0 });
      } finally { fs.closeSync(fd); }
    }
    const after = fs.lstatSync(absolute);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw new Error('Extension directory changed during capture');
  };
  walk('');
  if (!files.some(file => file.path === 'extension.json')) throw new Error('Extension manifest is missing');
  const snapshot = { directories, files, excluded, fingerprint: '' };
  snapshot.fingerprint = fingerprintExtensionSnapshot(snapshot);
  return snapshot;
}

/** The same complete-byte capture as above, with filesystem waits off the main loop. */
export async function captureExtensionPackageAsync(dir: string): Promise<ExtensionPackageSnapshot> {
  const rootStat = await fs.promises.lstat(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Extension package root must be a real directory');
  const directories: string[] = [], files: ExtensionPackageFile[] = [], excluded: string[] = [];
  let bytes = 0;
  const walk = async (relative: string): Promise<void> => {
    const absolute = path.join(dir, ...relative.split('/').filter(Boolean));
    const before = await fs.promises.lstat(absolute);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Extension directory changed during capture');
    const names = (await fs.promises.readdir(absolute)).sort();
    for (const name of names) {
      if (!relative && EXCLUDED_ROOT_NAMES.has(name.toLowerCase())) { excluded.push(name); continue; }
      const rel = relative ? `${relative}/${name}` : name;
      const file = path.join(absolute, name);
      const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Extension package contains a symbolic link: ${rel}`);
      if (stat.isDirectory()) { directories.push(rel); await walk(rel); continue; }
      if (!stat.isFile() || files.length + 1 > MAX_FILES || (bytes += stat.size) > MAX_BYTES) throw new Error('Extension package exceeds capture limits');
      const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0));
      const handle = await fs.promises.open(file, flags);
      try {
        const opened = await handle.stat();
        if (!sameFile(stat, opened) || !opened.isFile()) throw new Error(`Extension file changed during capture: ${rel}`);
        const content = await handle.readFile();
        const after = await handle.stat();
        if (!sameFile(opened, after) || content.length !== opened.size || !sameFile(after, await fs.promises.lstat(file))) throw new Error(`Extension file changed during capture: ${rel}`);
        files.push({ path: rel, bytes: content, executable: (stat.mode & 0o111) !== 0 });
      } finally { await handle.close(); }
    }
    const after = await fs.promises.lstat(absolute);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw new Error('Extension directory changed during capture');
  };
  await walk('');
  if (!files.some(file => file.path === 'extension.json')) throw new Error('Extension manifest is missing');
  const snapshot = { directories, files, excluded, fingerprint: '' };
  snapshot.fingerprint = await fingerprintExtensionSnapshotAsync(snapshot);
  return snapshot;
}

/** Complete review evidence. Oversized packages need an explicit human fallback. */
export function extensionSafetyEvidence(snapshot: ExtensionPackageSnapshot): string {
  if (fingerprintExtensionSnapshot(snapshot) !== snapshot.fingerprint) throw new Error('Extension snapshot changed before review');
  if (snapshot.files.reduce((total, file) => total + file.bytes.length, 0) > MAX_EVIDENCE_BYTES) throw new Error('Extension exceeds the 50 MiB limit for complete automatic safety review');
  const files = snapshot.files.map(file => {
    const decoded = file.bytes.includes(0) ? undefined : file.bytes.toString('utf8');
    return { path: file.path, executable: file.executable, content: decoded === undefined || !Buffer.from(decoded, 'utf8').equals(file.bytes) ? `base64:${file.bytes.toString('base64')}` : decoded };
  });
  return JSON.stringify({ fingerprint: snapshot.fingerprint, directories: snapshot.directories, files });
}

/** Validate identity and every declared entry against the same captured bytes. */
export function validateExtensionPackage(snapshot: ExtensionPackageSnapshot, id: string): ExtensionManifest {
  if (fingerprintExtensionSnapshot(snapshot) !== snapshot.fingerprint) throw new Error('Extension snapshot was modified');
  const source = snapshot.files.find(file => file.path === 'extension.json');
  if (!source || source.bytes.length > 64 * 1024) throw new Error('Extension manifest is missing or too large');
  let raw: unknown;
  try { raw = JSON.parse(source.bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Extension manifest is not valid JSON'); }
  const validated = validateExtensionManifest(raw, id);
  if (!validated.ok) throw new Error(validated.error);
  const manifest = validated.manifest;
  const entries = [
    manifest.surface.entry,
    manifest.domain?.entry,
    manifest.commandEntry,
    manifest.agent?.systemPrompt,
    ...(manifest.agent?.skills ?? []),
    ...(manifest.agent?.mcp ?? [])
  ].filter((value): value is string => !!value);
  const files = new Set(snapshot.files.map(file => file.path));
  for (const entry of entries) if (!files.has(entry)) throw new Error(`Extension entry is missing from package: ${entry}`);
  return manifest;
}

/** Materialize only captured content in a new directory; never merge or overwrite. */
export function writeExtensionPackageDirectory(destination: string, snapshot: ExtensionPackageSnapshot): void {
  if (fingerprintExtensionSnapshot(snapshot) !== snapshot.fingerprint) throw new Error('Extension snapshot was modified');
  let created = false;
  try {
    fs.mkdirSync(destination); created = true;
    for (const directory of snapshot.directories) fs.mkdirSync(path.join(destination, ...directory.split('/')), { recursive: true });
    for (const file of snapshot.files) {
      const dest = path.join(destination, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
      if (process.platform !== 'win32') fs.chmodSync(dest, file.executable ? 0o755 : 0o644);
    }
    if (captureExtensionPackage(destination).fingerprint !== snapshot.fingerprint) throw new Error('Staged extension snapshot does not match review');
  } catch (error) {
    if (created && fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function writeExtensionPackageDirectoryAsync(destination: string, snapshot: ExtensionPackageSnapshot): Promise<void> {
  if (fingerprintExtensionSnapshot(snapshot) !== snapshot.fingerprint) throw new Error('Extension snapshot was modified');
  let created = false;
  try {
    await fs.promises.mkdir(destination); created = true;
    for (const directory of snapshot.directories) await fs.promises.mkdir(path.join(destination, ...directory.split('/')), { recursive: true });
    for (const file of snapshot.files) {
      const dest = path.join(destination, ...file.path.split('/'));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, file.bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
      if (process.platform !== 'win32') await fs.promises.chmod(dest, file.executable ? 0o755 : 0o644);
    }
    if ((await captureExtensionPackageAsync(destination)).fingerprint !== snapshot.fingerprint) throw new Error('Staged extension snapshot does not match review');
  } catch (error) {
    if (created) await fs.promises.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

const snapshotWrites = new Map<string, Promise<string>>();

/**
 * Write an immutable, content-addressed distribution snapshot. The snapshot is
 * a distribution source only; runtime paths must still refer to the workspace copy.
 */
export async function saveExtensionPackageSnapshot(store: string, id: string, snapshot: ExtensionPackageSnapshot, options: {
  rename?: (from: string, to: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
} = {}): Promise<string> {
  if (!ID.test(id) || !/^package-extension:[a-f0-9]{64}$/.test(snapshot.fingerprint)) throw new Error('Invalid extension snapshot identity');
  if (fingerprintExtensionSnapshot(snapshot) !== snapshot.fingerprint) throw new Error('Extension snapshot was modified');
  const fingerprint = snapshot.fingerprint;
  const parent = path.join(store, id);
  const target = path.join(parent, fingerprint.slice('package-extension:'.length));
  const pending = snapshotWrites.get(target);
  if (pending) return pending;
  const write = saveSnapshot();
  snapshotWrites.set(target, write);
  try { return await write; } finally { if (snapshotWrites.get(target) === write) snapshotWrites.delete(target); }

  async function saveSnapshot(): Promise<string> {
  await fs.promises.mkdir(parent, { recursive: true });
  const exists = async (file: string): Promise<boolean> => {
    try { await fs.promises.lstat(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const verifyExisting = async (): Promise<string> => {
    const existing = await captureExtensionPackageAsync(target);
    if (existing.fingerprint !== fingerprint || existing.excluded.length) throw new Error('Stored extension snapshot is corrupt');
    return target;
  };
  if (await exists(target)) {
    try { return await verifyExisting(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') throw error;
      // Preserve corrupt bytes for inspection; never merge or delete them.
      if (await exists(target)) {
        const preserved = path.join(parent, `.corrupt-${randomUUID()}`);
        (options.rename ?? createExtensionAtomicRenamer())(target, preserved);
        console.warn(`[extension] corrupt approved snapshot preserved: ${preserved}`);
      }
    }
  }
  const temp = path.join(parent, `.stage-${randomUUID()}`);
  try {
    await writeExtensionPackageDirectoryAsync(temp, snapshot);
    const rename = options.rename ?? createExtensionAtomicRenamer();
    const wait = options.wait ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const delays = [25, 75, 150];
    for (let attempt = 0; ; attempt++) {
      try { rename(temp, target); break; }
      catch (error) {
        if (await exists(target)) return await verifyExisting();
        const retryable = error instanceof ExtensionAtomicRenameError && error.errorNumber !== undefined &&
          (error.platform === 'win32' ? [5, 32, 33].includes(error.errorNumber)
            : (error.platform === 'darwin' || error.platform === 'linux') && [1, 13, 16, 26].includes(error.errorNumber));
        if (!retryable || attempt >= delays.length) throw error;
        await wait(delays[attempt]);
      }
    }
    return await verifyExisting();
  } finally { await fs.promises.rm(temp, { recursive: true, force: true }); }
  }
}

export class ExtensionPublishConflict extends Error {}

/** Only descend through actual directories beneath the host-selected root. */
function checkPublishParent(root: string, parent: string, create: boolean): void {
  const relative = path.relative(root, parent);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Extension publish path escaped its source root');
  let directory = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    directory = path.join(directory, segment);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(directory); }
    catch (error) {
      if (!create || !segment || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(directory);
      stat = fs.lstatSync(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Extension publish parent must be a real directory');
  }
}

export async function publishExtensionPackageDirectory(target: string, snapshot: ExtensionPackageSnapshot, options: {
  root: string;
  expectedFingerprint?: string;
  rename?: (from: string, to: string) => void;
  privateRename?: (from: string, to: string) => void;
  isCurrent?: () => boolean;
}): Promise<void> {
  if (!path.isAbsolute(target) || !path.isAbsolute(options.root)) throw new Error('Extension publish paths must be absolute');
  const parent = path.dirname(target);
  checkPublishParent(options.root, parent, true);
  const rename = options.rename ?? createExtensionAtomicRenamer();
  const privateRename = options.privateRename ?? createExtensionAtomicRenamer(undefined, undefined, undefined, true);
  const transaction = randomUUID();
  const stage = path.join(parent, `.extension-stage-${transaction}`);
  const previous = path.join(parent, `.extension-previous-${transaction}`);
  const moved: string[] = [];
  let displaced = false;
  await writeExtensionPackageDirectoryAsync(stage, snapshot);
  try {
    // Keep the installed path available while hashing. There is no await
    // between the final baseline check, private-entry moves and activation.
    checkPublishParent(options.root, parent, false);
    if (options.expectedFingerprint) {
      if (!fs.existsSync(target)) throw new ExtensionPublishConflict('Extension was removed while editing');
      const old = await captureExtensionPackageAsync(target);
      if (old.fingerprint !== options.expectedFingerprint) throw new ExtensionPublishConflict('Extension changed while editing');
      checkPublishParent(options.root, parent, false);
      rename(target, previous);
      displaced = true;
      for (const name of old.excluded) {
        privateRename(path.join(previous, name), path.join(stage, name));
        moved.push(name);
      }
    } else if (fs.existsSync(target)) throw new ExtensionPublishConflict('Extension already exists');
    if (options.isCurrent && !options.isCurrent()) throw new ExtensionPublishConflict('Extension publish target changed before activation');
    rename(stage, target);
  } catch (error) {
    try {
      checkPublishParent(options.root, parent, false);
      for (const name of moved.reverse()) privateRename(path.join(stage, name), path.join(previous, name));
      if (displaced) rename(previous, target);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Extension rollback failed; recovery directories: ${previous}, ${stage}`);
    }
    await fs.promises.rm(stage, { recursive: true, force: true });
    throw error;
  }
  if (displaced) await fs.promises.rm(previous, { recursive: true });
}
