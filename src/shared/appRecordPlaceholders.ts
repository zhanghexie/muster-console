import type { AppPlaceholderFields, AppPlaceholderKind, AppRecord, AppValues } from './agentApps';
import { t } from './i18n';

// These are persisted source values, not UI strings. The field check prevents a
// marker for one kind of content from translating a different field.
export const APP_RECORD_PLACEHOLDERS: Record<AppPlaceholderKind, { field: string; source: string }> = {
  'rss-no-title': { field: 'title', source: '无标题' },
  'mail-no-subject': { field: 'subject', source: '无主题' },
  'mail-body-omitted': { field: 'body', source: '邮件较大，正文未下载（上限 2 MB）' },
  'message-unknown-sender': { field: 'sender', source: '未知发送者' },
  'message-withdrawn': { field: 'body', source: '此消息已撤回' },
  'message-peer': { field: 'sender', source: '对方' },
  'message-group-member': { field: 'sender', source: '群成员' },
  'message-unknown-body': { field: 'body', source: '[消息]' },
};

export function appPlaceholderSource(kind: AppPlaceholderKind): string { return APP_RECORD_PLACEHOLDERS[kind].source; }

export function validAppPlaceholders(values: AppValues, fields?: AppPlaceholderFields): AppPlaceholderFields | undefined {
  const result: AppPlaceholderFields = {};
  for (const [field, kind] of Object.entries(fields ?? {})) {
    if (!Object.hasOwn(APP_RECORD_PLACEHOLDERS, kind)) continue;
    const expected = APP_RECORD_PLACEHOLDERS[kind];
    if (expected.field === field && values[field] === expected.source) result[field] = kind;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Display projection only; historical and user-supplied values stay unchanged. */
export function appRecordFieldText(record: AppRecord, field: string): unknown {
  const value = record.values[field], kind = record.placeholderFields?.[field];
  if (!kind || !Object.hasOwn(APP_RECORD_PLACEHOLDERS, kind)) return value;
  const expected = APP_RECORD_PLACEHOLDERS[kind];
  return expected.field === field && value === expected.source ? t(expected.source) : value;
}

export function clearChangedAppPlaceholders(record: AppRecord, values: AppValues): void {
  if (!record.placeholderFields) return;
  const remaining = { ...record.placeholderFields };
  for (const field of Object.keys(values)) delete remaining[field];
  if (Object.keys(remaining).length) record.placeholderFields = remaining;
  else delete record.placeholderFields;
}
