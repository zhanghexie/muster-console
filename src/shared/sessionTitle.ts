/** 历史会话标题相关纯函数（不碰 process，可在 test/ 里直接跑）。 */

import { t } from './i18n';

/** 标题最大字符数（与 listPiSessions 截断保持一致）。 */
export const SESSION_TITLE_MAX = 80;

/**
 * 计算历史会话展示标题：优先用用户自定义名（Pi session_info.name），
 * 否则回落到首条消息；都没有时给一个兜底文案。
 */
export function pickSessionTitle(args: {
  name?: string | null;
  firstMessage?: string | null;
  isTask?: boolean;
  taskName?: string;
}): string {
  const custom = (args.name ?? '').trim();
  if (custom) return custom.slice(0, SESSION_TITLE_MAX);
  const first = (args.firstMessage ?? '').trim();
  if (first) return first.slice(0, SESSION_TITLE_MAX);
  if (args.isTask)
    return args.taskName
      ? t('定时任务「{{name}}」', { name: args.taskName })
      : t('定时任务运行');
  return t('（无消息）');
}
