/**
 * 输入区（composer）操作失败/被拒提示的出口：系统桌面 toast（notify:toast IPC）。
 *
 * 背景（2026-10-20 用户定稿）：输入框上方的 hint 提示条（.agent-composer-hint）整体
 * 移除——成功确认（已发送 / 已插话 / 已清空 / 已加入手动确认）不再提示；但失败不可
 * 静默（工作区规约「不可静默失败」）：被拒、失败、回落到非预期路径都改走桌面通知。
 *
 * 不传 workspaceId：composer 的 workspaceId prop 可能是会话 id 兜底（ChatSurfaceView
 * `props.workspaceId ?? surface.sessionId`），不能当工作区归属用；主进程按
 * activeWorkspaceId 归组（与 notify:list / 渲染层崩溃推送同款兜底）。
 */

/** 输入区失败/被拒提示 → 系统桌面 toast。通知通道自身异常不再二次打扰。 */
export function notifyComposerError(message: string): void {
  const text = (message ?? '').trim();
  if (!text) return;
  try {
    void window.api?.notify?.toast?.({ text });
  } catch {
    /* toast 通道异常本身不再弹提示 */
  }
}
