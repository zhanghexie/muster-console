/**
 * P5 / P11：Worker 看板上报与隔离树提交纪律的纯决策核。
 * 不替 Worker 决定提交说明正文；只判断要不要 warning / 回注 / 兜底提交。
 */

/** 回合开始后这么短时间内报 needs_you 须带 reason，否则 warning（P5） */
export const EARLY_NEEDS_YOU_MS = 60_000;

import { t } from './i18n';

export const HOST_FALLBACK_COMMIT_MARK = '[host] P11';

export function earlyNeedsYouWarning(
  elapsedMs: number | undefined,
  reason: string | undefined
): string | null {
  if (elapsedMs === undefined || elapsedMs < 0) return null;
  if (elapsedMs >= EARLY_NEEDS_YOU_MS) return null;
  if (typeof reason === 'string' && reason.trim()) return null;
  return t('【宿主提示 · P5】本回合开始仅 {{seconds}} 秒就报了 needs_you。读文档、写码、跑测试时只更新 note；确需等待用户时请补充 reason。看板未撤销。', { seconds: Math.round(elapsedMs / 1000) });
}

/** `git status --porcelain [-z]` 路径；NUL 模式重命名先给目标，再给来源。 */
export function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  if (porcelain.includes('\0')) {
    const entries = porcelain.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      paths.push(entry.slice(3));
      if (/[RC]/.test(entry.slice(0, 2))) i++;
    }
    return paths;
  }
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rest = line.length >= 3 ? line.slice(3) : line.trim();
    const arrow = rest.indexOf(' -> ');
    paths.push(arrow >= 0 ? rest.slice(arrow + 4) : rest);
  }
  return paths;
}

export function dirtyTreeRemindMessage(paths: string[], multipleGroups = false): string {
  const shown = paths.slice(0, 12);
  return t('【宿主提示 · P11】任务仓仍有未提交改动。请先在{{scope}}提交后再交付。未提交文件（共 {{total}} 个）：{{files}}。宿主不会替你决定提交说明；用户明确同意合入前不要 requestIntegrate。', {
    scope: multipleGroups ? t('各任务仓目录') : t('本任务仓目录'), total: paths.length, files: shown.join(', ')
  });
}

export function fallbackCommitMessage(): string {
  return `${HOST_FALLBACK_COMMIT_MARK}: dirty worktree at requestIntegrate (host snapshot, Worker did not author this message)`;
}

export type DirtyTreeAction = 'ok' | 'remind' | 'fallback-commit';

export function dirtyTreeAction(
  dirty: boolean,
  trigger: 'needs_you' | 'integrate'
): DirtyTreeAction {
  if (!dirty) return 'ok';
  return trigger === 'integrate' ? 'fallback-commit' : 'remind';
}
