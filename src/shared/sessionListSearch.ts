/**
 * 左栏会话列表即时过滤：匹配名称 / 胶囊文案 / 摘要（以及 runtime/cwd/shell，兼容旧搜索）。
 * 纯函数，不碰 process。
 */

export type SessionListSearchFields = {
  name?: string;
  cwd?: string | null;
  shellProfileId?: string | null;
  runtime?: string | null;
  liveStatus?: { label?: string; summary?: string } | null;
};

export function matchSessionListQuery(
  s: SessionListSearchFields,
  q: string,
  runtimeLabel = ''
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const live = s.liveStatus?.label ?? '';
  const summary = s.liveStatus?.summary ?? '';
  const hay =
    `${s.name ?? ''} ${runtimeLabel} ${s.shellProfileId ?? ''} ${live} ${summary} ${s.cwd ?? ''}`.toLowerCase();
  return hay.includes(needle);
}
