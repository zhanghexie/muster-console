import type { Agent } from '@earendil-works/pi-agent-core';
import { classifyWorkerRuntimeFailure, type WorkerRuntimeFailure } from '../../../tasks/workerRoutingPolicy';

const BODY_LIMIT = 8192;
const BODY_DEADLINE_MS = 500;
const FETCH_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);

async function readErrorJson(response: Response): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new Uint8Array(BODY_LIMIT);
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return;
    const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), BODY_DEADLINE_MS); timer.unref?.(); });
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk) return;
      if (chunk.done) return JSON.parse(new TextDecoder().decode(body.subarray(0, length)));
      if (length + chunk.value.length > body.length) return;
      body.set(chunk.value, length);
      length += chunk.value.length;
    }
  } catch { /* The SDK still receives the original unread response. */ }
  finally {
    if (timer) clearTimeout(timer);
    void reader?.cancel().catch(() => {});
  }
}

/** Observe the exact provider response before the SDK flattens it into display text. */
export function observeWorkerProviderFailure(agent: Pick<Agent, 'streamFunction'>, record: (failure: WorkerRuntimeFailure | undefined) => void): void {
  const stream = agent.streamFunction;
  if (typeof stream !== 'function') return;
  agent.streamFunction = function (model, context, options) {
    record(undefined);
    if (!FETCH_APIS.has(model.api)) return stream.call(this, model, context, { ...options, maxRetries: 0 });
    const request = options?.fetch ?? globalThis.fetch;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const response = await request(url, init);
      if (response.ok) record(undefined);
      else {
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : undefined;
        record(classifyWorkerRuntimeFailure({ status: response.status, retryAfterMs, error: await readErrorJson(response) }));
      }
      return response;
    };
    return stream.call(this, model, context, { ...options, fetch, maxRetries: 0 });
  };
}
