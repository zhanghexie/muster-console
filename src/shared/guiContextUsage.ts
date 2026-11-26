/**
 * GUI 会话上下文用量：落盘快照与「能否持久化」判定（零依赖，renderer-safe）。
 *
 * 引擎的实时用量在内存中，
 * 未发新消息时为 null——显示必须回落到本模块归一的 lastUsage。
 */

/** 会话转写里的最后已知用量（重启恢复用） */
export interface GuiLastUsage {
  tokens: number | null;
  contextWindow: number;
  ts: number;
}

/** 推给渲染层的用量（stale=重启恢复的陈旧值，下一条真实 usage 到达后静默替换） */
export interface GuiUsageView {
  tokens: number | null;
  contextWindow: number;
  ts?: number;
  stale?: boolean;
}

/** 原生上下文指标的共同边界；0 窗口表示引擎没有提供上限。 */
export function normalizeContextUsage(
  tokens: unknown,
  contextWindow: unknown
): { tokens: number | null; contextWindow: number } | null {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
  if (tokens != null && !valid(tokens)) return null;
  if (contextWindow != null && !valid(contextWindow)) return null;
  const used = tokens == null ? null : tokens as number;
  const window = contextWindow == null ? 0 : contextWindow as number;
  return used === null && window === 0 ? null : { tokens: used, contextWindow: window };
}

/** fork 种子 AssistantMessage 的占位用量（driver.ts ZERO_USAGE：真实 usage 已随原会话消耗） */
export function isForkPlaceholderUsage(
  usage: { tokens: number | null; contextWindow: number } | null | undefined
): boolean {
  if (!usage) return false;
  // 种子回放把 usage 写成全 0；getContextUsage 读出来 tokens===0，不可当本会话占用
  return usage.tokens === 0;
}

/**
 * 可否写入 lastUsage。
 * - null / 非有限窗口：不写
 * - fork 占位（tokens===0）：不写
 * - tokens===null（刚 compact）+ 有效窗口：写（未知占用也要保住窗口，重启仍能显示「上下文 —」）
 * - 引擎只提供占用、未提供窗口上限时可保存占用
 */
export function isPersistableUsage(
  usage: { tokens: number | null; contextWindow: number } | null | undefined
): usage is { tokens: number | null; contextWindow: number } {
  if (!usage) return false;
  if (!normalizeContextUsage(usage.tokens, usage.contextWindow)) return false;
  if (isForkPlaceholderUsage(usage)) return false;
  if (usage.tokens === null) return usage.contextWindow > 0;
  if (typeof usage.tokens !== 'number' || !Number.isFinite(usage.tokens) || usage.tokens < 0) {
    return false;
  }
  return usage.tokens > 0 || usage.contextWindow > 0;
}

export function parseLastUsage(raw: unknown): GuiLastUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { tokens?: unknown; contextWindow?: unknown; ts?: unknown };
  if (typeof o.contextWindow !== 'number' || !Number.isFinite(o.contextWindow) || o.contextWindow < 0) {
    return null;
  }
  const tokens =
    o.tokens === null
      ? null
      : typeof o.tokens === 'number' && Number.isFinite(o.tokens)
        ? o.tokens
        : null;
  if (tokens !== null && tokens < 0) return null;
  if (tokens === 0 && o.contextWindow === 0) return null;
  const ts = typeof o.ts === 'number' && Number.isFinite(o.ts) && o.ts > 0 ? o.ts : 0;
  if (!ts) return null;
  if (!isPersistableUsage({ tokens, contextWindow: o.contextWindow })) return null;
  return { tokens, contextWindow: o.contextWindow, ts };
}

export function toLastUsage(
  usage: { tokens: number | null; contextWindow: number },
  ts: number = Date.now()
): GuiLastUsage | null {
  if (!isPersistableUsage(usage)) return null;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return { tokens: usage.tokens, contextWindow: usage.contextWindow, ts };
}

/** 落盘快照 → 渲染层陈旧用量 */
export function staleUsageView(last: GuiLastUsage | null | undefined): GuiUsageView | null {
  if (!last) return null;
  return {
    tokens: last.tokens,
    contextWindow: last.contextWindow,
    ts: last.ts,
    stale: true
  };
}

/** 实时用量 → 渲染层（带 ts 便于菜单展示；不标 stale） */
export function liveUsageView(
  usage: { tokens: number | null; contextWindow: number },
  ts?: number
): GuiUsageView {
  return {
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    ...(typeof ts === 'number' && ts > 0 ? { ts } : {})
  };
}
