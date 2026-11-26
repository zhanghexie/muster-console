import type { UiBridge } from '../uiBridge';
import { t } from '../../shared/i18n';
import type { DesktopTaskConfirmation } from './schedulerTaskEpoch';
export const ALL_DISPLAY_APP = 'desktop:all-displays';
export const SCREEN_READ_ACTION = 'screen-read';

/** Internal host confirmation; callers must provide trusted target descriptions. */
export function makeSchedulerTaskConfirmation(ui: Pick<UiBridge, 'confirmWithReceipt'>) {
  return async (request: DesktopTaskConfirmation, signal?: AbortSignal): Promise<{ approvalId?: string }> => {
    signal?.throwIfAborted();
    const safe = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
    const screenRead = request.appId === ALL_DISPLAY_APP && request.actionClass === SCREEN_READ_ACTION;
    const app = safe(screenRead ? t('所有显示器') : request.appId), action = safe(screenRead ? t('读取屏幕截图') : request.actionClass);
    if (!app || !action || (request.kind !== 'start' && request.kind !== 'extend')) throw new Error('Invalid desktop task confirmation');
    const title = request.kind === 'start' ? t('开始新桌面任务链？') : t('扩展当前桌面任务链？');
    let detail = request.kind === 'start'
      ? t('将新建桌面任务链并绑定目标应用“{{app}}”和动作类“{{action}}”。授权最长 24 小时，任务结束或撤销时失效。', { app, action })
      : t('将扩展当前桌面任务链，允许目标应用“{{app}}”和动作类“{{action}}”；不会新建任务链。', { app, action });
    if (screenRead) {
      detail += '\n' + t('系统采集接口会读取所有显示器的画面，即使最终只返回一个显示器。');
    }
    const receipt = await ui.confirmWithReceipt(title, detail, { dangerous: true, confirmLabel: t('允许'), cancelLabel: t('拒绝'), signal });
    signal?.throwIfAborted();
    const decision = receipt.decision;
    return decision.confirmed === true && !decision.cancelledBy &&
      (decision.kind === 'allowOnce' || decision.kind === 'allowAlways') && typeof receipt.approvalId === 'string' && receipt.approvalId.trim()
      ? { approvalId: receipt.approvalId } : {};
  };
}
