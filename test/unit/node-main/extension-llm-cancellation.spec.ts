import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmChat } from '../../../src/main/extensions/extensionLlm';
import { EXTENSION_LLM_TIMEOUT_MS } from '../../../src/shared/extensions';
import type { AppContext } from '../../../src/main/context';
const messages = [{ role: 'user', content: 'hello' }];
function context() {
  const record = vi.fn();
  const ctx = { config: { get: () => ({ openai: { baseUrl: 'http://fixture/v1', apiKey: 'fixture', model: 'fixture' } }) }, usage: { recordExtLlmCall: record } } as unknown as AppContext;
  return { ctx, record };
}
function pendingFetch() {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal; signals.push(signal);
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  return { fetch, signals };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('extension LLM cancellation', () => {
  it('does not start a fetch for an already cancelled call', async () => {
    const { ctx } = context(), { fetch } = pendingFetch(); const controller = new AbortController(); controller.abort();
    await expect(llmChat(ctx, 'pre', messages, undefined, 'pre', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('aborts the actual request and releases its concurrency lease', async () => {
    const { ctx, record } = context(), { fetch, signals } = pendingFetch(); const controller = new AbortController();
    const rejected = expect(llmChat(ctx, 'cancel', messages, undefined, 'cancel', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(signals[0].aborted).toBe(true); expect(record).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }) as Response);
    await expect(Promise.all([llmChat(ctx, 'cancel', messages, undefined, 'cancel'), llmChat(ctx, 'cancel', messages, undefined, 'cancel')])).resolves.toEqual([{ text: 'ok' }, { text: 'ok' }]);
  });
  it('distinguishes the request timeout from external cancellation', async () => {
    vi.useFakeTimers(); const { ctx, record } = context(), { signals } = pendingFetch();
    const rejected = expect(llmChat(ctx, 'timeout', messages)).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(EXTENSION_LLM_TIMEOUT_MS + 1); await rejected;
    expect(signals[0].aborted).toBe(true); expect(record.mock.calls.at(-1)?.[0].error).toContain(String(EXTENSION_LLM_TIMEOUT_MS / 1000));
  });
  it('rejects a response cancelled while its body was being read', async () => {
    const { ctx, record } = context(), controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { controller.abort(); return { choices: [{ message: { content: 'late' } }] }; } })));
    await expect(llmChat(ctx, 'body', messages, undefined, 'body', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(record).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});
