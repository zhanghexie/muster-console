/**
 * 专用 Pi 记忆会话配置。只有显式候选或用户记忆消息才调用模型；没有空闲扫描。
 * 专用模型优先，其次调度 Agent 当前模型，最后使用全局 active；不继承会话回退链。
 * 旧巩固阈值仍可解析，供历史配置与离线回放兼容；不控制新会话的准入或触发。
 */

/** @deprecated Legacy extraction transport filter. The dedicated Pi session uses its selected provider API. */
export function supportsMemoryModelApi(api?:string):boolean {
  return !api||api==='openai-completions'||api==='openai-responses';
}

export interface MemoryConsolidationConfig {
  /** Automatic admission, shadow observation, or a stopped processor. No human review queue. */
  admissionMode?: 'automatic' | 'observe' | 'paused';
  /** 关闭后停止候选处理；仍允许可靠入队及删除现有知识。 */
  enabled?: boolean;
  /** Cross-event abstraction stays opt-in until downstream benefit is demonstrated. */
  knowledgeAbstraction?: boolean;
  /** 巩固专用服务商 id（缺省=跟随调度 agent 当前模型/全局 active） */
  providerId?: string;
  /** 巩固专用模型 id（缺省=跟随调度 agent 当前模型/全局 active） */
  modelId?: string;
  /** @deprecated 旧巩固回放阈值，新会话不使用。 */
  minScore?: number;
  /** @deprecated 旧巩固回放阈值；曝光次数不能晋升知识。 */
  minRecallCount?: number;
  /** @deprecated 旧巩固回放阈值，新会话不使用。 */
  minUniqueQueries?: number;
  /** @deprecated 旧巩固回放阈值，新会话没有人工审批分支。 */
  highConfidenceAdd?: number;
  /** pending staging 未晋升的过期天数（缺省 14） */
  stagingPendingTtlDays?: number;
  /** @deprecated 仅供旧巩固回放；新会话没有空闲模型调用。 */
  idleMinIntervalHours?: number;
  /** 转录索引滚动保留天数（B8 收尾；缺省 90。仅淘汰 transcript chunk，策展/情景 markdown 不动） */
  transcriptRetentionDays?: number;
}

export const DEFAULT_MEMORY_CONSOLIDATION_CONFIG: MemoryConsolidationConfig = {
  admissionMode: 'automatic',
  enabled: true,
  knowledgeAbstraction: false,
  minScore: 0.55,
  minRecallCount: 2,
  minUniqueQueries: 2,
  highConfidenceAdd: 0.75,
  stagingPendingTtlDays: 14,
  idleMinIntervalHours: 6,
  transcriptRetentionDays: 90
};

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(0, Math.min(1, n));
}

function clampMin(v: unknown, fallback: number, min: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(min, n);
}

/** 落盘归一：未知形态回默认；数值项夹取合法域（0–1 / 正数） */
export function normalizeMemoryConsolidationConfig(raw: unknown): MemoryConsolidationConfig {
  const d = DEFAULT_MEMORY_CONSOLIDATION_CONFIG;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...d };
  }
  const o = raw as Record<string, unknown>;
  const out: MemoryConsolidationConfig = {
    admissionMode: o.admissionMode === 'observe' || o.admissionMode === 'paused' ? o.admissionMode : 'automatic',
    enabled: o.enabled === undefined ? d.enabled : o.enabled === true,
    knowledgeAbstraction: o.knowledgeAbstraction === true,
    minScore: clamp01(o.minScore, d.minScore!),
    minRecallCount: clampMin(o.minRecallCount, d.minRecallCount!, 0),
    minUniqueQueries: clampMin(o.minUniqueQueries, d.minUniqueQueries!, 0),
    highConfidenceAdd: clamp01(o.highConfidenceAdd, d.highConfidenceAdd!),
    stagingPendingTtlDays: clampMin(o.stagingPendingTtlDays, d.stagingPendingTtlDays!, 1),
    idleMinIntervalHours: clampMin(o.idleMinIntervalHours, d.idleMinIntervalHours!, 0.1),
    transcriptRetentionDays: clampMin(o.transcriptRetentionDays, d.transcriptRetentionDays!, 1)
  };
  if (typeof o.providerId === 'string' && o.providerId.trim()) out.providerId = o.providerId.trim();
  if (typeof o.modelId === 'string' && o.modelId.trim()) out.modelId = o.modelId.trim();
  return out;
}

/**
 * 巩固目标模型解析（纯函数）：专用配置优先；未配置回落调用方传入的调度 agent
 * 当前模型快照（可为 undefined=运行时用全局 active 兜底）。「不继承会话回退链」
 * 由调用方保证：这里只做一层显式选择，不做多级回落。
 */
export function resolveConsolidationTarget(
  cfg: MemoryConsolidationConfig | undefined,
  schedulerTarget: { providerId?: string; modelId?: string } | undefined
): { providerId?: string; modelId?: string } {
  const c = cfg ?? DEFAULT_MEMORY_CONSOLIDATION_CONFIG;
  return {
    providerId: c.providerId?.trim() || schedulerTarget?.providerId?.trim() || undefined,
    modelId: c.modelId?.trim() || schedulerTarget?.modelId?.trim() || undefined
  };
}
