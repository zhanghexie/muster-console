import { t } from '../../shared/i18n';
import type { DesktopIndicatorSnapshot } from '../../shared/desktopIndicator';

/** Resolve labels in the host's current locale when a visible desktop run is created. */
export function desktopIndicatorLabels(): DesktopIndicatorSnapshot['labels'] {
  return { active: t('AI 正在操作电脑'), stopping: t('正在停止电脑操作'), unknown: t('电脑操作结果未知'),
    escape: t('按 Esc 停止'), stop: t('停止'), escapeUnavailable: t('按停止按钮结束') };
}
