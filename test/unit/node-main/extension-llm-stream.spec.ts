import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import { llmChatStream } from '../../../src/main/extensions/extensionLlm';
import type { AppContext } from '../../../src/main/context';

function context() {
  const record = vi.fn();
  const ctx = { config: { get: () => ({ openai: { baseUrl: 'http://fixture/v1', apiKey: 'fixture', model: 'fixture' } }) }, usage: { recordExtLlmCall: record } } as unknown as AppContext;
  return { ctx, record };
}

afterEach(() => vi.unstubAllGlobals());

describe('extension LLM streaming', () => {
  it('parses OpenAI SSE deltas and records one completed call', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n'
    ];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, reasoning_effort: 'low' });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetch);
    const deltas: string[] = [];
    const result = await llmChatStream(context().ctx, 'stream', [{ role: 'user', content: 'hello' }], { thinking: 'light' }, delta => deltas.push(delta));
    expect(result).toEqual({ text: 'hello world' });
    expect(deltas).toEqual(['hello', ' world']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts the upstream stream when the caller is cancelled', async () => {
    let upstream!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      upstream = init?.signal as AbortSignal;
      await new Promise((_resolve, reject) => upstream.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      throw new DOMException('aborted', 'AbortError');
    }));
    const controller = new AbortController();
    const pending = llmChatStream(context().ctx, 'cancel', [{ role: 'user', content: 'hello' }], {}, () => {}, 'cancel', controller.signal);
    await vi.waitFor(() => expect(upstream).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstream.aborted).toBe(true);
  });
});
