/**
 * scheduler.policy.get / scheduler.policy.set（agent-comms-evolution-plan C1 订阅策略）。
 * 身份门：仅调度调用链（isSchedulerInvocation；本组不进任何 Worker 白名单，此处是第二道兜底）。
 * set 不走 dangerous 确认：调整自己听什么是调度的日常自我调节，底线事件由策略层兜住；
 * 改动靠变更历史 + 通知历史对人可见。输入有错一律拒写（不做半截生效）。
 */
import type { AppContext } from '../../context';
import { currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { getSubscriptionPolicyStore } from '../../orchestrator/subscriptionPolicyStore';
import { controlRootFor, requireWorkspace } from '../../workspacePaths';
import { t } from '../../../shared/i18n';
import {
  describeSubscriptionPolicy,
  effectivePolicyGuards,
  effectivePolicyTiming,
  parseSubscriptionPolicy
} from '../../../shared/subscriptionPolicy';

function requireSchedulerInvocation(): void {
  if (!isSchedulerInvocation()) {
    throw new Error(t('仅调度 Agent 可用该工具（订阅策略决定调度被哪些事件唤醒）'));
  }
}

function resolveWorkspace(ctx: AppContext, workspaceId?: string): { id: string; root: string } {
  const cfg = ctx.config.get();
  const id = workspaceId === undefined ? currentAgentWorkspaceId() || cfg.activeWorkspaceId : workspaceId.trim();
  const meta = requireWorkspace(cfg, id);
  return { id: meta.id, root: controlRootFor(meta) };
}

export const subscriptionPolicyHost = {
  'scheduler.policy.get': (ctx: AppContext, args: { workspaceId?: string }) => {
    requireSchedulerInvocation();
    const { root } = resolveWorkspace(ctx, args?.workspaceId);
    const store = getSubscriptionPolicyStore();
    const { policy, warnings, notices } = store.load(root);
    return describeSubscriptionPolicy(policy, {
      stats: store.getStats(root),
      warnings: [...warnings, ...notices]
    });
  },

  'scheduler.policy.set': (
    ctx: AppContext,
    args: { rules?: unknown; timing?: unknown; guards?: unknown; reason?: unknown; workspaceId?: string }
  ) => {
    requireSchedulerInvocation();
    const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
    if (!reason) throw new Error(t('reason 必填：说明为什么调整（记入变更历史，用户可见）'));
    const { policy, warnings, notices } = parseSubscriptionPolicy({
      rules: args?.rules ?? [],
      timing: args?.timing ?? {},
      guards: args?.guards ?? {}
    });
    if (warnings.length) {
      throw new Error(t('策略未写入，请修正后重试：{{detail}}', { detail: warnings.join('；') }));
    }
    const { id, root } = resolveWorkspace(ctx, args?.workspaceId);
    const now = Date.now();
    const written = getSubscriptionPolicyStore().write(root, policy, { by: 'scheduler', reason, now });
    // sub-policy F-02：history 追加失败时通知与返回值都带信号（回滚材料缺失对用户可见）
    const historyNote = written.historyError
      ? t('（变更历史记录失败：{{error}}，回滚材料缺失）', { error: written.historyError })
      : '';
    try {
      ctx.notify.push({
        workspaceId: id,
        sessionId: `orchestrator:${id}`,
        sessionName: t('调度 Agent'),
        label: t('订阅策略'),
        kind: 'info',
        text: t('调度调整了订阅策略（{{n}} 条规则）：{{reason}}', { n: policy.rules.length, reason }) + historyNote,
        updateKey: `subscription-policy:${id}`,
        toast: false
      });
    } catch {
      /* 留痕失败不影响已写入的策略 */
    }
    return {
      ok: true,
      ...written,
      rules: policy.rules.length,
      effective: { timing: effectivePolicyTiming(policy), guards: effectivePolicyGuards(policy) },
      ...(notices.length ? { notices } : {})
    };
  }
};
