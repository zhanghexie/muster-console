/**
 * 定时任务/新建任务共用的模型覆盖小工具：providerId|modelId 组合键与思考档文案。
 */
import type { GuiThinkingLevel } from '../../shared/types';

/** 'providerId|modelId' → { providerId, modelId }；缺半边返回 undefined */
export function parseModelKey(key: string): { providerId: string; modelId: string } | undefined {
  const cut = key.indexOf('|');
  if (cut <= 0) return undefined;
  return { providerId: key.slice(0, cut), modelId: key.slice(cut + 1) };
}

export function thinkingLabel(level: GuiThinkingLevel, t: (key: string) => string): string {
  switch (level) {
    case 'off':
      return t('关闭');
    case 'low':
      return t('低');
    case 'medium':
      return t('中');
    case 'high':
      return t('高');
    case 'max':
      return t('最高');
    default:
      return level;
  }
}
