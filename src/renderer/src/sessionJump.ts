/**
 * 跳到会话页的唯一渲染层入口。
 *
 * 已读合同：成功跳转（切区成功或无需切区）即 `markNeedsRead`，不依赖
 * `sessions:reveal` 回推——主进程通知点击会在切区同一拍发出 reveal，
 * App 上绑了 showTerminal 的监听可能被重绑拆掉，只堵通知入口会漏其它路径。
 * 主进程 `sessions.select` 仍发 reveal，StoreProvider
 * 另订一份稳定监听做兜底（见 `subscribeRevealNeedsRead`）。
 */
import { markNeedsRead } from './panels/needsReadStore';

export interface JumpToSessionInput {
  sessionId: string;
  workspaceId?: string;
  activeWorkspaceId?: string | null;
  switchWorkspace?: (id: string) => Promise<{ ok: boolean; message?: string }>;
}

export interface JumpToSessionResult {
  ok: boolean;
  message?: string;
}

/** 跳到会话：切区（如需）成功后标已读再 select。切区失败不算已读。 */
export async function jumpToSession(input: JumpToSessionInput): Promise<JumpToSessionResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return { ok: false, message: 'empty' };
  const workspaceId = input.workspaceId?.trim();
  if (workspaceId && input.switchWorkspace && workspaceId !== input.activeWorkspaceId) {
    const r = await input.switchWorkspace(workspaceId);
    if (!r.ok) return r;
  }
  markNeedsRead(sessionId);
  await window.api.sessions.select(sessionId);
  return { ok: true };
}

/** 主进程 reveal（通知点击 / sessions.select）的已读兜底。 */
export function subscribeRevealNeedsRead(): () => void {
  return window.api.on('sessions:reveal', (p) => {
    if (p?.sessionId) markNeedsRead(p.sessionId);
  });
}
