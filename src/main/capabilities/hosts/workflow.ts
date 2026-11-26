/**
 * workflow.*（dynamic-workflow W1）：调度对脚本工作流的操作面。
 * 身份门：仅调度调用链（本组不进任何 Worker 白名单，此处是第二道兜底）。
 * 问人：wf.ask {to:'human'} 默认亮在工作流面板由用户直接答；调度可调 workflow.askHuman
 * 代为弹问题卡，用户答案直接回写脚本（调度不改写、不代答）；workflow.reply 拒答问人的问题。
 */
import type { AppContext } from '../../context';
import { currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { getWorkflowRuntime } from '../../workflow/runtimeRef';
import type { WorkflowRuntime } from '../../workflow/runtime';
import { buildHumanAskMapped, describeWorkflowRun, humanAnswerFromOutcome } from '../../../shared/workflow';
import { t } from '../../../shared/i18n';

function requireScheduler(): WorkflowRuntime {
  if (!isSchedulerInvocation()) throw new Error(t('仅调度 Agent 可用该工具（工作流由调度编排）'));
  const rt = getWorkflowRuntime();
  if (!rt) throw new Error(t('工作流运行时未就绪'));
  return rt;
}

function wsOf(ctx: AppContext, workspaceId?: string): string {
  const cfg = ctx.config.get();
  return workspaceId?.trim() || currentAgentWorkspaceId() || cfg.activeWorkspaceId;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export const workflowHost = {
  'workflow.list': (ctx: AppContext, args: { workspaceId?: string }) => requireScheduler().list(wsOf(ctx, args?.workspaceId)),

  'workflow.validate': (ctx: AppContext, args: { name?: string; workspaceId?: string }) =>
    requireScheduler().validate(wsOf(ctx, args?.workspaceId), str(args?.name)),

  'workflow.start': async (ctx: AppContext, args: { name?: string; args?: unknown; workspaceId?: string }) => {
    const rt = requireScheduler();
    const params = args?.args && typeof args.args === 'object' && !Array.isArray(args.args) ? (args.args as Record<string, unknown>) : {};
    const rec = await rt.startRun(wsOf(ctx, args?.workspaceId), str(args?.name), params);
    return { ...describeWorkflowRun(rec, Date.now(), { logTail: 0 }), note: t('已启动；进度与待答问题会以编排事件送来，不必轮询') };
  },

  'workflow.get': (ctx: AppContext, args: { runId?: string; logTail?: number; workspaceId?: string }) =>
    requireScheduler().get(
      wsOf(ctx, args?.workspaceId),
      str(args?.runId),
      typeof args?.logTail === 'number' ? Math.max(0, Math.min(200, Math.floor(args.logTail))) : 20
    ),

  'workflow.cancel': (ctx: AppContext, args: { runId?: string; reason?: string; closeSessions?: boolean; workspaceId?: string }) =>
    requireScheduler().cancel(wsOf(ctx, args?.workspaceId), str(args?.runId), str(args?.reason), {
      closeSessions: args?.closeSessions === true
    }),

  'workflow.reply': (ctx: AppContext, args: { runId?: string; askId?: string; answer?: unknown; workspaceId?: string }) =>
    requireScheduler().reply(wsOf(ctx, args?.workspaceId), str(args?.runId), str(args?.askId), args?.answer ?? null),

  'workflow.askHuman': async (ctx: AppContext, args: { runId?: string; workspaceId?: string }) => {
    const rt = requireScheduler();
    const ws = wsOf(ctx, args?.workspaceId);
    const runId = str(args?.runId);
    const { name, ask } = rt.pendingHumanAsk(ws, runId);
    if (!ctx.orchestrator) throw new Error(t('调度会话未就绪'));
    const outcome = await ctx.orchestrator.requestUserQuestion(buildHumanAskMapped(name, ask), ws);
    const r = humanAnswerFromOutcome(outcome, ask);
    if (!r.ok) {
      return { ok: false, runId, note: t('用户没有作答（卡片被取消、空提交或回合结束），问题仍挂着，之后可再调 workflow.askHuman') };
    }
    rt.answerHuman(ws, runId, ask.askId, r.answer);
    return { ok: true, runId, answer: r.answer, note: t('答案已回写工作流，脚本继续执行') };
  }
};
