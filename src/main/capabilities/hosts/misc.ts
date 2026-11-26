import type { AppContext } from '../../context';
import type { AgentLifecycle } from '../../../shared/types';
import { formatNotifyText } from '../../../shared/types';
import { t } from '../../../shared/i18n';
import { listAppInstances } from '../../instance/registry';
import { fillNotifyFromSession, missingUiNotifyFields, type UiNotifyLocate } from '../../../shared/uiNotifyArgs';
import { executeHostAsk } from '../../../shared/hostAsk';
import { isSchedulerInvocation } from '../../agent/agentScope';
import {
  CURSOR_ASK_QUESTION_NAME,
  formatCursorAskQuestionResult,
  mapCursorAskQuestionArgs
} from '../../../shared/cursorAskQuestion';

type UiNotifyArgs = {
  workspaceId?: string;
  sessionId?: string;
  sessionName?: string;
  text?: string;
  lifecycle?: AgentLifecycle;
  label?: string;
  /** 为 true 时按 updateKey（或自动推导）更新已有通知 */
  update?: boolean;
  /** 同键覆盖；缺省且 update=true 时按 lifecycle/live 推导 */
  updateKey?: string;
};

async function askScheduler(ctx: AppContext, args: unknown): Promise<unknown> {
  if (!isSchedulerInvocation()) throw new Error('Scheduler inquiry requires scheduler identity; Workers use their own question channel');
  return executeHostAsk(args, {
    confirm: params => uiHost['ui.confirm'](ctx, params),
    text: params => uiHost['ui.prompt'](ctx, params),
    choice: params => uiHost[CURSOR_ASK_QUESTION_NAME](ctx, params)
  });
}

function resolveNotifyText(args: UiNotifyArgs): string {
  if (args.text?.trim()) return args.text.trim();
  const name = args.sessionName?.trim() || t('会话');
  if (args.lifecycle) return formatNotifyText(name, args.lifecycle);
  if (args.label?.trim()) return formatNotifyText(name, args.label.trim());
  return name;
}

function resolveUpdateKey(args: UiNotifyArgs, sessionId: string): string | undefined {
  if (args.updateKey?.trim()) return args.updateKey.trim();
  if (!args.update) return undefined;
  if (args.lifecycle) return `lifecycle:${sessionId}`;
  if (args.label?.trim()) return `live:${sessionId}`;
  return `session:${sessionId}`;
}

export const uiHost = {
  // Internal scheduler implementation; Worker questioning binds to its own channel.
  'host.ask': askScheduler,
  'ui.notify': (ctx: AppContext, args: UiNotifyArgs) => {
    let sessionId = args.sessionId?.trim() || '';
    let filled: UiNotifyLocate = { ...args, sessionId };
    if (sessionId) {
      const byId = ctx.sessions.get(sessionId);
      if (byId) filled = fillNotifyFromSession(filled, byId);
      else {
        try {
          const resolved = ctx.sessions.resolveSessionRef({ sessionId });
          filled = fillNotifyFromSession(filled, ctx.sessions.get(resolved.id));
        } catch {
          /* 无会话时仍可用 workspaceId+sessionName */
        }
      }
    }
    const missing = missingUiNotifyFields(filled);
    if (missing.length) {
      throw new Error(
        t('ui.notify 缺少：{{fields}}（可传 sessionId 直达，或 workspaceId + sessionName）', {
          fields: missing.join(', ')
        })
      );
    }
    const workspaceId = filled.workspaceId!.trim();
    const sessionName = filled.sessionName!.trim();
    if (!sessionId) {
      const match = ctx.sessions
        .list()
        .find((s) => s.workspaceId === workspaceId && s.name === sessionName);
      sessionId = match?.id || `notify:${workspaceId}`;
    }
    const merged: UiNotifyArgs = { ...args, workspaceId, sessionName, sessionId };
    const updateKey = resolveUpdateKey(merged, sessionId);
    const text = resolveNotifyText(merged);
    const item = ctx.notify.push({
      workspaceId,
      sessionId,
      sessionName,
      lifecycle: args.lifecycle,
      label: args.label?.trim() || undefined,
      text,
      update: !!args.update && !!updateKey,
      updateKey,
      // Agent 主动通知 = 人需要知晓：弹桌面（emit 单路负责，不在这里二次弹）
      toast: true
    });
    return { notified: true, id: item.id, updated: !!args.update && !!updateKey };
  },

  'ui.confirm': async (ctx: AppContext, args: { title: string; detail?: string }) => {
    const r = await ctx.ui.confirm(args.title, args.detail ?? '');
    return r.confirmed
      ? { confirmed: true }
      : { confirmed: false, cancelledBy: r.cancelledBy };
  },

  'ui.prompt': async (ctx: AppContext, args: Record<string, unknown>) => {
    const value = await ctx.ui.prompt(args);
    return { cancelled: value == null, value };
  },

  [CURSOR_ASK_QUESTION_NAME]: async (ctx: AppContext, args: Record<string, unknown>) => {
    if (!ctx.orchestrator) throw new Error(t('调度会话未就绪'));
    const mapped = mapCursorAskQuestionArgs(args);
    const outcome = await ctx.orchestrator.requestUserQuestion(mapped);
    const formatted = formatCursorAskQuestionResult(outcome);
    if (!formatted.ok) throw new Error(formatted.text);
    try {
      return JSON.parse(formatted.text) as { answers: unknown };
    } catch {
      return { answers: outcome.kind === 'answered' ? outcome.answers : [] };
    }
  }
};

export const appHost = {

  'app.getConfig': (ctx: AppContext) => ctx.config.getRedacted(),

  'app.instances': () => ({ instances: listAppInstances() })
};
