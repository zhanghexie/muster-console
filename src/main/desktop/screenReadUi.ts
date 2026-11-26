import type { UiBridge } from '../uiBridge';
import { t } from '../../shared/i18n';
import type { DisplayCaptureTarget } from './displayCapture';

/** The visible confirmation discloses the actual all-display thumbnail scope. */
export function makeScreenReadConfirmation(ui: Pick<UiBridge, 'confirm'>, sessionLabel: (sessionId: string) => string) {
  return async (sessionId: string, _target: Readonly<DisplayCaptureTarget>, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    const label = sessionLabel(sessionId).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    if (!label) throw new Error('Screen capture session label is unavailable');
    const result = await ui.confirm(t('扩展当前桌面任务链？'),
      t('会话“{{session}}”请求扩展当前任务链以读取截图。系统采集接口会读取所有显示器的画面，即使最终只返回一个显示器。授权仅对当前任务有效，撤销、任务结束或 24 小时后失效。', { session: label }),
      { dangerous: true, confirmLabel: t('允许读取'), cancelLabel: t('拒绝'), signal });
    signal?.throwIfAborted();
    return result.confirmed === true && (result.kind === 'allowOnce' || result.kind === 'allowAlways') && !result.cancelledBy;
  };
}
