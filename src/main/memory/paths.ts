/** Legacy canonical references remain for compatibility; live journal lives under memory/layout. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import {JOURNAL_HOME_REL} from './layout';

export const MEMORY_DIR_REL = path.join('docs', 'memory');
export const MEMORY_FILE_REL = path.join(MEMORY_DIR_REL, 'MEMORY.md');
export const RECOVERY_DIR_REL = path.join(MEMORY_DIR_REL, 'recovery');
export const JOURNAL_DIR_REL = JOURNAL_HOME_REL;
export const SCHEDULER_MEMORY_FILE_REL = path.join('.muster', 'scheduler', 'MEMORY.md');
export const FEATURES_DIR_REL = path.join('docs', 'features');

export function memoryFilePath(root: string): string {
  return path.join(root, MEMORY_FILE_REL);
}

export function recoveryDirFor(root: string): string {
  return path.join(root, RECOVERY_DIR_REL);
}

export function journalFilePath(root: string, dayKey: string): string {
  return path.join(root, JOURNAL_DIR_REL, `${dayKey}.md`);
}

/** 今日日期键 YYYY-MM-DD（journal 文件名与注入取样共用） */
export function todayKey(now?: Date): string {
  const d = now ?? new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 面板 hash 基准（sha1 前 16 位；与既有 memory:get 合同同算法） */
export function contentHash(text: string): string {
  return createHash('sha1').update(text ?? '', 'utf8').digest('hex').slice(0, 16);
}
