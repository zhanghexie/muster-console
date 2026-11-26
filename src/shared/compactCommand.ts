/**
 * /compact 本地命令解析（调度 Agent 与 GUI 会话共用，零依赖）：
 * `/compact` 或 `/compact <摘要侧重>`；匹配失败返回 null。
 * 命令不进模型上下文——渲染层拦截后走各自表面压缩通道，主进程 send 再兜一道。
 */
export function parseCompactCommand(text: string): { instructions?: string } | null {
  const m = /^\s*\/compact(?:\s+([\s\S]+))?\s*$/i.exec(text);
  if (!m) return null;
  const instructions = m[1]?.trim();
  return instructions ? { instructions } : {};
}
