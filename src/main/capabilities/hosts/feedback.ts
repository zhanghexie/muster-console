import type { AppContext } from '../../context';
import { resolveToolActor, resolveActorWorkspaceId } from './actors';
import { isSchedulerInvocation } from '../../agent/agentScope';

function caller(ctx: AppContext, args: { __actorSessionId?: string }) {
  if (!ctx.feedback) throw new Error(ctx.feedbackError ? `反馈服务不可用：${ctx.feedbackError}` : '反馈服务不可用');
  const scheduler = isSchedulerInvocation();
  const actor = scheduler ? { role: 'host' as const, id: 'host' } : resolveToolActor(args);
  const workspace = scheduler ? ctx.resolveBubbleWorkspaceId() : resolveActorWorkspaceId(ctx, args);
  const workspaceName = ctx.workspaces.list().find(item => item.id === workspace)?.name || workspace;
  const sessionName = actor.role === 'worker' ? ctx.sessions.get(actor.id)?.name : undefined;
  const source = actor.role === 'worker' ? `${workspaceName} · ${sessionName || '工作会话'}` : `${workspaceName} · 调度`;
  const owner = actor.role === 'worker' ? `worker:${actor.id}` : `scheduler:${workspace}`;
  return { service: ctx.feedback, source, owner };
}

export const feedbackHost = {
  'feedback.history': (ctx: AppContext, args: { checkId?: string; detail?: { source: 'local' | 'remote'; id: string; offset?: number }; __actorSessionId?: string }) => {
    const { service, owner } = caller(ctx, args);
    if (args.detail) {
      if (typeof args.checkId !== 'string') throw new Error('反馈详情参数无效');
      return service.historyDetail(owner, args.checkId, args.detail.source, args.detail.id, args.detail.offset);
    }
    return service.history(owner, args.checkId);
  },
  'feedback.propose': async (ctx: AppContext, args: { items: unknown; checkId: string; __actorSessionId?: string }) => {
    const { service, source, owner } = caller(ctx, args);
    const items = await service.proposeChecked(args.items, source, owner, args.checkId);
    return { items, message: '已进入集中审核；尚未提交 Issue。' };
  },
  'feedback.assess': async (ctx: AppContext, args: { checkId: string; decisions: unknown; __actorSessionId?: string }) => {
    const { service, owner } = caller(ctx, args);
    await service.assess(owner, args.checkId, args.decisions);
    return { message: '已记录 AI 查重判断；尚未提交 Issue。' };
  }
};
