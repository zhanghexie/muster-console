/**
 * AgentSessionHost 计划流（与调度 modeExtension 同一套提取/进度规则，引擎无关）：
 * plan 探索态从回复正文提取计划块挂卡（pi 约定）；计划类工具
 * 的参数即计划全文，tool-start 即时挂卡；执行态扫 [DONE:n] 标进度，全完收卡。
 */
import { extractPlan, extractPlanStepsLoose, isPlanToolName, markCompletedSteps, planMarkdownFromInput } from '../../../shared/planExtract';
import type { PlanCard } from '../../../shared/types';
import { guiMessageText } from '../../../shared/guiWorker';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import type { HostCore, SessionEntry } from './internal';
import { persistEntry } from './base';

/** 挂计划卡：新卡 active，其余 pending 卡转「已更新」只读；控制器步骤同步供执行/进度用 */
export function attachPlanCard(host: HostCore, entry: SessionEntry, msg: GuiChatMessage, plan: PlanCard): void {
  const changed: GuiChatMessage[] = [msg];
  for (const m of entry.messages) {
    if (m !== msg && m.plan && m.plan.status === 'pending') {
      m.plan = { ...m.plan, active: false };
      changed.push(m);
    }
  }
  msg.plan = plan;
  entry.planMessageId = msg.id;
  entry.modeController.planSteps = plan.steps.map((s) => ({ ...s }));
  persistEntry(host, entry, changed);
}

/**
 * 计划类工具捕获（引擎无关）：plan 档探索态下，createPlan/exit_plan_mode 等工具的
 * 参数就是计划全文——立即解析挂卡（工具卡照常留痕），不依赖回合收口的正文提取。
 * 同回合模型重提（修订/重试）时经 attachPlanCard 原地更新同一张卡。
 */
export function capturePlanSubmission(
  host: HostCore,
  entry: SessionEntry,
  toolName: string,
  input: Record<string, unknown>
): void {
  if (entry.mode !== 'plan' || entry.planExecuting) return;
  if (!isPlanToolName(toolName)) return;
  const markdown = planMarkdownFromInput(input);
  if (!markdown || !entry.assistant) return;
  attachPlanCard(host, entry, entry.assistant, {
    steps: extractPlanStepsLoose(markdown),
    status: 'pending',
    active: true,
    markdown
  });
}

/**
 * 回合结束后的计划流：plan 探索态 → 本回合未被工具捕获挂卡时，从回复正文提取计划
 * 块挂卡（pi 约定；已从工具事件捕获的计划不重复提取）；
 * 执行态 → 扫 [DONE:n] 标进度，全完收卡。
 */
export function updatePlanAfterTurn(
  host: HostCore,
  entry: SessionEntry,
  finishedAssistant: GuiChatMessage | null
): void {
  const text = finishedAssistant ? guiMessageText(finishedAssistant) : '';
  if (entry.mode === 'plan' && !entry.planExecuting) {
    // 本回合已由计划类工具挂卡：以工具版本为准，不再正文提取
    if (finishedAssistant?.plan) return;
    const extracted = extractPlan(text);
    if (extracted && finishedAssistant) {
      attachPlanCard(host, entry, finishedAssistant, {
        steps: extracted.steps,
        status: 'pending',
        active: true,
        markdown: extracted.markdown
      });
    }
    return;
  }
  if (entry.planExecuting && entry.modeController.planSteps.length > 0) {
    const planMsg = entry.messages.find((m) => m.id === entry.planMessageId);
    if (planMsg?.plan && markCompletedSteps(text, entry.modeController.planSteps)) {
      planMsg.plan = {
        ...planMsg.plan,
        steps: entry.modeController.planSteps.map((s) => ({ ...s }))
      };
    }
    if (entry.modeController.planSteps.every((s) => s.completed)) {
      entry.modeController.executing = false;
      entry.planExecuting = false;
      if (planMsg?.plan) planMsg.plan = { ...planMsg.plan, status: 'done' };
    }
  }
}
