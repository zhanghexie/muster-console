import { getResolvedLocale, t } from './i18n';

/** Known host failures shown by workbench chrome, never author-provided diagnostics. */
export const UI_WIDGET_HOST_ERROR_KEYS = [
  '交互动作无效', '链接只支持 http 或 https', '交互动作文本为空或超过长度限制',
  '交互状态必须是 JSON 对象', '交互增量必须是有效 JSON 对象', '交互值增量须包含 value/private',
  '交互展示状态 collapsed 必须是布尔值', '部件路径无效', '部件不属于当前应用的会话目录',
  '部件实际路径越界', '部件实际路径越界（跨会话或文件别名）', '部件文件不存在', '部件回执数据无效',
  '会话 id 无效', '部件回执无效'
] as const;
const known = new Set<string>(UI_WIDGET_HOST_ERROR_KEYS);

export function localizeUiWidgetHostError(value: string): string {
  if (getResolvedLocale() === 'zh-CN') return value;
  const wrapped = /^(?:Error invoking remote method '[^']+': )?Error: ([\s\S]*)$/.exec(value);
  if (wrapped) {
    const localized = localizeUiWidgetHostError(wrapped[1]);
    return localized === wrapped[1] ? value : localized;
  }
  if (known.has(value)) return t(value);
  const size = /^交互状态超出 256 KiB：已用 (\d+) 字节，上限 (\d+) 字节；请只保存选择 ID 和界面参数$/.exec(value);
  if (size) return t('交互状态超出 256 KiB：已用 {{used}} 字节，上限 {{max}} 字节；请只保存选择 ID 和界面参数', { used: size[1], max: size[2] });
  const field = /^交互状态 (modelContent|privateContent) 必须是有效 JSON$/.exec(value);
  if (field) return t('交互状态 {{field}} 必须是有效 JSON', { field: field[1] });
  return value;
}
