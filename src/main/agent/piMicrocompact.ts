/**
 * B1 微压缩候选采集（执行层，非纯函数面）：从 pi AgentSession 的会话条目里抽出
 * 白名单工具的历史 toolResult，折算成 shared/microcompactPolicy 的候选结构。
 *
 * Pi 1.4 的当前投影已应用 Core 工具摘录及分层检查点。按投影估算剩余的
 * 轮询体积，避免用旧原文重复触发调度侧定向压缩。兼容无投影接口的旧句柄。
 *
 * 全部按结构化类型访问（SDK 版本差异容忍，与 PiSessionHandle 同风格）：缺
 * sessionManager / 条目形态不符一律返回空数组，不炸调用方。
 */
import type { MicrocompactCandidate } from '../../shared/microcompactPolicy';

interface PiToolResultMessageLike {
  role?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  content?: unknown;
}

interface PiSessionEntryLike {
  type?: unknown;
  message?: PiToolResultMessageLike;
}

interface PiSessionManagerLike {
  buildSessionProjection?: () => { entries: Array<{ sourceEntry: PiSessionEntryLike; messages: PiToolResultMessageLike[] }> };
  /** 当前叶子路径的活跃条目（压掉的历史不在内——优先用这个口径） */
  buildContextEntries?: () => unknown[];
  getEntries?: () => unknown[];
}

/** 从 content blocks 里取纯文本（图片等非文本块不计入估算，保守低估） */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

function toCandidates(entries: unknown[]): MicrocompactCandidate[] {
  const out: MicrocompactCandidate[] = [];
  for (const entry of entries) {
    const e = entry as PiSessionEntryLike;
    if (!e || e.type !== 'message' || !e.message) continue;
    const msg = e.message;
    if (msg.role !== 'toolResult') continue;
    if (typeof msg.toolCallId !== 'string' || typeof msg.toolName !== 'string') continue;
    out.push({
      id: msg.toolCallId,
      toolName: msg.toolName,
      text: toolResultText(msg.content),
      isError: msg.isError === true
    });
  }
  return out;
}

/**
 * 采集调度 pi 会话的微压缩候选：优先读取 buildSessionProjection 中的模型可见正文，
 * 旧句柄回落 buildContextEntries 或 getEntries。无会话/无 sessionManager（旧
 * SDK）/读抛错 → 空数组（判定层按 no-candidates 跳过）。
 */
export function collectSchedulerToolResultCandidates(session: unknown): MicrocompactCandidate[] {
  if (!session || typeof session !== 'object') return [];
  const sm = (session as { sessionManager?: PiSessionManagerLike }).sessionManager;
  if (!sm) return [];
  try {
    if (typeof sm.buildSessionProjection === 'function') {
      return toCandidates(sm.buildSessionProjection().entries.flatMap(row =>
        row.sourceEntry.type === 'message' ? row.messages.map(message => ({ type: 'message', message })) : []));
    }
    if (typeof sm.buildContextEntries === 'function') {
      return toCandidates(sm.buildContextEntries() ?? []);
    }
    if (typeof sm.getEntries === 'function') {
      return toCandidates(sm.getEntries() ?? []);
    }
  } catch {
    return [];
  }
  return [];
}
