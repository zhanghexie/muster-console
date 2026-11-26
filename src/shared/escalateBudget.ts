/**
 * escalate 升级预算（S2.3 / T4）纯函数核：
 * 只管理 setStatus(needs_you) 的用户注意通知；不限制普通会话通信。
 * 预算 3 次/会话；第 4 次返回**正常结果**（非 tool error）
 * `refused: upgrade budget spent (3/3). Proceed on your best judgement; do not retry.`
 * 预算尽后仍允许改 note，但不再产生新的「等人」通知。作答权维持人/调度，Worker 不得代答。
 * 无 process / 无 IO，宿主接线在 capabilities/hosts/sessions.ts。
 */

export const ESCALATE_BUDGET_LIMIT = 3;

/** 第 4 次升级的正常结果文案（非 tool error，模型应自行判断、不要重试）；限额改这里自动同步 */
export const ESCALATE_REFUSED_MESSAGE = `refused: upgrade budget spent (${ESCALATE_BUDGET_LIMIT}/${ESCALATE_BUDGET_LIMIT}). Proceed on your best judgement; do not retry.`;

/**
 * 预算键：会话身份（session:<id>）。
 * 旧持久化 scheduler-hour 计数不再被通信路径消费。
 */
export function escalateBudgetKey(input: {
  sessionId: string;
}): string {
  return `session:${input.sessionId}`;
}

/** key → 已用次数。挂在会话链上（由宿主持久化） */
export type EscalateBudgetMap = Record<string, number>;

export interface EscalateAttempt {
  /** 本次是否允许升级（needs_you 翻相位） */
  allowed: boolean;
  /** 本次计入后的已用次数（refused 时为当前已用，不再自增） */
  used: number;
  remaining: number;
  /** true=本次应产生「等人」通知/上行；false=预算尽，只允许静默改 note */
  escalate: boolean;
  /** 预算尽时的正常结果文案（非 tool error） */
  message?: string;
}

/**
 * 尝试消费一次用户注意通知预算。
 * 预算尽时**不抛错**——返回 escalate=false + message，由调用方作为正常结果回给模型；
 * 且不得新发「等人」通知；setStatus 的 note 仍可写。
 */
export function tryEscalate(budgets: EscalateBudgetMap, key: string): EscalateAttempt {
  const limit = ESCALATE_BUDGET_LIMIT;
  const used = budgets[key] ?? 0;
  if (used >= limit) {
    return {
      allowed: false,
      used,
      remaining: 0,
      escalate: false,
      message: ESCALATE_REFUSED_MESSAGE
    };
  }
  const next = used + 1;
  budgets[key] = next;
  return {
    allowed: true,
    used: next,
    remaining: limit - next,
    escalate: true
  };
}

/** 是否应产生「等人」新通知：仅预算内升级才通知（预算尽不发新通知） */
export function shouldNotifyEscalate(attempt: EscalateAttempt): boolean {
  return attempt.escalate;
}
