import type { AgentContextStatus } from '../../shared/types';

/** pi AgentSession.getSessionStats 的缓存面（pi-ai Usage 聚合；SDK 版本相关） */
interface PiUsageStatsLike {
  tokens?: { cacheRead?: number; cacheWrite?: number };
}

/** 从 Pi AgentSession 快照模型与上下文占用（供 UI 底部状态条）；D1 起带缓存累计字段 */
export function snapshotPiContext(
  session: {
    model?: unknown;
    getContextUsage?: () => unknown;
    /** 会话累计 usage（input/output/cacheRead/cacheWrite 聚合）；缺席视为不可用 */
    getSessionStats?: () => PiUsageStatsLike | undefined;
  } | null | undefined,
  fallbackModel = ''
): AgentContextStatus {
  const model = session?.model as
    | { id?: string; name?: string; provider?: string; contextWindow?: number }
    | undefined;
  let usage:
    | { tokens?: number | null; contextWindow?: number; percent?: number | null }
    | undefined;
  try {
    usage =
      typeof session?.getContextUsage === 'function'
        ? (session.getContextUsage() as typeof usage)
        : undefined;
  } catch {
    usage = undefined;
  }
  // D1 缓存度量 spike 结论：pi-ai Usage 含 cacheRead/cacheWrite，pi AgentSession
  // getSessionStats() 聚合全会话累计——可透传；cacheWrite>0 且 cacheRead 占比即缓存命中画像
  let stats: PiUsageStatsLike | undefined;
  try {
    stats = typeof session?.getSessionStats === 'function' ? session.getSessionStats() : undefined;
  } catch {
    stats = undefined;
  }

  const modelId = String(model?.id ?? fallbackModel ?? '').trim();
  const modelName = String(model?.name ?? model?.id ?? fallbackModel ?? '').trim();
  const contextWindow =
    typeof usage?.contextWindow === 'number' && usage.contextWindow > 0
      ? usage.contextWindow
      : typeof model?.contextWindow === 'number' && model.contextWindow > 0
        ? model.contextWindow
        : null;

  return {
    modelId,
    modelName: modelName || modelId,
    provider: model?.provider ? String(model.provider) : undefined,
    tokens: typeof usage?.tokens === 'number' ? usage.tokens : null,
    contextWindow,
    percent: typeof usage?.percent === 'number' ? usage.percent : null,
    cacheReadTokens: typeof stats?.tokens?.cacheRead === 'number' ? stats.tokens.cacheRead : null,
    cacheWriteTokens: typeof stats?.tokens?.cacheWrite === 'number' ? stats.tokens.cacheWrite : null
  };
}