/**
 * 调度对话思考档的持久化纯逻辑（agent-thinking.json，按工作区）。
 * 与 agent-models / agent-modes 同模式：store 只做 JSON IO，形状校验在此。
 * 未写入 = 跟随默认。模型目录在使用时验证保存的原生档位。
 */
import { isReasoningEffort } from './coreReasoningCatalog';

export function normalizeAgentThinking(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const level = v.trim();
  return isReasoningEffort(level) ? level : null;
}

/** 全量规整落盘数据：丢弃非法条目（含陈旧/手工编辑损坏），无有效条目返回空表 */
export function normalizeAgentThinkings(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [wsId, v] of Object.entries(raw as Record<string, unknown>)) {
    const level = normalizeAgentThinking(v);
    if (level) out[wsId] = level;
  }
  return out;
}
