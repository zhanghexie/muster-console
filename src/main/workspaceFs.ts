import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideRoot, toPosixRel } from '../shared/workspacePath';
import { isTextPreviewKind, previewKindForPath } from '../shared/filePreview';
import type { FsDirEntry, FsReadResult, FsStatResult, FsWriteResult } from '../shared/types';
import { t } from '../shared/i18n';
import { SKIP_DIR_NAMES } from './workspaceSkipDirs';
import { resolveRealPathInsideRoot } from './workspacePaths';
import { pathKey } from './pathKey';

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 列一层目录。dirRel 为空或 '.' 表示 workspace 根。
 */
export async function listDir(root: string, dirRel = ''): Promise<FsDirEntry[]> {
  const absRoot = path.resolve(root);
  const target = await resolveRealPathInsideRoot(absRoot, dirRel || '.');

  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    throw new Error(`listDir failed: ${(err as Error).message ?? err}`);
  }

  const out: FsDirEntry[] = [];
  for (const ent of entries) {
    const name = String(ent.name);
    if (name === '.' || name === '..') continue;
    if (ent.isDirectory() && SKIP_DIR_NAMES.has(name)) continue;
    if (!ent.isDirectory() && !ent.isFile()) continue;
    const abs = path.join(target, name);
    let relativePath: string;
    try {
      relativePath = toPosixRel(absRoot, abs);
    } catch {
      continue;
    }
    out.push({
      name,
      isDirectory: ent.isDirectory(),
      relativePath
    });
  }

  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Read-only file tree view. Logical names stay under the source root even when
 * their physical targets are outside it. Never use this resolver for mutations. */
export async function listTreeDir(root: string, dirRel = ''): Promise<FsDirEntry[]> {
  const absRoot = path.resolve(root);
  const target = resolveInsideRoot(absRoot, dirRel || '.');
  const relDir = toPosixRel(absRoot, target);
  const physicalRoot = await fs.realpath(absRoot);
  const ancestors = new Set([pathKey(physicalRoot)]);
  let current = absRoot;
  let viaSymbolicLink = false;
  for (const part of relDir.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const info = await fs.lstat(current);
    viaSymbolicLink ||= info.isSymbolicLink();
    const physical = await fs.realpath(current);
    const key = pathKey(physical);
    if (ancestors.has(key)) throw new Error(t('无效链接'));
    ancestors.add(key);
  }
  const physicalDir = await fs.realpath(target);
  const entries = await fs.readdir(target, { withFileTypes: true, encoding: 'utf8' });
  const result = await Promise.all(entries.map(async (entry): Promise<FsDirEntry | null> => {
    const name = String(entry.name);
    if (name === '.' || name === '..') return null;
    const relativePath = relDir ? `${relDir}/${name}` : name;
    const isSymbolicLink = entry.isSymbolicLink();
    let isDirectory = entry.isDirectory();
    let physical = path.join(physicalDir, name);
    if (isSymbolicLink) {
      try {
        const logical = path.join(target, name);
        const info = await fs.stat(logical);
        if (!info.isDirectory() && !info.isFile()) return null;
        isDirectory = info.isDirectory();
        physical = await fs.realpath(logical);
        if (isDirectory && ancestors.has(pathKey(physical))) {
          return { name, relativePath, isDirectory: false, isSymbolicLink: true, viaSymbolicLink, linkError: t('无效链接') };
        }
      } catch (error) {
        return { name, relativePath, isDirectory: false, isSymbolicLink: true, viaSymbolicLink,
          linkError: String((error as Error).message ?? error) };
      }
    } else if (!entry.isDirectory() && !entry.isFile()) return null;
    if (isDirectory && SKIP_DIR_NAMES.has(name)) return null;
    let externalPath: string | undefined;
    try { toPosixRel(physicalRoot, physical); }
    catch { externalPath = physical; }
    return { name, relativePath, isDirectory, ...(isSymbolicLink ? { isSymbolicLink } : {}),
      ...(viaSymbolicLink ? { viaSymbolicLink } : {}), ...(externalPath ? { externalPath } : {}) };
  }));
  return result.filter((entry): entry is FsDirEntry => entry !== null).sort((a, b) =>
    a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));
}

