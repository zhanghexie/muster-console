/**
 * LLM SSE 线级观测：分类表 + 包过的 fetch 必须能从真 HTTP 流读出 closeReason。
 * 自查：把 empty-stream 误判成 network / 不包 /responses 即红。
 * 运行: node test/llm-stream-trace.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-stream-trace-'));
const compile = createSharedCompiler(root, compileTmp);
const entry = compile('main/agent/llmStreamTrace.ts');
  const {
  isLlmStreamUrl,
  eventTypeFromSseLine,
  classifyLlmStreamClose,
  wrapFetchForLlmTrace,
  persistLlmStreamTrace,
  requestUrlOf,
  sanitizeBodyPreview,
  isLlmStreamTraceEnabled,
  isLlmStreamTraceLogAll,
  installLlmStreamTrace,
  restoreLlmStreamTraceForTest
} = await import(pathToFileURL(entry).href);

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function waitTraces(traces, n = 1, ms = 2000) {
  const t0 = Date.now();
  while (traces.length < n && Date.now() - t0 < ms) {
    await new Promise((r) => setImmediate(r));
  }
}

async function collect(fetchImpl, url, init) {
  const traces = [];
  const traced = wrapFetchForLlmTrace(fetchImpl, (t) => traces.push(t));
  const res = await traced(url, init);
  try {
    await res.text();
  } catch {
    /* 对端掐了仍要留下 trace */
  }
  await waitTraces(traces);
  return { res, traces };
}

