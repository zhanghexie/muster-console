/**
 * 默认名会话的首条用户指令 → 会话名（纯函数，主进程/测试共用）。
 * 折叠全部空白（含换行）为单空格后取前 N 个码点；无可用文本返回 undefined。
 */
export const AUTO_SESSION_NAME_MAX = 10;

export function deriveAutoSessionName(text: string, max = AUTO_SESSION_NAME_MAX): string | undefined {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return Array.from(collapsed).slice(0, max).join('');
}
