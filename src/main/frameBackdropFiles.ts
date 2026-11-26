import { userDataStorage } from './runtimeKernel/storageRootResolver';
/**
 * 自定义壁纸落盘：选中的图片按内容哈希复制进 userData/backdrops/（同图不重复存），
 * 配置只存路径，渲染层经 muster-ext 协议引用；不再被全局/任何工作区引用的旧图清掉。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../shared/i18n';

export const WALLPAPER_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] as const;
export const WALLPAPER_MAX_BYTES = 20 * 1024 * 1024;

export function backdropsDir(userDataDir: string): string {
  return userDataStorage(userDataDir).resolve('app', 'backdrops');
}

export type ImportWallpaperResult = { ok: true; path: string } | { ok: false; error: string };

export function importWallpaper(userDataDir: string, srcPath: string): ImportWallpaperResult {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!(WALLPAPER_EXTS as readonly string[]).includes(ext)) {
    return { ok: false, error: t('不支持的图片格式：{{ext}}', { ext: ext || '?' }) };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(srcPath);
  } catch {
    return { ok: false, error: t('图片不存在或无法读取') };
  }
  if (!stat.isFile()) return { ok: false, error: t('图片不存在或无法读取') };
  if (stat.size > WALLPAPER_MAX_BYTES) {
    return { ok: false, error: t('图片超过 {{mb}}MB，请换一张小一点的', { mb: WALLPAPER_MAX_BYTES / 1024 / 1024 }) };
  }
  const buf = fs.readFileSync(srcPath);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const dir = backdropsDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${hash}.${ext === 'jpeg' ? 'jpg' : ext}`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  return { ok: true, path: dest };
}

/** 删掉 backdrops/ 里不在 keep 中的文件；keep 之外的路径（不在本目录）一律不碰 */
export function pruneWallpapers(userDataDir: string, keep: readonly string[]): number {
  const dir = backdropsDir(userDataDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const keepSet = new Set(keep.map((p) => path.resolve(p).toLowerCase()));
  let removed = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    if (keepSet.has(path.resolve(full).toLowerCase())) continue;
    try {
      fs.unlinkSync(full);
      removed++;
    } catch {
      /* 占用中下次再清 */
    }
  }
  return removed;
}
