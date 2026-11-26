import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from './atomicJson';

/**
 * 关键注册表读写（P9）：主文件 + `.bak` 备份。
 * 解析失败时回退备份，避免静默变成空表（定时任务重启后消失）。
 */
export function backupName(file: string): string {
  return file.replace(/\.json$/i, '.bak.json');
}

export function tryReadJson<T>(abs: string): { ok: true; value: T } | { ok: false; corrupt: boolean } {
  try {
    const raw = fs.readFileSync(abs, 'utf-8');
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, corrupt: false };
    return { ok: false, corrupt: true };
  }
}

export function loadRegistryJson<T>(dir: string, file: string, fallback: T, resolveFile?: (file: string) => string): T {
  const primary = resolveFile?.(file) ?? path.join(dir, file);
  const bak = backupName(primary);
  const first = tryReadJson<T>(primary);
  if (first.ok) return first.value;
  if (first.corrupt) {
    console.error(`[store] ${file} 解析失败，尝试备份`);
  }
  const second = tryReadJson<T>(bak);
  if (second.ok) {
    console.error(`[store] 已从 ${backupName(file)} 恢复 ${file}`);
    try {
      writeJsonAtomicSync(primary, second.value);
    } catch (err) {
      console.error(`[store] 写回 ${file} 失败`, err);
    }
    return second.value;
  }
  if (first.corrupt) {
    console.error(`[store] ${file} 与备份均不可用，回退空数据`);
  }
  return fallback;
}

export function saveRegistryJson(dir: string, file: string, data: unknown, resolveFile?: (file: string) => string): void {
  const primary = resolveFile?.(file) ?? path.join(dir, file);
  const bak = backupName(primary);
  writeJsonAtomicSync(primary, data);
  try {
    writeJsonAtomicSync(bak, data);
  } catch (err) {
    console.error(`[store] 写备份 ${backupName(file)} 失败`, err);
  }
}
