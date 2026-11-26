/**
 * 会话级模型/思考档变更决策（P10）：与 driver 声明对齐，供 Host 与离线测试共用。
 *
 * 产品口径：
 * - idle：即时落地（reconnect 型拆连接，下一次 send 用新模型）
 * - 运行中：不打断当前回合，下回合生效
 * - 快照型 runtime 可声明 unsupported（明确拒绝）或 reconnect（下次重连生效）
 */
export type ModelOverridePolicy = 'reconnect' | 'unsupported';
export type ThinkingPolicy = 'hot' | 'unsupported';
export type SessionChangeApplied = 'immediate' | 'next-turn' | 'next-reconnect';

export type SessionChangeDecision =
  | { ok: false; errorKey: 'not-chat' | 'unsupported' | 'incomplete' }
  | { ok: true; applied: SessionChangeApplied; dropConnection: boolean };

export function decideSetModel(input: {
  isChat: boolean;
  policy: ModelOverridePolicy | undefined;
  busy: boolean;
  hasOpenEntry: boolean;
  /** 设置时两侧都要有；清除时跳过 */
  clearing: boolean;
  complete: boolean;
}): SessionChangeDecision {
  if (!input.isChat) return { ok: false, errorKey: 'not-chat' };
  if (!input.policy || input.policy === 'unsupported') {
    return { ok: false, errorKey: 'unsupported' };
  }
  if (!input.clearing && !input.complete) return { ok: false, errorKey: 'incomplete' };
  if (!input.hasOpenEntry) {
    return { ok: true, applied: 'next-reconnect', dropConnection: false };
  }
  if (input.busy) {
    return { ok: true, applied: 'next-turn', dropConnection: false };
  }
  return { ok: true, applied: 'immediate', dropConnection: true };
}

export function decideSetThinking(input: {
  isChat: boolean;
  policy: ThinkingPolicy | undefined;
  busy: boolean;
  hasOpenEntry: boolean;
}): SessionChangeDecision {
  if (!input.isChat) return { ok: false, errorKey: 'not-chat' };
  if (!input.policy || input.policy === 'unsupported') {
    return { ok: false, errorKey: 'unsupported' };
  }
  if (!input.hasOpenEntry) {
    return { ok: true, applied: 'next-reconnect', dropConnection: false };
  }
  if (input.busy) {
    return { ok: true, applied: 'next-turn', dropConnection: false };
  }
  return { ok: true, applied: 'immediate', dropConnection: false };
}

export function parseModelClearArgs(args: {
  providerId?: string;
  modelId?: string;
}): { clearing: boolean; complete: boolean } {
  const p = args.providerId?.trim() ?? '';
  const m = args.modelId?.trim() ?? '';
  if (!p && !m) return { clearing: true, complete: true };
  return { clearing: false, complete: !!(p && m) };
}
