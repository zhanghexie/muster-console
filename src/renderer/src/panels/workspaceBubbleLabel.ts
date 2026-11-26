import { t } from '../../../shared/i18n';

export type BubbleLabelMode = 'name' | 'docked' | 'live';

export function resolveBubbleLabel(input: {
  panelOpen: boolean;
  workspaceName: string;
  /** 调度回合实时状态（思考中/生成中/执行工具…）；active 时抢显示 */
  liveText?: string;
  liveActive?: boolean;
}): { text: string; mode: BubbleLabelMode } {
  if (input.panelOpen) return { text: t('正在对话'), mode: 'docked' };
  if (input.liveActive && input.liveText?.trim()) {
    return { text: input.liveText.trim(), mode: 'live' };
  }
  return { text: input.workspaceName, mode: 'name' };
}
