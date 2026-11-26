import { t } from './i18n';

/** Host-owned mailbox errors are translated only when displayed to a person. */
export const MAILBOX_UI_ERROR_KEYS = [
  'text 不能为空', '寄信标识最多 200 字符', '相同寄信标识对应不同内容，请使用新的标识',
  '邮箱包含无效或重复条目，需要修复原文件', '邮箱收件位置无效，需要修复原文件',
  '收信已取消，未写入已读回执', '正文索引不存在', '邮箱不存在',
] as const;
export const MAILBOX_UI_ERROR_TEMPLATES = [
  { prefix: '旧邮箱读取失败，迁移未完成：', key: '旧邮箱读取失败，迁移未完成：{{detail}}' },
  { prefix: '旧邮箱迁移失败，原文件已保留：', key: '旧邮箱迁移失败，原文件已保留：{{detail}}' },
  { prefix: '邮箱索引读取失败，已保留原文件：', key: '邮箱索引读取失败，已保留原文件：{{detail}}' },
  { prefix: '信件已保存，语义索引待修复：', key: '信件已保存，语义索引待修复：{{detail}}' },
] as const;
const known = new Set<string>(MAILBOX_UI_ERROR_KEYS);

export function localizeMailboxUserText(value: string, depth = 0): string {
  if (known.has(value)) return t(value);
  if (depth < 3) {
    const item = MAILBOX_UI_ERROR_TEMPLATES.find(entry => value.startsWith(entry.prefix));
    if (item) return t(item.key, { detail: localizeMailboxUserText(value.slice(item.prefix.length), depth + 1) });
  }
  const tooLong = /^信件正文(?:过长（最多|超过) (\d+) 字符(?:）)?，未保存$/.exec(value);
  if (tooLong) return t('信件正文过长（最多 {{n}} 字符），未保存', { n: tooLong[1] });
  const missingSession = /^收信会话不存在：([a-zA-Z0-9:_-]+)$/.exec(value);
  if (missingSession) return t('收信会话不存在：{{id}}', { id: missingSession[1] });
  const bodyConflict = /^信件 ([a-zA-Z0-9:_-]+) 正文文件已存在但内容不同$/.exec(value);
  if (bodyConflict) return t('信件 {{id}} 正文文件已存在但内容不同', { id: bodyConflict[1] });
  const bodyFailure = /^信件 ([a-zA-Z0-9:_-]+) 正文读取失败：([\s\S]*)$/.exec(value);
  if (bodyFailure) return t('信件 {{id}} 正文读取失败：{{detail}}', {
    id: bodyFailure[1], detail: known.has(bodyFailure[2]) ? t(bodyFailure[2]) : bodyFailure[2]
  });
  return value;
}
