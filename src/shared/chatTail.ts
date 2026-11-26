/**
 * R6：会话历史截断合同（纯函数）。只读：不改入参数组。
 */
import { guiMessageText, type GuiChatMessage } from './guiWorker';

/** 纯文本诊断也必须保留失败/中止状态，不能把无正文的失败回合投影成空回复。 */
export function guiChatTailLine(message: GuiChatMessage): ChatTailLine {
  return {
    role: message.role,
    text: [
      guiMessageText(message),
      message.error ? `[error] ${message.error}` : '',
      message.aborted ? '[aborted]' : ''
    ].filter(Boolean).join('\n'),
    ts: message.ts
  };
}

export const CHAT_TAIL_DEFAULT_N = 12;
export const CHAT_TAIL_MAX_N = 40;
export const CHAT_TAIL_MSG_CHARS = 2000;
export const CHAT_TAIL_TOTAL_CHARS = 8000;

export interface ChatTailLine {
  role: string;
  text: string;
  ts?: number;
}

export function clampChatTailN(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return CHAT_TAIL_DEFAULT_N;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > CHAT_TAIL_MAX_N) return CHAT_TAIL_MAX_N;
  return i;
}

export function truncateChatTailText(s: string, max = CHAT_TAIL_MSG_CHARS): string {
  const clean = s.replace(/\s+$/g, '');
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

/** O13 事件尾摘要上限（字符） */
export const TAIL_SUMMARY_MAX_CHARS = 120;

/**
 * O13：完成事件 detail 里的最后一条 assistant 纯文本摘要——压缩空白、
 * 截 max 字符加省略号；空文本返回 undefined（调用方省略该段）。
 */
export function tailSummary(
  text: string | undefined | null,
  max = TAIL_SUMMARY_MAX_CHARS
): string | undefined {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 取末 n 条并截断；返回新数组，不改动 source */
export function tailChatLines(source: readonly ChatTailLine[], n: number, totalMax = CHAT_TAIL_TOTAL_CHARS): ChatTailLine[] {
  const take = source.slice(Math.max(0, source.length - n)).map((m) => ({
    role: m.role,
    text: truncateChatTailText(m.text),
    ...(typeof m.ts === 'number' ? { ts: m.ts } : {})
  }));
  let budget = totalMax;
  const out: ChatTailLine[] = [];
  for (let i = take.length - 1; i >= 0; i--) {
    const line = take[i]!;
    if (budget <= 0) break;
    const text = line.text.length > budget ? `${line.text.slice(0, budget)}…` : line.text;
    out.unshift({ ...line, text });
    budget -= text.length;
  }
  return out;
}
