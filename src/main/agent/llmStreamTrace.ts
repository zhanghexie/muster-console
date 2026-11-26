/**
 * 调度 LLM SSE 线级观测：包一层 global fetch，只盯 /responses 与 /chat/completions。
 * 默认关闭——旁路 tee 会把整段成功流再解码一遍。要查断流时设
 * MUSTER_LLM_STREAM_TRACE=1（只记失败）或 =all（含成功）。
 * 不记请求体、不记 Authorization。
 * 失败行落 userData/logs/llm-stream.ndjson（安装版没有控制台，只靠 console.error 等于没写）。
 */
import { mkdirSync, appendFileSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { rotateIfNeeded } from '../../shared/rendererErrorLog';

export const LLM_STREAM_TRACE_PREFIX = '[llm-stream]';
export const LLM_STREAM_LOG_NAME = 'llm-stream.ndjson';
export const LLM_STREAM_TRACE_ENV = 'MUSTER_LLM_STREAM_TRACE';

export function isLlmStreamTraceEnabled(value = process.env[LLM_STREAM_TRACE_ENV]): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'all';
}

export function isLlmStreamTraceLogAll(value = process.env[LLM_STREAM_TRACE_ENV]): boolean {
  return (value ?? '').trim().toLowerCase() === 'all';
}

export const TERMINAL_SSE_TYPES = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
  '[DONE]'
]);

export type LlmStreamCloseReason =
  | 'completed'
  | 'empty-stream'
  | 'json-not-sse'
  | 'no-terminal'
  | 'http-error'
  | 'network'
  | 'aborted';

export const BODY_PREVIEW_MAX = 240;

export type LlmStreamTrace = {
  host: string;
  path: string;
  status: number | null;
  ttfbMs: number | null;
  elapsedMs: number;
  bytes: number;
  sseEvents: number;
  firstEventType: string | null;
  lastEventType: string | null;
  sawTerminal: boolean;
  aborted: boolean;
  errorName: string | null;
  errorMessage: string | null;
  eventLoopLagMsStart: number;
  eventLoopLagMsEnd: number;
  closeReason: LlmStreamCloseReason;
  responseHeaders: Record<string, string>;
  /** 失败时留下的响应体开头。不记请求体、不记 Authorization。 */
  bodyPreview: string | null;
};

export type FetchLike = typeof globalThis.fetch;
type FetchInput = Parameters<FetchLike>[0];

const TRACE_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'cf-ray',
  'connection',
  'transfer-encoding'
] as const;

let installed = false;
let previousFetch: FetchLike | undefined;

export function isLlmStreamUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'http://local.invalid');
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return path.endsWith('/responses') || path.endsWith('/chat/completions');
  } catch {
    return false;
  }
}

export function requestUrlOf(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

export function eventTypeFromSseLine(line: string): string | null {
  const trimmed = line.replace(/\r$/, '').trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return '[DONE]';
  try {
    const obj = JSON.parse(payload) as { type?: unknown };
    return typeof obj?.type === 'string' && obj.type ? obj.type : 'json';
  } catch {
    return 'text';
  }
}

export function classifyLlmStreamClose(input: {
  status: number | null;
  aborted: boolean;
  eventTypes: string[];
  errorName?: string | null;
  contentType?: string | null;
}): LlmStreamCloseReason {
  if (input.aborted || input.errorName === 'AbortError') return 'aborted';
  if (input.status == null) return 'network';
  if (input.status >= 400) return 'http-error';
  const sawTerminal = input.eventTypes.some((t) => TERMINAL_SSE_TYPES.has(t));
  if (sawTerminal) return 'completed';
  if (input.eventTypes.length === 0) {
    if (input.contentType && /application\/json/i.test(input.contentType)) return 'json-not-sse';
    return 'empty-stream';
  }
  return 'no-terminal';
}

export function sanitizeBodyPreview(text: string, max = BODY_PREVIEW_MAX): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted]')
    .replace(/("(?:api[_-]?key|authorization|token)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .slice(0, max);
}

export function measureEventLoopLagMs(): Promise<number> {
  const start = Date.now();
  return new Promise((resolve) => {
    setImmediate(() => resolve(Date.now() - start));
  });
}

function pickResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TRACE_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function safeErrorMessage(err: unknown): { name: string | null; message: string | null } {
  if (!err || typeof err !== 'object') {
    return { name: null, message: err == null ? null : String(err).slice(0, 200) };
  }
  const name = 'name' in err && typeof err.name === 'string' ? err.name : null;
  const message = 'message' in err && typeof err.message === 'string' ? err.message.slice(0, 200) : null;
  return { name, message };
}

function hostPathOf(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url, 'http://local.invalid');
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    return { host: '', path: url.slice(0, 80) };
  }
}

