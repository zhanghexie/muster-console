/**
 * 调度对话模型选择的持久化纯逻辑（agent-models.json，按工作区）。
 * 与 agent-modes 同模式：store 只做 JSON IO，形状校验在此，重启恢复时过滤失效条目。
 * 修复：此前 switchModel 只写内存 bucket，重启后回落全局默认（用户选的模型静默丢失）。
 */

/** 单个工作区的调度对话模型选择（会话级覆盖全局默认） */
export interface AgentModelSelection {
  providerId: string;
  modelId: string;
}

/** 校验单条选择：两字段均为非空字符串才有效（trim 后判定） */
export function normalizeAgentModelSelection(v: unknown): AgentModelSelection | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const providerId = typeof r.providerId === 'string' ? r.providerId.trim() : '';
  const modelId = typeof r.modelId === 'string' ? r.modelId.trim() : '';
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/** 全量规整落盘数据：丢弃形状非法的条目（含陈旧/手工编辑损坏），无有效条目返回空表 */
export function normalizeAgentModelSelections(raw: unknown): Record<string, AgentModelSelection> {
  const out: Record<string, AgentModelSelection> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [wsId, v] of Object.entries(raw as Record<string, unknown>)) {
    const sel = normalizeAgentModelSelection(v);
    if (sel) out[wsId] = sel;
  }
  return out;
}

/**
 * 调度模型解析链（B5，B4 评审 MINOR-2 收窄）：会话级覆盖 → 工作区级持久选择 →
 * undefined（调用方回落全局 active）。memoryFlush / memoryConsolidation 的「缺省跟
 * 调度」经此取真值。纯函数（test/*.mjs 直测）。
 */
export function pickSchedulerModelTarget(
  session: { providerId?: string; modelId?: string } | undefined,
  persisted: AgentModelSelection | undefined
): { providerId?: string; modelId?: string } {
  const a = normalizeAgentModelSelection(session ?? null);
  if (a) return { providerId: a.providerId, modelId: a.modelId };
  const b = normalizeAgentModelSelection(persisted ?? null);
  if (b) return { providerId: b.providerId, modelId: b.modelId };
  return {};
}
