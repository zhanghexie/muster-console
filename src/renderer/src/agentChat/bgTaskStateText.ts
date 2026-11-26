/**
 * 后台任务状态一句话（胶囊 title / 面板列表 / 详情头部共用）。
 * 独立成模块：BgTasksPanel（含 xterm 终端，重）懒加载后，胶囊 tooltip 仍要
 * 即时可用，不许跟着面板 chunk 走。
 */
import type { BgTaskRecord } from '../../../shared/backgroundTasks';
import { t } from '../../../shared/i18n';

export function bgTaskStateText(task: BgTaskRecord): string {
  const kindLabel =
    task.kind === 'subagent' ? t('子代理') : task.kind === 'shell' ? t('后台终端') : t('定时器');
  if (task.status === 'running') {
    if (task.kind === 'timer' && task.wakeAt) {
      const left = Math.max(0, task.wakeAt - Date.now());
      const min = Math.round(left / 60000);
      return kindLabel + (min >= 1
        ? t('运行中（剩约 {{n}} 分钟）', { n: min })
        : t('运行中（剩约 {{n}} 秒）', { n: Math.round(left / 1000) }));
    }
    return `${kindLabel}${t('运行中')}`;
  }
  if (task.status === 'done') return `${kindLabel}${t('已完成')}`;
  if (task.status === 'cancelled') return `${kindLabel}${t('已取消')}`;
  return `${kindLabel}${t('失败')}${typeof task.exitCode === 'number' ? t('失败（exit {{n}}）', { n: task.exitCode }) : ''}`;
}
