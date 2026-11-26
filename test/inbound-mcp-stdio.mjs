/**
 * T5.4：stdio 帧握手 + tools/call（真子进程，Content-Length）。
 * 运行: node test/inbound-mcp-stdio.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-mcp-stdio-'));
const compile = createSharedCompiler(root, tmp);

const stdioMod = compile('shared/inboundMcpStdio.ts');
const protoMod = compile('shared/inboundMcp.ts');
const { createMcpStdioFramer, encodeMcpStdioFrame } = await import(pathToFileURL(stdioMod).href);
const decoded = [];
const framer = createMcpStdioFramer((msg, format) => decoded.push({ msg, format }));
const legacy = encodeMcpStdioFrame({ id: 91 }, 'content-length');
const boundary = legacy.indexOf('\r\n') + 2;
framer.push(legacy.subarray(0, boundary));
assert.equal(decoded.length, 0);
framer.push(legacy.subarray(boundary));
framer.push(encodeMcpStdioFrame({ id: 92 }));
assert.deepEqual(decoded, [{ msg: { id: 91 }, format: 'content-length' }, { msg: { id: 92 }, format: 'ndjson' }]);

const runner = path.join(tmp, 'runner.mjs');
fs.writeFileSync(
  runner,
  `
import { createMcpStdioFramer, encodeMcpStdioFrame } from ${JSON.stringify(pathToFileURL(stdioMod).href)};
import { handleInboundMcpMessage } from ${JSON.stringify(pathToFileURL(protoMod).href)};

const tools = [
  { name: 'sessions_setStatus', description: 'status', inputSchema: { type: 'object', properties: { phase: { type: 'string' } } } }
];
async function callTool(name, args) {
  const url = process.env.MOCK_STATUS_URL;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.MUSTER_SESSION_TOKEN },
    body: JSON.stringify(args)
  });
  return { content: [{ type: 'text', text: await res.text() }] };
}
const framer = createMcpStdioFramer((msg, format) => {
  void handleInboundMcpMessage(msg, { tools, callTool }).then((reply) => {
    if (reply) process.stdout.write(encodeMcpStdioFrame(reply, format));
  });
});
process.stdin.on('data', (c) => framer.push(c));
process.stdin.resume();
`
);

let hits = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, got: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const child = spawn(process.execPath, [runner], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    MUSTER_SESSION_TOKEN: 'tok',
    MOCK_STATUS_URL: `http://127.0.0.1:${port}/status`
  }
});
let errBuf = '';
child.stderr.on('data', (b) => {
  errBuf += b.toString();
});

function send(obj) {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function readOne() {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, idx).toString('utf8'));
      if (!m) return;
      const len = Number(m[1]);
      const start = idx + 4;
      if (buf.length < start + len) return;
      child.stdout.off('data', onData);
      resolve(JSON.parse(buf.subarray(start, start + len).toString('utf8')));
    };
    child.stdout.on('data', onData);
    setTimeout(() => reject(new Error(`stdio 握手超时${errBuf ? `: ${errBuf}` : ''}`)), 8000);
  });
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
const init = await readOne();
assert.equal(init.result.serverInfo.name, 'muster');

send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const listed = await readOne();
assert.ok(listed.result.tools.some((t) => t.name === 'sessions_setStatus'));

send({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'sessions_setStatus', arguments: { phase: 'needs_you' } }
});
const call = await readOne();
assert.match(call.result.content[0].text, /"ok":true/);
assert.equal(hits, 1);

child.kill();
// Use the actual SDK transport, so a custom parser cannot mask framing errors.
const transport = new StdioClientTransport({ command: process.execPath, args: [runner], env: {
  ...process.env, MUSTER_SESSION_TOKEN: 'tok', MOCK_STATUS_URL: `http://127.0.0.1:${port}/status`
} });
const sdk = new Client({ name: 'stdio-regression', version: '1' });
try {
  await sdk.connect(transport);
  assert.ok((await sdk.listTools()).tools.some(t => t.name === 'sessions_setStatus'));
  const result = await sdk.callTool({ name: 'sessions_setStatus', arguments: { phase: 'done' } });
  assert.match(result.content[0].text, /"ok":true/);
  assert.equal(hits, 2);
} finally { await sdk.close(); }
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('inbound-mcp-stdio: ok');
