import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathInExecutionDirectories } from '../workspaceExecutionContext';
import type { ExecutionDirectory } from '../../shared/workspaceExecutionContext';

/** Playwright's CDP file-payload limit applies to the total, not each file. */
const PLAYWRIGHT_UPLOAD_LIMIT = 50 * 1024 * 1024;
const SNAPSHOT_PREFIX = 'muster-upload-';
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_MARKER = 'muster-upload-snapshot-v1';
const liveSnapshots = new Set<string>();

function currentSnapshotPath(directory: string): boolean {
  const info = fs.lstatSync(directory);
  return info.isDirectory() && !info.isSymbolicLink() &&
    path.dirname(fs.realpathSync.native(directory)) === fs.realpathSync.native(os.tmpdir()) &&
    path.basename(directory).startsWith(`${SNAPSHOT_PREFIX}${process.pid}-`);
}

/** Only reclaim our own old directories after their creating process has exited. */
export async function cleanupAbandonedUploadSnapshots(now = Date.now(), tempRoot = os.tmpdir(), alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}): Promise<void> {
  const temp = await fs.promises.realpath(tempRoot);
  for (const entry of await fs.promises.readdir(temp, { withFileTypes: true })) {
    const match = /^muster-upload-(\d+)-[A-Za-z0-9]+$/.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(temp, entry.name);
    try {
      const stat = await fs.promises.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < SNAPSHOT_MAX_AGE_MS) continue;
      if (alive(Number(match[1]))) continue;
      if (path.dirname(await fs.promises.realpath(directory)) !== temp) continue;
      const marker = path.join(directory, '.owner');
      const markerStat = await fs.promises.lstat(marker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || await fs.promises.readFile(marker, 'utf8') !== SNAPSHOT_MARKER) continue;
      await fs.promises.rm(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[browser] stale upload snapshot cleanup failed:', String(error));
    }
  }
}

process.once('exit', () => {
  for (const directory of liveSnapshots) {
    try {
      if (!currentSnapshotPath(directory)) throw new Error('Upload snapshot directory identity changed');
      fs.rmSync(directory, { recursive: true, force: true });
    }
    catch (error) { console.warn('[browser] upload snapshot exit cleanup failed:', String(error)); }
  }
});

/** Resolve against the caller's captured read scope, never a model-supplied workspace. */
export function resolveUploadFiles(files: unknown, cwd: string, readableDirectories: readonly ExecutionDirectory[]): string[] {
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !file.trim() || file.includes('\0'))) {
    throw new Error('files must be an array of non-empty file paths');
  }
  return files.map(file => {
    const absolute = path.resolve(cwd, file);
    if (!pathInExecutionDirectories(absolute, cwd, readableDirectories)) {
      throw new Error('Upload file is outside the caller read scope or the scope is stale');
    }
    const physical = fs.realpathSync.native(absolute);
    if (!pathInExecutionDirectories(physical, cwd, readableDirectories) || !fs.statSync(physical).isFile()) {
      throw new Error('Upload target is not a readable file within the caller read scope');
    }
    fs.accessSync(physical, fs.constants.R_OK);
    return physical;
  });
}

/** Copy opened files into a private temporary directory before passing paths to Chromium. */
export async function snapshotUploadFiles(files: unknown, cwd: string, readableDirectories: readonly ExecutionDirectory[]): Promise<{
  paths: string[]; objects: Array<{ path: string; size: number; sha256: string }>; cleanup: () => Promise<void>
}> {
  const resolved = resolveUploadFiles(files, cwd, readableDirectories);
  if (!resolved.length) return { paths: [], objects: [], cleanup: async () => {} };
  if (resolved.reduce((total, file) => total + fs.statSync(file).size, 0) >= PLAYWRIGHT_UPLOAD_LIMIT) {
    throw new Error('Browser upload requires less than 50 MiB total with the current Playwright transport');
  }
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${SNAPSHOT_PREFIX}${process.pid}-`));
  liveSnapshots.add(directory);
  const cleanup = async () => {
    if (!currentSnapshotPath(directory)) throw new Error('Upload snapshot directory identity changed');
    await fs.promises.rm(directory, { recursive: true, force: true });
    liveSnapshots.delete(directory);
  };
  try {
    await fs.promises.writeFile(path.join(directory, '.owner'), SNAPSHOT_MARKER, { flag: 'wx', mode: 0o600 });
    const paths: string[] = [];
    const objects: Array<{ path: string; size: number; sha256: string }> = [];
    let totalBytes = 0;
    for (const [index, source] of resolved.entries()) {
      const input = await fs.promises.open(source, 'r');
      try {
        const before = await input.stat();
        totalBytes += before.size;
        if (totalBytes >= PLAYWRIGHT_UPLOAD_LIMIT) throw new Error('Browser upload requires less than 50 MiB total with the current Playwright transport');
        const current = await fs.promises.stat(source);
        if (!before.isFile() || before.dev !== current.dev || before.ino !== current.ino ||
            resolveUploadFiles([source], cwd, readableDirectories)[0] !== source) {
          throw new Error('Upload file changed while preparing the snapshot');
        }
        const parent = path.join(directory, String(index));
        await fs.promises.mkdir(parent, { mode: 0o700 });
        const destination = path.join(parent, path.basename(source));
        const output = await fs.promises.open(destination, 'wx', 0o600);
        const hash = createHash('sha256');
        try {
          const buffer = Buffer.allocUnsafe(128 * 1024);
          let remaining = before.size;
          while (remaining > 0) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining), null);
            if (!bytesRead) throw new Error('Upload file changed while preparing the snapshot');
            remaining -= bytesRead;
            hash.update(buffer.subarray(0, bytesRead));
            let written = 0;
            while (written < bytesRead) {
              const count = (await output.write(buffer, written, bytesRead - written)).bytesWritten;
              if (!count) throw new Error('Upload snapshot write made no progress');
              written += count;
            }
          }
        } finally { await output.close(); }
        const after = await input.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error('Upload file changed while preparing the snapshot');
        }
        paths.push(destination);
        objects.push({ path: source, size: before.size, sha256: hash.digest('hex') });
      } finally { await input.close(); }
    }
    return { paths, objects, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
