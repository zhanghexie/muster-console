/** 连接探针使用真实 fetch 请求本地 HTTP 服务，覆盖协议 URL、认证与最小载荷。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-connection-'));
const compile = createSharedCompiler(root, tmp);
const { testLlmConnection } = await import(pathToFileURL(compile('main/agent/openaiClient.ts')).href);
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: JSON.parse(body) });
    if (req.url === '/error/v1/messages') {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Invalid API key');
      return;
    }
    if (req.url === '/redirect/v1/chat/completions') {
      res.writeHead(307, { Location: '/unexpected/v1/chat/completions' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const trailing of ['', '///', '/v1', '/v1/']) {
    const result = await testLlmConnection({
      api: 'anthropic-messages',
      baseUrl: ` ${origin}/anthropic${trailing} `,
      apiKey: ' fixture-anthropic-key ',
      model: ' mimo-v2-pro '
    });
    assert.equal(result.ok, true);
    assert.equal(typeof result.durationMs, 'number');
    const request = requests.at(-1);
    assert.equal(request.url, '/anthropic/v1/messages', 'Anthropic 使用 SDK 对齐的 /v1/messages 路径');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['x-api-key'], 'fixture-anthropic-key');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['api-key'], undefined);
    assert.deepEqual(request.body, {
      model: 'mimo-v2-pro', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }]
    });
  }

  for (const api of [undefined, 'openai-completions', 'openai-responses']) {
    const result = await testLlmConnection({ baseUrl: `${origin}/v1/`, apiKey: 'fixture-openai-key', api });
    assert.equal(result.ok, true);
    const request = requests.at(-1);
    assert.equal(request.url, api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer fixture-openai-key');
    assert.equal(request.headers['api-key'], 'fixture-openai-key');
    assert.equal(request.headers['x-api-key'], undefined);
    assert.deepEqual(request.body, api === 'openai-responses'
      ? { model: 'gpt-4o', input: 'hi', max_output_tokens: 16 }
      : { model: 'default', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
  }

  const rejected = await testLlmConnection({
    api: 'anthropic-messages', baseUrl: `${origin}/error`, apiKey: 'bad-key', model: 'mimo-v2-pro'
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'HTTP 401: Invalid API key', '保留服务商真实错误');
  const redirected = await testLlmConnection({ baseUrl: `${origin}/redirect`, apiKey: 'fixture-redirect-key' });
  assert.equal(redirected.ok, false);
  assert.match(redirected.error ?? '', /^HTTP 307:/);
  assert.equal(requests.length, 9, '每次探活只发送一个请求，重定向不转发 Key');
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('ok   llm-connection (Anthropic/OpenAI paths, headers, payloads, HTTP errors)');
