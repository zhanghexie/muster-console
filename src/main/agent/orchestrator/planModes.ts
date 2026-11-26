import { commitDisplayEdit } from './eventBus';
/**
 * Agent 模式（default/ask/plan）与计划卡（PlanCard）联动：
 * 模式扩展控制器的绑定/计划抽取/计划更新/执行收口。
 * （自 orchestrator.ts 拆分；`this.` 改经 OrchestratorHost 协作面，逻辑逐字保留。）
 */
import { randomUUID } from 'node:crypto';
import { formatNotifyText, type AgentMode, type PlanCard, type PlanStepView } from '../../../shared/types';
import { t } from '../../../shared/i18n';
import { getModeController } from '../providers/modeExtension';
import type { OrchestratorHost } from './internal';
import { normalizeAgentMode } from './types';

/** 切换 Agent 模式（default/ask/plan）；已有会话时即时生效（IPC 边界，接受宽松 string） */
export function setAgentMode(o: OrchestratorHost, mode: string, wsId: string): AgentMode {
  const m = normalizeAgentMode(mode);
  const b = o.buckets.get(wsId);
  if (b) b.mode = m;
  o.modes[wsId] = m;
  o.ctx.store.saveAgentModes(o.modes);
  getModeController(wsId)?.setMode(m);
  return m;
}

/** 计划卡操作：execute 开始执行（走正常回合管道）；abandon 放弃 */
export async function planAction(
  o: OrchestratorHost,
  action: 'execute' | 'abandon',
  wsId: string
): Promise<{ ok: boolean; error?: string }> {
  const c = getModeController(wsId);
  if (!c) return { ok: false, error: t('尚无 Agent 会话（先和 Agent 对话出计划）') };
  if (action === 'abandon') {
    c.abandonPlan();
    updatePlanCard(o, wsId, (card) =>
      card.status === 'pending' ? { ...card, status: 'abandoned' } : card
    );
    return { ok: true };
  }
  if (o.isBusy(wsId)) return { ok: false, error: t('Agent 正忙，请稍后再执行') };
  const text = c.executePlan();
  if (!text) return { ok: false, error: t('没有可执行的计划') };
  updatePlanCard(o, wsId, (card) => ({ ...card, status: 'executing' }));
  await o.send(text, wsId);
  return { ok: true };
}

/** 更新最近一张计划卡（无卡则忽略） */
export function updatePlanCard(o: OrchestratorHost, wsId: string, patch: (card: PlanCard) => PlanCard): void {
  const b = o.ensureBucket(wsId);
  for (let i = b.display.length - 1; i >= 0; i--) {
    const m = b.display[i];
    if (m.plan) {
      commitDisplayEdit(o, wsId, { upsert: [{ message: { ...m, plan: patch(m.plan) } }] });
      o.persistBucket(wsId);
      return;
    }
  }
}

/** 绑定/刷新模式扩展回调（session 创建后首个回合前调用；重复绑定无害） */
export function bindModeController(o: OrchestratorHost, wsId: string): void {
  const c = getModeController(wsId);
  if (!c) return;
  const b = o.ensureBucket(wsId);
  if (c.mode !== b.mode) c.setMode(b.mode);
  c.onPlanExtracted = (extracted) => {
    const bucket = o.ensureBucket(wsId);
    // 新计划生效：旧 pending 卡转「已更新」只读（保留历史，与 GUI Worker 语义一致）
    const changed = bucket.display.filter(m => m.plan?.status === 'pending' && m.plan.active !== false)
      .map(m => ({ message: { ...m, plan: { ...m.plan!, active: false } } }));
    changed.push({ message: {
      id: randomUUID(), role: 'assistant', content: '', createdAt: Date.now(),
      plan: { steps: extracted.steps, status: 'pending', active: true, markdown: extracted.markdown }
    } });
    commitDisplayEdit(o, wsId, { upsert: changed });
    o.persistBucket(wsId);
  };
  c.onPlanUpdated = (steps: PlanStepView[]) => {
    updatePlanCard(o, wsId, (card) =>
      card.status === 'executing' ? { ...card, steps } : card
    );
  };
  c.onPlanCompleted = () => {
    updatePlanCard(o, wsId, (card) =>
      card.status === 'executing' ? { ...card, status: 'done' } : card
    );
    o.ctx.notify.push({
      workspaceId: wsId,
      sessionId: `orchestrator:${wsId}`,
      sessionName: t('调度'),
      kind: 'info',
      text: formatNotifyText(t('调度'), t('计划已全部执行完成')),
      update: true,
      updateKey: `orch-plan-done:${wsId}`,
      toast: true
    });
  };
}
