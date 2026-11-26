/**
 * 渲染层时间/格式小工具：跨组件共用，避免各写一份。
 */

/** HH:MM（本机时区）；非法时间戳返回空串 */
export function hm(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
