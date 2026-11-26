/**
 * 压缩前 flush 配置（memory-refactor 决策 #8 / §6.2）：
 * - flush 是一次 LLM 静默回合（有成本），可关；
 * - 模型走**专用配置项**（providerId/modelId），缺省跟随调度 agent 当前模型，
 *   **不继承会话回退链**（turnRetry/多级回落都不参与——flush 一次失败就放弃，
 *   压缩照常进行）。
 * 纯函数层（normalize 与默认值收口在此；main/memory/flush.ts 是执行侧）。
 */

export interface MemoryFlushConfig {
  /** 关闭后压缩前不跑 flush 静默回合（默认开——它只在压缩触发时发生，频次低） */
  enabled?: boolean;
  /** flush 专用服务商 id（缺省=跟随调度 agent 当前模型） */
  providerId?: string;
  /** flush 专用模型 id（缺省=跟随调度 agent 当前模型） */
  modelId?: string;
}

export const DEFAULT_MEMORY_FLUSH_CONFIG: MemoryFlushConfig = { enabled: true };

/** 落盘归一：未知形态回默认（enabled 默认 true；provider/model 只认非空串） */
export function normalizeMemoryFlushConfig(raw: unknown): MemoryFlushConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_MEMORY_FLUSH_CONFIG };
  }
  const o = raw as { enabled?: unknown; providerId?: unknown; modelId?: unknown };
  const out: MemoryFlushConfig = {
    enabled: o.enabled === undefined ? true : o.enabled === true
  };
  if (typeof o.providerId === 'string' && o.providerId.trim()) out.providerId = o.providerId.trim();
  if (typeof o.modelId === 'string' && o.modelId.trim()) out.modelId = o.modelId.trim();
  return out;
}

/**
 * flush 目标模型解析（纯函数）：flush 专用配置优先；未配置回落**调用方传入的
 * 调度 agent 当前模型**（orchestrator 桶的 providerId/modelId 快照）。
 * 「不继承会话回退链」由调用方保证：这里只做一层显式选择，不做多级回落。
 */
export function resolveFlushTarget(
  flush: MemoryFlushConfig | undefined,
  schedulerTarget: { providerId?: string; modelId?: string } | undefined
): { providerId?: string; modelId?: string } {
  const cfg = flush ?? DEFAULT_MEMORY_FLUSH_CONFIG;
  return {
    providerId: cfg.providerId?.trim() || schedulerTarget?.providerId?.trim() || undefined,
    modelId: cfg.modelId?.trim() || schedulerTarget?.modelId?.trim() || undefined
  };
}
