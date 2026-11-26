import type { AppConnectionNamePlaceholder } from './agentApps';
import { t } from './i18n';

/** Host-generated source names stay stable in storage and protocol responses. */
export const APP_CONNECTION_NAME_PLACEHOLDERS: Record<AppConnectionNamePlaceholder, { source: string; key: string; numbered: boolean }> = {
  'feishu-private': { source: '飞书私聊', key: '飞书私聊 {{n}}', numbered: true },
  'feishu-group': { source: '飞书群聊', key: '飞书群聊 {{n}}', numbered: true },
  'feishu-paired': { source: '我的飞书私聊', key: '我的飞书私聊', numbered: false },
  'feishu-unnamed': { source: '未命名会话', key: '未命名会话', numbered: false },
};

export function appConnectionNameSource(kind: AppConnectionNamePlaceholder, n?: number): string {
  const spec = APP_CONNECTION_NAME_PLACEHOLDERS[kind];
  return spec.numbered ? `${spec.source} ${n}` : spec.source;
}

export function validAppConnectionName(name: string, kind?: AppConnectionNamePlaceholder): boolean {
  if (!kind || !Object.hasOwn(APP_CONNECTION_NAME_PLACEHOLDERS, kind)) return false;
  const spec = APP_CONNECTION_NAME_PLACEHOLDERS[kind];
  if (!spec.numbered) return name === spec.source;
  const prefix = `${spec.source} `;
  return name.startsWith(prefix) && /^[1-9]\d*$/.test(name.slice(prefix.length));
}

/** Never infer a placeholder from an old or externally supplied name. */
export function appConnectionNameText(connection: { name: string; namePlaceholder?: AppConnectionNamePlaceholder }): string {
  if (!validAppConnectionName(connection.name, connection.namePlaceholder)) return connection.name;
  const spec = APP_CONNECTION_NAME_PLACEHOLDERS[connection.namePlaceholder!];
  return spec.numbered ? t(spec.key, { n: connection.name.slice(spec.source.length + 1) }) : t(spec.key);
}
