import fs from 'node:fs';
import { authorizeSafetyOperation } from '../safety/bindings';
import { workflowFingerprint } from './store';
/**
 * 工作流运行时装配（dynamic-workflow）：用真 AppContext 实现 WorkflowRuntimeDeps——
 * 派活走 delegateTask（调度身份，排队项经 delegateQueue 出队回调等到真正拉起；带确定性
 * 任务 id 防崩溃重复派）、wf.tool 走 executeTool（调度身份 + 工作区作用域）、进度事件进
 * 事件泵 workflow 种类、waitFor 与事件触发挂事件泵旁听点，工作流信任沿用独立键空间
 * （键 workflow:<名字>）、问用户弹桌面通知、run 变化推 workflow:changed 给面板。
 */
import { shell } from 'electron';
import type { AppContext } from '../context';
import { runAsAgentWorkspace, runAsSchedulerTool } from '../agent/agentScope';
import { executeTool } from '../capabilities/executor';
import { delegateTask, type DelegateTaskResult } from '../tasks/delegate';
import type { OrchestratorEventPump } from '../orchestrator/events';
import { isConfirmed } from '../../shared/confirmDialog';
import { WORKFLOW_TRUST_PREFIX } from '../../shared/workflow';
import { t } from '../../shared/i18n';
import { localizeSafetyReason } from '../../shared/safetyReason';
import { WorkflowRuntime, type WorkflowDelegateResult } from './runtime';
import { createQueuedDelegateBridge } from './delegateBridge';

function toDelegateResult(res: DelegateTaskResult): WorkflowDelegateResult {
  return {
    ...(res.session?.id ? { sessionId: res.session.id } : {}),
    ...(res.session?.name ? { sessionName: res.session.name } : {}),
    ...(res.session?.meta?.creationKey ? { taskId: res.session.meta.creationKey } : {}),
    ...(res.isolate !== undefined ? { isolate: res.isolate } : {})
  };
}

function parseIsolate(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('wf.delegate 必须显式选择 isolate: true 或 false，无 auto 或默认值。');
  return v;
}

const CHANGE_DEBOUNCE_MS = 250;

