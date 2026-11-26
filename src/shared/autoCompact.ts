/**
 * 上下文阈值自动压缩（宿主侧）：transcript 占用占比超阈值时触发，
 * 行为复用手动 /compact（safeCompactSession / Host.compactSession）。
 * 仅能力位 autoCompact=true 的 runtime（现仅 pi）会走这条路径；
 * 宿主侧摘要重播降级不在此模块（后续单独立项）。
 */

/** 缺省占比阈值：tokens / contextWindow ≥ 0.8 即触发 */
export const DEFAULT_AUTO_COMPACT_RATIO = 0.8;

/** 可配下限（过低会过早压） */
export const AUTO_COMPACT_RATIO_MIN = 0.5;

/** 可配上限（留一点余量给当回合输出） */
export const AUTO_COMPACT_RATIO_MAX = 0.99;

/** AppConfig.autoCompact 形状 */
export interface AutoCompactConfig {
  /** 缺省 true；false 关闭自动触发（能力位仍可声明支持） */
  enabled?: boolean;
  /** tokens/contextWindow 占比阈值，缺省 0.8 */
  ratio?: number;
  /**
   * B1 微压缩（microcompact）子配置；缺省开（idle 30min / 最小节省 2000 token /
   * 保留最近 5 条）。归一与判定见 shared/microcompactPolicy.ts——type-only 惰性
   * 引用避免 autoCompact ⇄ microcompactPolicy 运行时相互引用。
   */
  micro?: import('./microcompactPolicy').MicroCompactConfig;
}

export type AutoCompactSkipReason =
  | 'no-capability'
  | 'disabled'
  | 'busy'
  | 'unknown-usage'
  | 'below-threshold';

export type AutoCompactDecision =
  | { action: 'compact' }
  | { action: 'skip'; reason: AutoCompactSkipReason };

/** 把原始 ratio 收敛到 [MIN, MAX]；非法则回缺省 */
export function normalizeAutoCompactRatio(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_AUTO_COMPACT_RATIO;
  if (raw < AUTO_COMPACT_RATIO_MIN) return AUTO_COMPACT_RATIO_MIN;
  if (raw > AUTO_COMPACT_RATIO_MAX) return AUTO_COMPACT_RATIO_MAX;
  return raw;
}

/** 配置归一：enabled 缺省 true，ratio 走 normalizeAutoCompactRatio */
export function normalizeAutoCompactConfig(raw: unknown): {
  enabled: boolean;
  ratio: number;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: true, ratio: DEFAULT_AUTO_COMPACT_RATIO };
  }
  const o = raw as AutoCompactConfig;
  return {
    enabled: o.enabled !== false,
    ratio: normalizeAutoCompactRatio(o.ratio)
  };
}

/**
 * 是否应自动触发 compact（纯判定，不含真正调用）。
 * - tokens 未知（刚 compaction / 新会话）→ 不触发，等下回合有用量再判
 * - busy / 已有 compact 在飞由调用方以 busy=true 传入（与手动 /compact 互斥）
 */
export function decideAutoCompact(input: {
  autoCompactCapable: boolean;
  configEnabled: boolean;
  ratioThreshold: number;
  tokens: number | null | undefined;
  contextWindow: number | null | undefined;
  busy: boolean;
}): AutoCompactDecision {
  if (!input.autoCompactCapable) return { action: 'skip', reason: 'no-capability' };
  if (!input.configEnabled) return { action: 'skip', reason: 'disabled' };
  if (input.busy) return { action: 'skip', reason: 'busy' };
  if (typeof input.tokens !== 'number' || !Number.isFinite(input.tokens) || input.tokens < 0) {
    return { action: 'skip', reason: 'unknown-usage' };
  }
  if (typeof input.contextWindow !== 'number' || !(input.contextWindow > 0)) {
    return { action: 'skip', reason: 'unknown-usage' };
  }
  const ratio = input.tokens / input.contextWindow;
  if (ratio < input.ratioThreshold) return { action: 'skip', reason: 'below-threshold' };
  return { action: 'compact' };
}
