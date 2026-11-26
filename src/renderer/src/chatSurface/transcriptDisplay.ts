import type { ChatMessage } from '../../../shared/types';
import { locateStreamingAssistantIndex } from '../../../shared/chatSurface';

export type TranscriptDisplayCacheEntry<T> = {
  src: T;
  streaming: boolean;
  out: ChatMessage;
  at: number;
};

export type TranscriptDisplayCache<T> = Map<string, TranscriptDisplayCacheEntry<T>>;

/**
 * Maps a host message model to the stable ChatMessage projection consumed by
 * row rendering. Keeping the cache protocol here makes the transcript view
 * responsible for layout while this module owns projection reuse and stream
 * throttling.
 */
export function mapTranscriptMessages<T extends { id: string; role: 'user' | 'assistant' }>(input: {
  messages: readonly T[];
  busy: boolean;
  cache: TranscriptDisplayCache<T>;
  toDisplay: (message: T, streaming: boolean) => ChatMessage;
  messagesEqual?: (a: T, b: T) => boolean;
  throttleMs: number;
  now?: () => number;
}): ChatMessage[] {
  const now = input.now ?? Date.now;
  const activeIndex = locateStreamingAssistantIndex(input.messages, input.busy);
  const next: ChatMessage[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < input.messages.length; index++) {
    const message = input.messages[index]!;
    seen.add(message.id);
    const streaming = input.busy && index === activeIndex && message.role === 'assistant';
    const hit = input.cache.get(message.id);
    const timestamp = now();
    const throttled = streaming && !!hit && hit.streaming && timestamp - hit.at < input.throttleMs;
    const reusable = hit && (
      throttled ||
      (hit.streaming === streaming &&
        (hit.src === message || (input.messagesEqual ? input.messagesEqual(hit.src, message) : false)))
    );
    const output = reusable ? hit.out : input.toDisplay(message, streaming);
    if (!hit || hit.out !== output || hit.streaming !== streaming) {
      input.cache.set(message.id, { src: message, streaming, out: output, at: timestamp });
    }
    next.push(output);
  }

  for (const id of input.cache.keys()) {
    if (!seen.has(id)) input.cache.delete(id);
  }
  return next;
}
