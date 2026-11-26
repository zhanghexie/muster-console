import type { AppContext } from '../context';

/** Sender IDs are bound by the host before persisting mail; never use model-supplied identity. */
export function canInterruptSession(ctx: AppContext, senderId: string, targetId: string): boolean {
  const target = ctx.sessions.get(targetId);
  if (!target || target.archived) return false;
  const sender = ctx.sessions.get(senderId);
  if (sender) return !sender.archived && target.parentSessionId === senderId;
  if (senderId.startsWith('orchestrator:')) {
    const workspaceId = senderId.slice('orchestrator:'.length);
    return !!workspaceId && ctx.workspaces.list().some(workspace => workspace.id === workspaceId);
  }
  return false;
}

export function assertInterruptPermission(ctx: AppContext, senderId: string, targetId: string): void {
  if (!canInterruptSession(ctx, senderId, targetId)) {
    throw new Error('interrupt 只允许调度或父会话中断自己的直接子会话，且目标必须可用。');
  }
}
