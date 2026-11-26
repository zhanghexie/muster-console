import fs from 'node:fs/promises';
import path from 'node:path';
import { shell } from 'electron';
import { normalizeShellPath } from './pathStat';
import { t } from '../../shared/i18n';
import { defaultProductWorktreesRoot } from '../runtimeKernel/storageRootResolver';

export async function openExternalUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: t('无效链接') };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: t('仅支持 http(s) 链接') };
  }
  try {
    await shell.openExternal(parsed.toString());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function revealPath(absPath: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeShellPath(absPath);
  const worktreesRoot = defaultProductWorktreesRoot();
  if (path.isAbsolute(normalized) && path.relative(worktreesRoot, normalized) === '') {
    // 首次使用时应用自有根可能还没有任务。仅允许创建这个固定目录。
    try {
      await fs.mkdir(worktreesRoot, { recursive: true });
    } catch (e) {
      return { ok: false, error: t('无法创建默认 worktree 目录。请检查写入权限或选择其他目录。{{error}}', {
        error: e instanceof Error ? e.message : String(e)
      }) };
    }
    return openSystemPath(worktreesRoot);
  }
  let st;
  try {
    st = await fs.stat(normalized);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR') return { ok: false, error: t('路径不存在') };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    if (st.isDirectory()) {
      const err = await shell.openPath(normalized);
      if (err) return { ok: false, error: err };
      return { ok: true };
    }
    shell.showItemInFolder(normalized);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Open a local file using the desktop's default application. */
export async function openSystemPath(absPath: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeShellPath(absPath);
  if (!normalized || !path.isAbsolute(normalized) || normalized.includes('\0')) {
    return { ok: false, error: t('无法确定文件路径') };
  }
  try {
    await fs.stat(normalized);
    const error = await shell.openPath(normalized);
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
