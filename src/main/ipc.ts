import type { DomainRegistry } from './runtimeKernel/domainRegistry';
import { registerScopedIpc } from './ipc/handle';
import type { AppContext } from './context';
import type { Orchestrator } from './agent/orchestrator';
import type { WorkspaceFsWatcher } from './workspaceFsWatcher';
import { shouldSelectNotifySession } from '../shared/notifySession';
import { applyWorkspaceActivation } from './ipc/helpers';
import { registerSessionIpc } from './ipc/sessions';
import { registerCanvasLinkIpc } from './canvasLink';
import { registerAgentSessionIpc } from './ipc/agentSession';
import { registerWorkerRoutingIpc } from './ipc/workerRouting';
import { registerBgTasksIpc } from './ipc/backgroundTasks';
import { registerWorkflowIpc } from './ipc/workflow';
import { registerFsIpc } from './ipc/fs';
import { registerGitIpc } from './ipc/git';
import { registerPrIpc } from './ipc/pr';
import { registerWorkspaceIpc } from './ipc/workspaces';
import { registerAppIpc } from './ipc/app';
import { registerExtensionsExtensionIpc } from './ipc/extensions';
import { registerAgentAppsIpc } from './ipc/agentApps';
import { registerSafetyIpc } from './ipc/safety';
import { registerMessagingIpc } from './ipc/messaging';
import { registerMailPresentationIpc } from './messages/presentation';
import { registerThemeIpc } from './ipc/themes';
import { registerUsageIpc } from './ipc/usage';
import { registerEvidenceIpc } from './ipc/evidence';
import { registerTextToolsIpc } from './ipc/textTools';
import { registerKnowledgeIpc } from './memory/knowledgeIpc';
import { registerMemoryCuratorIpc } from './memory/curatorIpc';
import { registerMemoryCenterIpc } from './memory/ipc';
import { registerUpdaterIpc } from './ipc/updater';
import { registerInboundMcpIpc } from './ipc/inboundMcp';
import { registerCapabilityManagementIpc } from './ipc/capabilityManagement';
import { registerUiWidgetIpc } from './ipc/uiWidgets';
import { registerFeedbackIpc } from './ipc/feedback';
import { registerLocalStorageIpc } from './ipc/localStorage';
import { registerSessionRemindersIpc } from './ipc/sessionReminders';
import { registerProcessMonitorIpc } from './processMonitor';
import { registerBoardTodosIpc } from './ipc/boardTodos';

/**
 * 渲染层直连 IPC（用户在 UI 上的直接操作，不经过 Agent）。
 */
export function registerIpc(
  domains: DomainRegistry,
  ctx: AppContext,
  orchestrator: Orchestrator,
  fsWatcher?: WorkspaceFsWatcher,
  syncGitWatches?: () => void
): string[] {
  const syncFsWatches = (): void => {
    fsWatcher?.syncFromConfig();
    syncGitWatches?.();
  };
  const stopFsWatches = (): void => {
    fsWatcher?.stopAll();
  };
  domains.register({ id: 'desktop-ipc', dependsOn: ['orchestrator-events'], start: (_ctx, scope) => {
    syncFsWatches();
    scope.add(stopFsWatches);
    scope.add(() => ctx.ui.setNotifyClickHandler(null));

    // 系统 toast / 通知中心历史点击：切区 + select。select 发 sessions:reveal，
    // 渲染层 StoreProvider 的 subscribeRevealNeedsRead 标已读（与 jumpToSession 同语义）。
    ctx.ui.setNotifyClickHandler((workspaceId, sessionId) => {
      const res = ctx.workspaces.switchTo(workspaceId);
      applyWorkspaceActivation(ctx, orchestrator, syncFsWatches, res);
      const sid = sessionId?.trim();
      if (shouldSelectNotifySession(sid) && ctx.sessions.get(sid)) {
        void ctx.sessions.select(sid).catch((err) => {
          console.warn('[notify:click] select session failed', err);
        });
      }
    });

  } });
  const entries: Array<[string, () => void]> = [
    ['registerSessionIpc', () => registerSessionIpc(ctx)],
    ['registerCanvasLinkIpc', () => registerCanvasLinkIpc(ctx)],
    ['registerAgentSessionIpc', () => registerAgentSessionIpc(ctx)],
    ['registerWorkerRoutingIpc', () => registerWorkerRoutingIpc(ctx)],
    ['registerBgTasksIpc', () => registerBgTasksIpc(ctx)],
    ['registerWorkflowIpc', () => registerWorkflowIpc(ctx)],
    ['registerFsIpc', () => registerFsIpc(ctx, orchestrator, fsWatcher)],
    ['registerWorkspaceIpc', () => registerWorkspaceIpc(ctx, orchestrator, syncFsWatches, stopFsWatches)],
    ['registerGitIpc', () => registerGitIpc(ctx, syncGitWatches)],
    ['registerPrIpc', () => registerPrIpc(ctx)],
    ['registerAppIpc', () => registerAppIpc(ctx)],
    ['registerExtensionsExtensionIpc', () => { if (!ctx.extensionSystem) throw new Error('Extension system is not ready'); registerExtensionsExtensionIpc(ctx, ctx.extensionSystem); }],
    ['registerAgentAppsIpc', () => registerAgentAppsIpc(ctx)],
    ['registerMessagingIpc', () => registerMessagingIpc(ctx)],
    ['registerMailPresentationIpc', () => registerMailPresentationIpc(ctx)],
    ['registerSafetyIpc', () => registerSafetyIpc(ctx)],
    ['registerThemeIpc', () => registerThemeIpc(ctx)],
    ['registerUsageIpc', () => registerUsageIpc(ctx)],
    ['registerEvidenceIpc', () => registerEvidenceIpc(ctx)],
    ['registerTextToolsIpc', () => registerTextToolsIpc(ctx)],
    ['registerKnowledgeIpc', () => registerKnowledgeIpc(ctx)],
    ['registerMemoryCuratorIpc', () => registerMemoryCuratorIpc(ctx)],
    ['registerMemoryCenterIpc', () => registerMemoryCenterIpc(ctx)],
    ['registerUpdaterIpc', () => registerUpdaterIpc(ctx)],
    ['registerInboundMcpIpc', () => registerInboundMcpIpc(ctx)],
    ['registerCapabilityManagementIpc', () => registerCapabilityManagementIpc(ctx)],
    ['registerUiWidgetIpc', () => registerUiWidgetIpc(ctx)],
    ['registerFeedbackIpc', () => registerFeedbackIpc(ctx)],
    ['registerLocalStorageIpc', () => registerLocalStorageIpc(ctx)],
    ['registerSessionRemindersIpc', () => registerSessionRemindersIpc(ctx)],
    ['registerBoardTodosIpc', () => registerBoardTodosIpc(ctx)],
    ['registerProcessMonitorIpc', () => registerProcessMonitorIpc()],
  ];
  for (const [id, register] of entries) domains.register({
    id: `ipc:${id}`, dependsOn: ['desktop-ipc'],
    start: (_ctx, scope) => registerScopedIpc(`ipc:${id}`, scope, register)
  });
  return entries.map(([id]) => `ipc:${id}`);
}
