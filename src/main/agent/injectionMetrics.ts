import type { InjectionSegmentMetric } from '../../shared/types';
import { MUSTER_PROMPT_SEGMENTS, SCHEDULER_WORKSPACE_SEGMENT } from './systemPrompt';

/**
 * D1 注入成本度量：把调度恒注入的分段文本折算成「段名 + 字符数 + UTF-8 字节数」。
 * 字符数给日志/面板看，字节数对齐 provider 计费与缓存的真实口径（中文 UTF-8 3 字节/字）。
 * 纯函数、无 IO，供 orchestrator 会话快照（agent:context / getContextStatus）挂 injection 字段。
 */
export function measureInjectionSegments(
  segments: ReadonlyArray<{ name: string; text: string }>
): InjectionSegmentMetric[] {
  return segments.map(({ name, text }) => ({
    name,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8')
  }));
}

/**
 * 调度面度量入口：入参即 buildMetaAgentAppendPrompt 的分段返回值（stable 在前），
 * 段名取 MUSTER_PROMPT_SEGMENTS 同一常量（消除字面漂移面），越界段兜底 segN。
 */
export function measureSchedulerInjection(segments: readonly string[]): InjectionSegmentMetric[] {
  return measureInjectionSegments(
    segments.map((text, i) => ({ name: MUSTER_PROMPT_SEGMENTS[i] ?? (i === 2 ? SCHEDULER_WORKSPACE_SEGMENT : `seg${i}`), text }))
  );
}