try {
  assert.equal(isLlmStreamUrl('https://open.bigmodel.cn/api/v1/responses'), true);
  assert.equal(isLlmStreamUrl('https://api.openai.com/v1/responses/'), true);
  assert.equal(isLlmStreamUrl('https://api.deepseek.com/chat/completions'), true);
  assert.equal(isLlmStreamUrl('https://api.openai.com/v1/models'), false);
  assert.equal(isLlmStreamUrl('http://127.0.0.1:9/health'), false);
  assert.equal(requestUrlOf('https://x.example/v1/responses?x=1'), 'https://x.example/v1/responses?x=1');

  assert.equal(eventTypeFromSseLine('data: {"type":"response.created"}'), 'response.created');
  assert.equal(eventTypeFromSseLine('data: [DONE]'), '[DONE]');
  assert.equal(eventTypeFromSseLine('event: ping'), null);

  assert.equal(
    classifyLlmStreamClose({ status: 200, aborted: false, eventTypes: ['response.completed'] }),
    'completed'
  );
  assert.equal(
    classifyLlmStreamClose({ status: 200, aborted: false, eventTypes: [] }),
    'empty-stream',
    'HTTP 200 但 0 事件 = 历史 usage=0 那类'
  );
  assert.equal(
    classifyLlmStreamClose({
      status: 200,
      aborted: false,
      eventTypes: [],
      contentType: 'application/json'
    }),
    'json-not-sse',
    '200 + JSON 正文不是 SSE（2026-09-16 18:51/18:54 真机）'
  );
  assert.equal(sanitizeBodyPreview('  {"error":{"message":"busy"}}  '), '{"error":{"message":"busy"}}');
  assert.equal(sanitizeBodyPreview('{"api_key":"sk-abcdefghijklmnopqrst"}')?.includes('[redacted]'), true);
  assert.equal(sanitizeBodyPreview(''), null);
  assert.equal(
    classifyLlmStreamClose({
      status: 200,
      aborted: false,
      eventTypes: ['response.created', 'response.output_text.delta']
    }),
    'no-terminal'
  );
  assert.equal(classifyLlmStreamClose({ status: 502, aborted: false, eventTypes: [] }), 'http-error');
  assert.equal(classifyLlmStreamClose({ status: null, aborted: false, eventTypes: [] }), 'network');
  assert.equal(
    classifyLlmStreamClose({ status: 200, aborted: true, eventTypes: [] }),
    'aborted'
  );

  {
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'empty-1' });
      res.end();
    });
    try {
      const { traces } = await collect(fetch, `${origin}/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].closeReason, 'empty-stream');
      assert.equal(traces[0].status, 200);
      assert.equal(traces[0].sseEvents, 0);
      assert.equal(traces[0].path, '/v1/responses');
      assert.equal(traces[0].responseHeaders['x-request-id'], 'empty-1');
      assert.equal(traces[0].bodyPreview, null);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  {
    const payload = '{"error":{"code":"1301","message":"系统繁忙，请稍后重试"}}';
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', connection: 'close' });
      res.end(payload);
    });
    try {
      const { traces } = await collect(fetch, `${origin}/api/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(traces[0].closeReason, 'json-not-sse');
      assert.equal(traces[0].status, 200);
      assert.equal(traces[0].sseEvents, 0);
      assert.equal(traces[0].bytes, Buffer.byteLength(payload));
      assert.equal(traces[0].responseHeaders['content-type'], 'application/json');
      assert.equal(traces[0].bodyPreview, payload);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  {
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created"}\n\n');
      res.end();
    });
    try {
      const { traces } = await collect(fetch, `${origin}/api/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(traces[0].closeReason, 'no-terminal');
      assert.equal(traces[0].firstEventType, 'response.created');
      assert.equal(traces[0].sawTerminal, false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  {
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created"}\n\n');
      res.write('data: {"type":"response.completed"}\n\n');
      res.end();
    });
    try {
      const { traces } = await collect(fetch, `${origin}/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(traces[0].closeReason, 'completed');
      assert.equal(traces[0].sawTerminal, true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  {
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad gateway"}');
    });
    try {
      const { traces } = await collect(fetch, `${origin}/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(traces[0].closeReason, 'http-error');
      assert.equal(traces[0].status, 502);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  {
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    try {
      const traces = [];
      const traced = wrapFetchForLlmTrace(fetch, (t) => traces.push(t));
      const res = await traced(`${origin}/health`);
      await res.text();
      assert.equal(traces.length, 0, '非 LLM 路径不得记账');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  {
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end();
    });
    try {
      const { default: OpenAI } = await import('openai');
      const traces = [];
      const traced = wrapFetchForLlmTrace(fetch, (t) => traces.push(t));
      const client = new OpenAI({
        apiKey: 'unused',
        baseURL: `${origin}/v1`,
        dangerouslyAllowBrowser: true,
        fetch: traced,
        maxRetries: 0
      });
      try {
        const { data } = await client.responses
          .create({ model: 'probe', input: 'hi', stream: true, store: false }, { maxRetries: 0 })
          .withResponse();
        for await (const _ev of data) {
          /* drain */
        }
      } catch {
        /* 空流对 SDK 就是失败；我们要的是 closeReason */
      }
      await waitTraces(traces);
      assert.equal(traces.length >= 1, true, 'OpenAI client 必须打到同一层 fetch 包');
      assert.equal(traces[0].closeReason, 'empty-stream');
      assert.equal(traces[0].status, 200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-stream-log-'));
    const file = path.join(dir, 'llm-stream.ndjson');
    persistLlmStreamTrace(file, {
      host: 'example.test',
      path: '/v1/responses',
      status: 200,
      ttfbMs: 1,
      elapsedMs: 2,
      bytes: 0,
      sseEvents: 0,
      firstEventType: null,
      lastEventType: null,
      sawTerminal: false,
      aborted: false,
      errorName: null,
      errorMessage: null,
      eventLoopLagMsStart: 0,
      eventLoopLagMsEnd: 0,
      closeReason: 'empty-stream',
      responseHeaders: {},
      bodyPreview: null
    });
    const line = fs.readFileSync(file, 'utf8').trim();
    const rec = JSON.parse(line);
    assert.equal(rec.closeReason, 'empty-stream');
    assert.equal(typeof rec.ts, 'number');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const piSrc = fs.readFileSync(path.join(root, 'src/main/agent/providers/piProvider.ts'), 'utf8');
  assert.match(piSrc, /installLlmStreamTrace/, 'loadPi 必须先装线级观测再 import Pi');
  assert.match(piSrc, /persistFile/, '安装版必须把 [llm-stream] 落到 userData/logs');
  assert.match(piSrc, /userDataStorage\(userData\)\.resolve\(['"]app['"], ['"]logs['"]\)/,
    'LLM trace 必须通过 storage resolver 解析 logs 根，不能直接拼接 userData');
  const src = fs.readFileSync(path.join(root, 'src/main/agent/llmStreamTrace.ts'), 'utf8');
  assert.match(src, /authorization/i, '注释或实现须声明不记 Authorization');
  assert.doesNotMatch(src, /Authorization:\s/, '不得把 Authorization 头写进 trace');
  assert.match(src, /persistLlmStreamTrace/, '失败行必须有落盘函数');
  assert.match(src, /bodyPreview/, 'JSON 假 SSE 必须留下响应体预览');
  assert.match(src, /json-not-sse/, '200 + application/json 须单独分类');
  assert.doesNotMatch(src, /RequestInfo/, '主进程 tsconfig 无 DOM，不能写 RequestInfo');
  assert.match(src, /isLlmStreamTraceEnabled/, '默认不得 tee，必须先看开关');

  assert.equal(isLlmStreamTraceEnabled(''), false);
  assert.equal(isLlmStreamTraceEnabled('0'), false);
  assert.equal(isLlmStreamTraceEnabled('1'), true);
  assert.equal(isLlmStreamTraceEnabled('all'), true);
  assert.equal(isLlmStreamTraceLogAll('1'), false);
  assert.equal(isLlmStreamTraceLogAll('all'), true);

  {
    const prev = process.env.MUSTER_LLM_STREAM_TRACE;
    try {
      delete process.env.MUSTER_LLM_STREAM_TRACE;
      restoreLlmStreamTraceForTest();
      const before = globalThis.fetch;
      installLlmStreamTrace();
      assert.equal(globalThis.fetch, before, '默认关闭时不得包装 fetch');
      process.env.MUSTER_LLM_STREAM_TRACE = '1';
      installLlmStreamTrace();
      assert.notEqual(globalThis.fetch, before, '开关打开才 tee');
    } finally {
      restoreLlmStreamTraceForTest();
      if (prev === undefined) delete process.env.MUSTER_LLM_STREAM_TRACE;
      else process.env.MUSTER_LLM_STREAM_TRACE = prev;
    }
  }

  console.log('llm-stream-trace.mjs 全部通过');
} finally {
  fs.rmSync(compileTmp, { recursive: true, force: true });
}
