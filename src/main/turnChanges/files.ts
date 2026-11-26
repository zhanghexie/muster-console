import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SKIP_DIR_NAMES } from '../workspaceSkipDirs';
import { TURN_FILE_LIMIT } from '../../shared/turnChanges';

export const MAX_FILE = TURN_FILE_LIMIT;
export const MAX_TOTAL = 64 * 1024 * 1024;
export const MAX_FILES = 6000;
export const SKIP = new Set([...SKIP_DIR_NAMES, '.muster', '.dev-sandbox', '.dev-sandbox-template', 'test-results']);
const SKIP_KEYS = new Set([...SKIP].map(p => p.toLowerCase()));
export const skipped = (part: string) => SKIP_KEYS.has(part.toLowerCase());
export type Image = { text: string; stamp: string; mode: number; clock?: { mtime: number; ctime: number; birth: number; size: number } };
export type CapturedImage = Image | { oversized: true; text?: undefined; stamp: string; contentStamp: string };
const clock = (st: fs.Stats) => ({ mtime: st.mtimeMs, ctime: st.ctimeMs, birth: st.birthtimeMs, size: st.size });
export type Root = { path: string; physical: string };
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
export const stamp = (st: fs.Stats) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
export function physicalFile(roots: readonly Root[], abs: string): string | undefined {
  const root = roots.filter(r => inside(r.path, abs)).sort((a, b) => b.path.length - a.path.length)[0];
  return root && path.join(root.physical, path.relative(root.path, abs));
}
/** No symlinks, junctions, hardlinks, or host storage. Validate every path component. */
export function checkedPath(roots: Root[], abs: string, strict = false): boolean {
  const root = roots.filter(r => inside(r.path, abs)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!root) return false;
  try {
    if (fs.realpathSync.native(root.path) !== root.physical) return false;
    let current = root.path;
    for (const part of path.relative(root.path, abs).split(path.sep).filter(Boolean)) {
      if (skipped(part)) return false;
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) return false; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { if (strict) throw e; return false; } }
    }
    return true;
  } catch (error) { if (strict) throw error; return false; }
}

export function readImage(roots: Root[], abs: string, strict = false): Image | null | undefined {
  if (!checkedPath(roots, abs, strict)) return undefined;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_FILE) return undefined;
    const data = fs.readFileSync(abs);
    if (data.includes(0)) return undefined;
    const text = data.toString('utf8');
    if (stamp(fs.statSync(abs)) !== stamp(st)) {
      if (strict) throw new Error(`文件在快照读取期间发生变化：${abs}`);
      return undefined;
    }
    if (!Buffer.from(text).equals(data)) return undefined;
    return { text, stamp: stamp(st), mode: st.mode, clock: clock(st) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (strict) throw e;
    return undefined;
  }
}

/** Settlement read off the main thread: readImage's strict rules, null for a missing file. */
export async function readImageAsync(roots: Root[], abs: string): Promise<CapturedImage | null | undefined> {
  if (!checkedPath(roots, abs, true)) return undefined;
  try { return await captureImage(roots, abs, true); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Async bulk reads: realpath exposes intermediate links without repeating one stat
 * per ancestor for every source file. Revert still validates every component afresh. */
export async function captureImage(roots: Root[], abs: string, strict = false): Promise<CapturedImage | undefined> {
  const root = roots.filter(r => inside(r.path, abs)).sort((a,b) => b.path.length-a.path.length)[0];
  if (!root || path.relative(root.path, abs).split(path.sep).some(skipped)) return undefined;
  try {
    const expected = path.join(root.physical, path.relative(root.path, abs));
    if (await fs.promises.realpath(abs) !== expected) return undefined;
    let fd: fs.promises.FileHandle;
    try { fd = await fs.promises.open(abs, 'r'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`文件在快照读取期间发生变化：${abs}`);
      throw error;
    }
    try {
      const st = await fd.stat();
      if (!st.isFile() || st.nlink !== 1) return undefined;
      const data = st.size > MAX_FILE ? undefined : await fd.readFile();
      let pathStat: fs.Stats;
      try { pathStat = await fs.promises.lstat(abs); }
      catch (error) {
        // ENOENT after opening is a concurrent replacement, not proof that the
        // original file was absent. Never turn that race into a new-file undo.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`文件在快照读取期间发生变化：${abs}`);
        throw error;
      }
      if (stamp(await fd.stat()) !== stamp(st) || stamp(pathStat) !== stamp(st) || pathStat.isSymbolicLink() || pathStat.nlink !== 1) {
        if (strict) throw new Error(`文件在快照读取期间发生变化：${abs}`);
        return undefined;
      }
      if (!data) return { oversized: true, stamp: stamp(st), contentStamp: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}` };
      if (data.includes(0)) return undefined;
      const text = data.toString('utf8');
      return Buffer.from(text).equals(data) ? { text, stamp: stamp(st), mode: st.mode, clock: clock(st) } : undefined;
    } finally { await fd.close(); }
  } catch (error) { if (strict) throw error; return undefined; }
}
