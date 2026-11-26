import type { AppContext } from '../context';
import type { Orchestrator } from '../agent/orchestrator';
import type { WorkspaceSwitchResult } from '../../shared/types';
import { ensureSchedulerDefaultSubscriptions } from '../awareness/defaults';
import { ensureWorkspaceMetaAgent } from '../metaAgent/ensureForApp';
import { errorMessage } from '../../shared/errors';
import { reapplyActiveTheme } from './themes';
import { controlRootFor, defaultCwdFor, requireWorkspace } from '../workspacePaths';

export function resolveWorkspacePath(ctx: AppContext, workspaceId?: string): string {
  return defaultCwdFor(requireWorkspace(ctx.config.get(), workspaceId));
}

export function resolveWorkspaceControlRoot(ctx: AppContext, workspaceId?: string): string {
  return controlRootFor(requireWorkspace(ctx.config.get(), workspaceId));
}

export function applyWorkspaceActivation(
  ctx: AppContext,
  orchestrator: Orchestrator,
  syncFsWatches: () => void,
  res: WorkspaceSwitchResult
): WorkspaceSwitchResult {
  if (!res.ok || !res.activeWorkspaceId) return res;
  if (ctx.awareness) {
    try {
      ensureSchedulerDefaultSubscriptions(ctx.awareness, [res.activeWorkspaceId]);
    } catch (err) {
      console.error('[awareness] 调度默认订阅播种失败', err);
    }
  }
  const wsPath = resolveWorkspaceControlRoot(ctx, res.activeWorkspaceId);
  ensureWorkspaceMetaAgent(ctx, wsPath);
  ctx.extensionSystem?.refresh();
  ctx.sessions.adoptActiveForWorkspace(res.activeWorkspaceId);
  try {
    orchestrator.bindWorkspace(res.activeWorkspaceId);
  } catch (err) {
    return { ...res, ok: false, message: errorMessage(err) };
  }
  syncFsWatches();
  ctx.getWindow()?.webContents.send('workspaces:changed', {
    workspaces: res.workspaces,
    activeWorkspaceId: res.activeWorkspaceId
  });
  // 工作区可带独立主题：激活后按新活跃区重放生效主题（窗口底色 + themes:changed 换肤）
  reapplyActiveTheme(ctx);
  return res;
}