export function createWorkflowRuntime(ctx: AppContext, pump: OrchestratorEventPump): { runtime: WorkflowRuntime; dispose: () => void } {
  const rootOf = (ws: string): string | undefined => ctx.config.get().workspaces.find((w) => w.id === ws)?.path;
  const pendingChange = new Set<string>();
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  // 排队派活：挂起等 delegateQueue 出队回调 + 取消撤销（bridge 亦供真实队列联动测试）
  const queuedBridge = createQueuedDelegateBridge(toDelegateResult);

  const runtime = new WorkflowRuntime({
    workspaceIds: () => ctx.config.get().workspaces.map((w) => w.id),
    workspaceRoot: rootOf,
    emit: (ws, e) => pump.enqueueWorkflow(ws, e),
    delegate: async (ws, input, ctl) => {
      const res = await runAsAgentWorkspace(ws, () =>
        runAsSchedulerTool(() =>
          delegateTask(ctx, {
            task: String(input.task ?? ''),
            workspaceId: ws,
            ...(typeof input.runtime === 'string' ? { runtime: input.runtime } : {}),
            ...(typeof input.name === 'string' ? { name: input.name } : {}),
            isolate: parseIsolate(input.isolate),
            ...(input.tier !== undefined ? { target: { tierId: input.tier } } : input.targetRef !== undefined ? { target: { targetRef: input.targetRef } } : {}),
            ...(input.model && typeof input.model === 'object' ? { model: input.model as { providerId: string; modelId: string } } : {}),
            ...(typeof input.thinking === 'string' ? { thinking: input.thinking as 'off' | 'low' | 'medium' | 'high' | 'max' } : {}),
            ...(typeof input.guiMode === 'string' ? { guiMode: input.guiMode as 'default' | 'ask' | 'plan' | 'auto' } : {}),
            ...(typeof input.creationKey === 'string' ? { creationKey: input.creationKey } : {}),
            select: false,
            notifyOrchestrator: false
          })
        )
      );
      if (!res.queued || !res.queueId) return toDelegateResult(res);
      // 撤销回调经 bridge 登记：run 取消时撤销未出队项；已开始创建的撤销不了，
      // 由 runtime 按取消选项迟到补偿（closeSessions 补关会话并记账）
      return queuedBridge.waitQueued(res.queueId, ctl);
    },
    executeTool: (ws, name, args, signal) =>
      runAsAgentWorkspace(ws, () => runAsSchedulerTool(() => executeTool(ctx, name, JSON.stringify(args), { signal }))),
    deleteSessionAsHuman: async (ws, sessionId) => {
      const session = ctx.sessions.get(sessionId);
      if (!session || session.workspaceId !== ws) throw new Error('会话不存在或不属于当前工作区');
      ctx.sessions.setArchived(sessionId, true);
      await ctx.sessions.deletePermanently([sessionId], 'human');
    },
    sessionPhase: (ws, sessionId) => {
      const s = ctx.sessions.get(sessionId);
      return s && s.workspaceId === ws ? s.phase?.value : undefined;
    },
    trustState: (ws, name, fingerprint) => {
      const cur = ctx.config.get().extensionTrust?.[ws]?.[`${WORKFLOW_TRUST_PREFIX}${name}`];
      return cur === fingerprint ? 'trusted' : cur ? 'changed' : 'never';
    },
    revokeTrust: (ws, name) => {
      const cfg = ctx.config.get();
      const byWs = { ...(cfg.extensionTrust?.[ws] ?? {}) };
      delete byWs[`${WORKFLOW_TRUST_PREFIX}${name}`];
      ctx.config.update({ extensionTrust: { ...(cfg.extensionTrust ?? {}), [ws]: byWs } });
    },
    removeDir: (dir) => shell.trashItem(dir),
    notifyHuman: (ws, info) => {
      ctx.ui.notify(t('工作流 {{name}} 在等你答复', { name: info.name }), info.question.slice(0, 200), { workspaceId: ws });
    },
    onChange: (ws) => {
      pendingChange.add(ws);
      if (changeTimer) return;
      changeTimer = setTimeout(() => {
        changeTimer = null;
        const wsIds = [...pendingChange];
        pendingChange.clear();
        const win = ctx.getWindow();
        if (!win || win.isDestroyed()) return;
        for (const workspaceId of wsIds) win.webContents.send('workflow:changed', { workspaceId });
      }, CHANGE_DEBOUNCE_MS);
      changeTimer.unref?.();
    },
    ensureTrusted: async (ws, wf, initiatedBy = 'agent', signal) => {
      if (signal?.aborted) return false;
      const key = `${WORKFLOW_TRUST_PREFIX}${wf.name}`;
      if (ctx.config.get().extensionTrust?.[ws]?.[key] === wf.fingerprint) return true;
      const changed = !!ctx.config.get().extensionTrust?.[ws]?.[key];
      const doc = fs.readFileSync(wf.docPath, 'utf8');
      const script = fs.readFileSync(wf.scriptPath, 'utf8');
      if (workflowFingerprint(doc, script) !== wf.fingerprint) return false;
      const humanConfirm = async (reason: string, signal?: AbortSignal) => isConfirmed(await ctx.ui.confirm(
        changed ? t('工作流已修改，确认运行：{{name}}', { name: wf.name }) : t('首次运行工作流：{{name}}', { name: wf.name }),
        `${localizeSafetyReason(reason)}\n` + t(
          '{{description}}\n\n脚本：{{script}}\n内容指纹：{{fingerprint}}\n\n工作流脚本能派活、跑任意命令、读工作区文件。确认后同一内容不再询问，脚本或说明改动后会再次请求。',
          { description: wf.def?.description ?? '', script: wf.scriptPath, fingerprint: wf.fingerprint }
        ),
        { dangerous: true, signal }
      ));
      if (initiatedBy !== 'human') {
        const decision = await authorizeSafetyOperation(ctx, {
          signal,
          workspaceId: ws, source: 'catalog', action: 'workflow.trust', args: { name: wf.name }, dangerous: true,
          targetFingerprint: wf.fingerprint, evidence: JSON.stringify({ doc, script }), humanConfirm
        });
        if (!decision.allowed || signal?.aborted) return false;
      }
      if (workflowFingerprint(fs.readFileSync(wf.docPath, 'utf8'), fs.readFileSync(wf.scriptPath, 'utf8')) !== wf.fingerprint) return false;

      const trust = { ...(ctx.config.get().extensionTrust ?? {}) };
      trust[ws] = { ...(trust[ws] ?? {}), [key]: wf.fingerprint };
      ctx.config.update({ extensionTrust: trust });
      return true;
    }
  });

  const offTap = pump.addTap((ws, view) => runtime.onEvent(ws, view));
  return {
    runtime,
    dispose: async () => {
      offTap();
      queuedBridge.dispose();
      if (changeTimer) clearTimeout(changeTimer);
      await runtime.shutdown();
    }
  };
}
