import type { ChatMessage } from './types';
import type { GuiChatMessage } from './guiWorker';

/** Last sentence of a reply, bounded from the end without copying a long transcript. */
export function boardReplyPartsLine(parts: readonly string[]): string {
  const chars: string[] = [];
  let hasWords = false;
  let pendingSpace = false;
  for (let p = parts.length - 1; p >= 0; p--) {
    const part = parts[p]!;
    for (let i = part.length; i > 0;) {
      const end = i;
      const low = part.charCodeAt(--i);
      if (low >= 0xdc00 && low <= 0xdfff && i > 0) {
        const high = part.charCodeAt(i - 1);
        if (high >= 0xd800 && high <= 0xdbff) i--;
      }
      const char = part.slice(i, end);
      if (/\s/u.test(char)) {
        if (hasWords && /[\r\n]/u.test(char)) return chars.reverse().join('').trim();
        if (chars.length) pendingSpace = true;
        continue;
      }
      if (hasWords && /[。！？!?；;]/u.test(char)) return chars.reverse().join('').trim();
      if (hasWords && char === '.' && (i === 0 || /\s/u.test(part[i - 1] ?? '') || /\s/u.test(part[end] ?? ''))) return chars.reverse().join('').trim();
      if (pendingSpace && chars.length < 240) chars.push(' ');
      pendingSpace = false;
      if (chars.length >= 240) return chars.reverse().join('').trim();
      chars.push(char);
      // Keep trailing emoji with the preceding sentence when it contains words.
      hasWords ||= /[\p{L}\p{N}]/u.test(char);
      if (chars.length >= 240) return chars.reverse().join('').trim();
    }
  }
  return chars.reverse().join('').trim();
}
export function boardReplyLine(text: string): string { return boardReplyPartsLine([text]); }

export function guiReplyLine(messages: readonly GuiChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || message.host) continue;
    const line = boardReplyPartsLine(message.parts.filter(part => part.kind === 'text').map(part => part.text));
    if (line) return line;
  }
  return '';
}

export interface SchedulerReplyPreview {
  messageId: string;
  text: string;
}

export function schedulerReplyPreview(messages: readonly ChatMessage[]): SchedulerReplyPreview | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || message.local || message.host) continue;
    const parts = message.parts?.filter(part => part.kind === 'text');
    const line = message.parts?.length ? boardReplyPartsLine((parts ?? []).map(part => part.text)) : boardReplyLine(message.content ?? '');
    if (line) return { messageId: message.id, text: line };
  }
  return null;
}

export function schedulerReplyLine(messages: readonly ChatMessage[]): string {
  return schedulerReplyPreview(messages)?.text ?? '';
}
