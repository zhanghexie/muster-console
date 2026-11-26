/** 定时任务的错过策略、电源保持和会话参数。 */

import { t } from './i18n';
import { buildGuiInheritMeta, GuiInheritMetaError } from './guiInheritMeta';
import type { GuiSessionInitialMeta, GuiThinkingLevel, GuiWorkerMode } from './types';

/** 错过策略：skip=跳过并记录（默认，防风暴）/ catch-up=补跑一次错过槽位 / confirm=记录并等确认补跑 */
export type MissedPolicy = 'skip' | 'catch-up' | 'confirm';

export function resolveMissedPolicy(policy: MissedPolicy | undefined): MissedPolicy {
  return policy === 'catch-up' || policy === 'confirm' ? policy : 'skip';
}

/**
 * 定时器可能比计划时刻早若干毫秒触发（setTimeout 与 Date.now() 时钟偏差）。
 * lastRunAt 落在该容差内即视为已执行过该槽位，不再记错过。
 */
export const TIMER_EARLY_FIRE_TOLERANCE_MS = 5_000;

/** 临近触发窗口：此时间内 keep-awake 阻止休眠 */
export const KEEP_AWAKE_LEAD_MS = 5 * 60_000;

export type MissedWindowDecision =
  | { action: 'none' }
  | { action: MissedPolicy; missedAt: number };

/**
 * 启动 / 系统唤醒 / 重挂定时器时的错过窗口判定（纯函数）。
 * 无 nextRunAt、槽位已执行（含早触发容差）、无头在途 → none；否则按策略 skip/catch-up/confirm。
 */
export function evaluateMissedWindow(input: {
  nextRunAt?: number;
  lastRunAt?: number;
  now: number;
  inFlight?: boolean;
  policy?: MissedPolicy;
}): MissedWindowDecision {
  if (input.nextRunAt == null || input.nextRunAt > input.now) return { action: 'none' };
  const missedAt = input.nextRunAt;
  const ranForSlot =
    input.lastRunAt != null && input.lastRunAt >= missedAt - TIMER_EARLY_FIRE_TOLERANCE_MS;
  if (ranForSlot || input.inFlight) return { action: 'none' };
  return { action: resolveMissedPolicy(input.policy), missedAt };
}

/** keep-awake：有在途运行，或任一计划时刻落在 [now-容差, now+提前量] */
export function shouldKeepAwake(input: {
  enabled: boolean;
  inFlightCount: number;
  nextRunAts: Array<number | undefined>;
  now: number;
}): boolean {
  if (!input.enabled) return false;
  if (input.inFlightCount > 0) return true;
  return input.nextRunAts.some(
    (at) =>
      at != null &&
      at - input.now <= KEEP_AWAKE_LEAD_MS &&
      at >= input.now - TIMER_EARLY_FIRE_TOLERANCE_MS
  );
}

/** 启动清理存量无头任务时写入的摘要（名称 + 提示词截断，供交付复核） */
export interface PurgedHeadlessTask {
  id: string;
  name: string;
  promptPreview: string;
}

const HEADLESS_PROMPT_PREVIEW_LEN = 80;

export function summarizePurgedHeadlessTask(task: {
  id: string;
  name: string;
  prompt: string;
}): PurgedHeadlessTask {
  const prompt = task.prompt.trim().replace(/\s+/g, ' ');
  return {
    id: task.id,
    name: task.name,
    promptPreview:
      prompt.length <= HEADLESS_PROMPT_PREVIEW_LEN
        ? prompt
        : `${prompt.slice(0, HEADLESS_PROMPT_PREVIEW_LEN)}…`
  };
}

/** 拆出 mode=headless 的存量任务（纯函数，manager 构造期调用） */
export function partitionHeadlessPromptTasks<
  T extends { id: string; name: string; prompt: string; mode?: string }
>(tasks: T[]): { kept: T[]; purged: PurgedHeadlessTask[] } {
  const kept: T[] = [];
  const purged: PurgedHeadlessTask[] = [];
  for (const task of tasks) {
    if (task.mode === 'headless') purged.push(summarizePurgedHeadlessTask(task));
    else kept.push(task);
  }
  return { kept, purged };
}

/** 定时任务 → createTerminal inheritMeta（无会话态字段时返回 undefined）。
 *  委托 buildGuiInheritMeta 单点实现（含 providerId/modelId 只给一半的拒绝）；
 *  存量数据半模型降级为不覆盖模型——沿用既有「静默丢弃」契约，不阻断定时触发。
 *  prompt-tasks F-02：降级经 onDegraded 回调上报（调用方写任务级可见提示，
 *  不再只有 console.warn）。 */
export function inheritMetaFromPromptTask(
  task: {
    runtime?: string;
    configurePermissions?: boolean;
    guiMode?: GuiWorkerMode;
    nativeConfig?: import('./nativeSessionConfig').NativeConfigIntent;
    piModeId?: string;
    providerId?: string;
    modelId?: string;
    thinking?: GuiThinkingLevel;
    modelParameters?: import('./modelParameters').ModelParameterValues;
  },
  onDegraded?: (note: string) => void
): GuiSessionInitialMeta | undefined {
  const base = {
    configurePermissions: task.configurePermissions,
    guiMode: task.runtime === undefined || task.runtime === 'pi' ? task.guiMode : undefined,
    nativeConfig: task.nativeConfig,
    piModeId: task.piModeId,
    thinking: task.thinking,
    modelParameters: task.modelParameters
  };
  if (!task.providerId && !task.modelId) return buildGuiInheritMeta(base);
  try {
    return buildGuiInheritMeta({
      ...base,
      model: { providerId: task.providerId, modelId: task.modelId }
    });
  } catch (err) {
    if (err instanceof GuiInheritMetaError) {
      console.warn('[tasks] inheritMeta model 只给一半，跳过模型覆盖', task.providerId, task.modelId);
      onDegraded?.(
        t('模型只配置了一半（providerId/modelId 缺一），已忽略模型覆盖，本次使用全局当前模型')
      );
      return buildGuiInheritMeta(base);
    }
    throw err;
  }
}
