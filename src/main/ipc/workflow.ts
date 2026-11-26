/**
 * 脚本工作流面板 IPC（dynamic-workflow）：渲染层动作面——概览（清单 + 活跃/最近 run）、
 * 在卡片上答复问用户的问题、取消（可一并关闭派出的会话）、信任 / 撤销信任、
 * 停用 / 启用触发、删除工作流（移到回收站）、清理运行历史。
 * 变化推送走 workflow:changed（wiring.ts 节流），这里只是拉取与动作。
 */
import { handle } from './handle';
import type { AppContext } from '../context';
import { getWorkflowRuntime } from '../workflow/runtimeRef';
import type { WorkflowOverview } from '../../shared/workflow';
import { t } from '../../shared/i18n';

const EMPTY: WorkflowOverview = { workflows: [], active: [], recent: [] };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function registerWorkflowIpc(ctx: AppContext): void {
  const wsOf = (v: unknown): string => str(v) || ctx.config.get().activeWorkspaceId;
  const rt = () => {
    const r = getWorkflowRuntime();
    if (!r) throw new Error(t('工作流运行时未就绪'));
    return r;
  };

  handle('workflow:overview', (_e, workspaceId: string): WorkflowOverview => {
    const r = getWorkflowRuntime();
    if (!r) return EMPTY;
    try {
      return r.overview(wsOf(workspaceId));
    } catch {
      return EMPTY;
    }
  });

  /** 只答问用户的问题；问调度的由调度 workflow.reply 答 */
  handle('workflow:answer', (_e, workspaceId: string, runId: string, askId: string, answer: unknown) => {
    const ws = wsOf(workspaceId);
    const { ask } = rt().pendingHumanAsk(ws, str(runId));
    if (ask.askId !== str(askId)) throw new Error(t('问题已变化，请刷新后再答'));
    rt().answerHuman(ws, str(runId), ask.askId, answer ?? null);
    return true;
  });

  handle('workflow:cancel', (_e, workspaceId: string, runId: string, closeSessions: boolean) =>
    rt().cancel(wsOf(workspaceId), str(runId), t('用户在工作流面板取消'), { closeSessions: closeSessions === true, initiatedBy: 'human' })
  );

  handle('workflow:trust', (_e, workspaceId: string, name: string) => rt().trust(wsOf(workspaceId), str(name), 'human'));

  handle('workflow:revokeTrust', (_e, workspaceId: string, name: string) => {
    rt().revokeTrust(wsOf(workspaceId), str(name));
    return true;
  });

  handle('workflow:setTriggers', (_e, workspaceId: string, name: string, enabled: boolean) => {
    rt().setTriggersEnabled(wsOf(workspaceId), str(name), enabled === true);
    return true;
  });

  handle('workflow:clearRuns', (_e, workspaceId: string, runIds?: string[]) =>
    rt().clearRuns(wsOf(workspaceId), Array.isArray(runIds) ? runIds.map(str).filter(Boolean) : undefined)
  );

  handle('workflow:delete', async (_e, workspaceId: string, name: string) => {
    await rt().deleteWorkflow(wsOf(workspaceId), str(name));
    return true;
  });
}