export function wrapFetchForLlmTrace(baseFetch: FetchLike, onTrace: (trace: LlmStreamTrace) => void): FetchLike {
  return async function tracedFetch(input, init) {
    const url = requestUrlOf(input);
    if (!isLlmStreamUrl(url)) {
      return baseFetch(input, init);
    }

    const startedAt = Date.now();
    const lagStartP = measureEventLoopLagMs();
    const signal =
      init?.signal ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
    let aborted = Boolean(signal?.aborted);
    const onAbort = (): void => {
      aborted = true;
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const { host, path } = hostPathOf(url);
    const emit = async (partial: {
      status: number | null;
      ttfbMs: number | null;
      bytes: number;
      eventTypes: string[];
      error?: unknown;
      responseHeaders?: Record<string, string>;
      bodyPreview?: string | null;
    }): Promise<void> => {
      const lagEnd = await measureEventLoopLagMs();
      const lagStart = await lagStartP;
      const eventTypes = partial.eventTypes;
      const err = safeErrorMessage(partial.error);
      const responseHeaders = partial.responseHeaders ?? {};
      const closeReason = classifyLlmStreamClose({
        status: partial.status,
        aborted,
        eventTypes,
        errorName: err.name,
        contentType: responseHeaders['content-type'] ?? null
      });
      onTrace({
        host,
        path,
        status: partial.status,
        ttfbMs: partial.ttfbMs,
        elapsedMs: Date.now() - startedAt,
        bytes: partial.bytes,
        sseEvents: eventTypes.length,
        firstEventType: eventTypes[0] ?? null,
        lastEventType: eventTypes[eventTypes.length - 1] ?? null,
        sawTerminal: eventTypes.some((t) => TERMINAL_SSE_TYPES.has(t)),
        aborted,
        errorName: err.name,
        errorMessage: err.message,
        eventLoopLagMsStart: lagStart,
        eventLoopLagMsEnd: lagEnd,
        closeReason,
        responseHeaders,
        bodyPreview: closeReason === 'completed' ? null : sanitizeBodyPreview(partial.bodyPreview ?? '')
      });
    };

    try {
      const res = await baseFetch(input, init);
      const ttfbMs = Date.now() - startedAt;
      const responseHeaders = pickResponseHeaders(res.headers);
      if (!res.body || typeof res.body.tee !== 'function') {
        await emit({
          status: res.status,
          ttfbMs,
          bytes: 0,
          eventTypes: [],
          responseHeaders,
          bodyPreview: null
        });
        return res;
      }

      const [tap, passthrough] = res.body.tee();
      const eventTypes: string[] = [];
      let bytes = 0;
      let buf = '';
      let preview = '';
      const decoder = new TextDecoder();
      const flushLine = (line: string): void => {
        const type = eventTypeFromSseLine(line);
        if (type) eventTypes.push(type);
      };
      void (async () => {
        const reader = tap.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            bytes += value.byteLength;
            const chunk = decoder.decode(value, { stream: true });
            if (preview.length < BODY_PREVIEW_MAX) preview += chunk;
            buf += chunk;
            for (;;) {
              const nl = buf.indexOf('\n');
              if (nl < 0) break;
              flushLine(buf.slice(0, nl));
              buf = buf.slice(nl + 1);
            }
          }
          buf += decoder.decode();
          if (buf.trim()) flushLine(buf);
        } catch (error) {
          await emit({
            status: res.status,
            ttfbMs,
            bytes,
            eventTypes,
            error,
            responseHeaders,
            bodyPreview: preview
          });
          return;
        }
        await emit({
          status: res.status,
          ttfbMs,
          bytes,
          eventTypes,
          responseHeaders,
          bodyPreview: preview || buf
        });
      })();

      return new Response(passthrough, res);
    } catch (error) {
      await emit({
        status: null,
        ttfbMs: null,
        bytes: 0,
        eventTypes: [],
        error
      });
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

export function logLlmStreamTrace(trace: LlmStreamTrace, logAll = false): void {
  if (trace.closeReason === 'completed' && !logAll) return;
  console.error(LLM_STREAM_TRACE_PREFIX, JSON.stringify(trace));
}

export function persistLlmStreamTrace(file: string, trace: LlmStreamTrace): void {
  mkdirSync(dirname(file), { recursive: true });
  rotateIfNeeded(
    () => statSync(file).size,
    () => {
      const old = `${file}.old`;
      try {
        unlinkSync(old);
      } catch {
        /* none */
      }
      renameSync(file, old);
    }
  );
  appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...trace })}\n`, 'utf8');
}

/** 包一层 global fetch。必须在 import Pi / 新建 OpenAI client 之前调用。默认 no-op。 */
export function installLlmStreamTrace(opts?: { persistFile?: string }): void {
  if (installed) return;
  if (!isLlmStreamTraceEnabled()) return;
  if (typeof globalThis.fetch !== 'function') return;
  installed = true;
  previousFetch = globalThis.fetch.bind(globalThis);
  const logAll = isLlmStreamTraceLogAll();
  const persistFile = opts?.persistFile;
  globalThis.fetch = wrapFetchForLlmTrace(previousFetch, (trace) => {
    logLlmStreamTrace(trace, logAll);
    if (persistFile && (trace.closeReason !== 'completed' || logAll)) {
      try {
        persistLlmStreamTrace(persistFile, trace);
      } catch {
        /* 落盘失败不影响请求 */
      }
    }
  });
}

/** 仅测试：卸掉包层，避免污染同进程后续用例。 */
export function restoreLlmStreamTraceForTest(): void {
  if (!installed) return;
  if (previousFetch) globalThis.fetch = previousFetch;
  previousFetch = undefined;
  installed = false;
}