export async function readText(root: string, filePath: string): Promise<FsReadResult> {
  try {
    const abs = await resolveRealPathInsideRoot(root, filePath);
    const st = await fs.stat(abs);
    if (!st.isFile()) return { ok: false, error: t('不是文件') };
    if (st.size > MAX_EDIT_BYTES) {
      return { ok: false, error: t('文件过大（>{{max}} 字节），无法在编辑器中打开', { max: MAX_EDIT_BYTES }) };
    }
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) return { ok: false, error: t('二进制文件，无法编辑') };
    return { ok: true, content: buf.toString('utf8'), mtimeMs: st.mtimeMs };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

/**
 * 工作区外文件的只读读取（预览用）：仅接受绝对路径，防护与 readText 一致
 * （大小上限/二进制拒绝），**没有对应的写通道**——写权限仍圈在工作区根内。
 */
export async function readTextExternal(absPath: string): Promise<FsReadResult> {
  try {
    if (!path.isAbsolute(absPath)) {
      return { ok: false, error: t('外部文件预览需要绝对路径') };
    }
    const abs = path.resolve(absPath);
    const st = await fs.stat(abs);
    if (!st.isFile()) return { ok: false, error: t('不是文件') };
    if (st.size > MAX_EDIT_BYTES) {
      return { ok: false, error: t('文件过大（>{{max}} 字节），无法在编辑器中打开', { max: MAX_EDIT_BYTES }) };
    }
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) return { ok: false, error: t('二进制文件，无法编辑') };
    return { ok: true, content: buf.toString('utf8'), mtimeMs: st.mtimeMs };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

export async function writeText(
  root: string,
  filePath: string,
  content: string,
  expectedMtimeMs?: number
): Promise<FsWriteResult> {
  try {
    if (!isTextPreviewKind(previewKindForPath(filePath))) {
      return { ok: false, error: t('拒绝覆盖媒体/预览类文件') };
    }
    const abs = await resolveRealPathInsideRoot(root, filePath);
    const st = await fs.stat(abs).catch(() => null);
    if (st && !st.isFile()) return { ok: false, error: t('不是文件') };
    // 乐观锁：磁盘 mtime 与读取基线不符说明有外部修改，拒绝盲目覆盖。
    // 1ms 容差吸收 mtimeMs 浮点/序列化误差；FAT 类 2s 精度文件系统上检测会变粗，可接受。
    if (st && expectedMtimeMs != null && Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
      return {
        ok: false,
        conflict: true,
        error: t('文件已在磁盘上被其他程序修改，已拒绝覆盖')
      };
    }
    await fs.writeFile(abs, content, 'utf8');
    const after = await fs.stat(abs).catch(() => null);
    return { ok: true, mtimeMs: after?.mtimeMs };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

/** 删除文件或目录（目录 recursive）。禁止删 workspace 根。 */
export async function removePath(root: string, targetRel: string): Promise<FsWriteResult> {
  try {
    const rel = String(targetRel ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/\/+$/, '');
    if (!rel || rel === '.') {
      return { ok: false, error: t('不能删除工作区根目录') };
    }
    const absRoot = path.resolve(root);
    const abs = await resolveRealPathInsideRoot(absRoot, rel);
    if (path.resolve(abs) === absRoot) {
      return { ok: false, error: t('不能删除工作区根目录') };
    }
    await fs.rm(abs, { recursive: true, force: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

export async function statPath(root: string, targetRel: string): Promise<FsStatResult> {
  try {
    const abs = await resolveRealPathInsideRoot(root, targetRel);
    const st = await fs.stat(abs);
    return {
      ok: true,
      size: st.size,
      isFile: st.isFile(),
      isDirectory: st.isDirectory()
    };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}
