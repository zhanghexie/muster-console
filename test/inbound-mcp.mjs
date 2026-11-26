/**
 * T5.4：入站 MCP 协议 / 身份 / 引擎配置合并 / HTTP 分发。
 * 运行: node test/inbound-mcp.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-mcp-'));
const compile = createSharedCompiler(root, tmp);

const {
  toInboundMcpToolName,
  fromInboundMcpToolName,
  inboundMcpFingerprint,
  upsertInboundMcpServerJson,
  identityFromEnv,
  resolveIdentityByPidWalk,
  handleInboundMcpMessage,
  dispatchInboundMcpTool,
  listInboundMcpToolsFromCatalog,
  parseHostToolsCatalogJson,
  INBOUND_MCP_PROTOCOL_VERSION,
  WORKER_INBOUND_MCP_SERVER
} = await import(pathToFileURL(compile('shared/inboundMcp.ts')).href);

assert.equal(toInboundMcpToolName('host.sessions.setStatus'), 'host_sessions_setStatus');
assert.equal(fromInboundMcpToolName('host_sessions_setStatus'), 'host.sessions.setStatus');
assert.equal(WORKER_INBOUND_MCP_SERVER, 'muster');

const fp1 = inboundMcpFingerprint({ command: '/app/muster.exe', args: ['/x/stdioEntry.mjs'] });
const fp2 = inboundMcpFingerprint({ command: '/app/muster.exe', args: ['/y/stdioEntry.mjs'] });
assert.notEqual(fp1, fp2, '脚本路径变化指纹必须变（TOFU 失效）');

const merged = upsertInboundMcpServerJson(
  { theme: 'dark', mcpServers: { other: { command: 'npx', args: ['foo'] } } },
  { command: 'node', args: ['server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
);
assert.equal(merged.theme, 'dark');
assert.deepEqual(merged.mcpServers.other, { command: 'npx', args: ['foo'] });
assert.equal(merged.mcpServers.muster.command, 'node');
assert.deepEqual(merged.mcpServers.muster.args, ['server.mjs']);

// B3: the merge adds/removes nothing but the muster key. Third-party entries
// stay byte-identical (never rewritten, never masked with enabled/disabled),
// the self entry is replaced wholesale, and the input object is not mutated.
const thirdPartyFull = {
  command: 'docker',
  args: ['run', '-i', '--rm', 'mcp/git'],
  env: { TOKEN: 'x' },
  cwd: '/repo'
};
const mergeInput = {
  theme: 'dark',
  mcpServers: { git: thirdPartyFull, muster: { command: 'stale', args: ['old.mjs'], cwd: '/gone' } }
};
const inputSnapshot = structuredClone(mergeInput);
const merged2 = upsertInboundMcpServerJson(mergeInput, { command: 'node', args: ['server.mjs'] });
assert.deepEqual(
  Object.keys(merged2.mcpServers).sort(),
  ['git', 'muster'],
  'merge must add/remove no mcpServers key besides muster'
);
assert.deepEqual(merged2.mcpServers.git, thirdPartyFull, 'third-party entry must stay untouched');
assert.deepEqual(
  merged2.mcpServers.muster,
  { command: 'node', args: ['server.mjs'] },
  'self entry replaced wholesale, no masking keys injected'
);
assert.deepEqual(Object.keys(merged2).sort(), ['mcpServers', 'theme']);
assert.deepEqual(mergeInput, inputSnapshot, 'merge must not mutate its input');
const fresh = upsertInboundMcpServerJson({ firstRun: true }, { command: 'node', args: ['s.mjs'] });
assert.deepEqual(Object.keys(fresh.mcpServers), ['muster'], 'config without mcpServers gains only the self entry');

// TOFU fingerprint scope (B3): v1 covers exactly the self entry launch identity
// (command/args). Target files are fixed constants and env is derived from the
// binary, so stored trusts stay valid while the launch is unchanged; any future
// widening of the fingerprint inputs must bump the v1 prefix to force re-confirm.
assert.equal(
  inboundMcpFingerprint({ command: 'a', args: ['b'] }),
  `v1:a\nb`
);
assert.equal(
  inboundMcpFingerprint({ command: 'a', args: ['b'], env: { ELECTRON_RUN_AS_NODE: '1' } }),
  inboundMcpFingerprint({ command: 'a', args: ['b'] }),
  'fingerprint v1 covers command/args only'
);

const idEnv = identityFromEnv({
  MUSTER_SESSION_TOKEN: 'tok',
  MUSTER_STATUS_URL: 'http://127.0.0.1/s',
  MUSTER_TOOL_URL: 'http://127.0.0.1/t'
});
assert.equal(idEnv.token, 'tok');
assert.equal(idEnv.invokeStyle, undefined);
assert.equal(identityFromEnv({}), null);

const idInvoke = identityFromEnv({
  MUSTER_HOST_TOOLS_TOKEN: 'ht',
  MUSTER_HOST_TOOLS_URL: 'http://127.0.0.1/invoke'
});
assert.equal(idInvoke.invokeStyle, true);
assert.equal(idInvoke.token, 'ht');

const map = new Map([
  [100, { token: 'from-pid', statusUrl: 'http://s', toolUrl: 'http://t', sessionId: 'sid', ptyPid: 100 }]
]);
const walked = resolveIdentityByPidWalk(
  300,
  200,
  (pid) => map.get(pid) ?? null,
  (pid) => (pid === 200 ? 100 : pid === 300 ? 200 : null)
);
assert.equal(walked.token, 'from-pid');

const tools = listInboundMcpToolsFromCatalog(['host.sessions.setStatus', 'host.ui.notify'], (name) => ({
  description: `${name} desc`,
  parameters: { type: 'object', properties: {} }
}));
assert.equal(tools[0].name, 'host_sessions_setStatus');

const init = await handleInboundMcpMessage(
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  { tools, callTool: async () => ({ content: [] }) }
);
assert.equal(init.result.protocolVersion, INBOUND_MCP_PROTOCOL_VERSION);
assert.equal(init.result.serverInfo.name, 'muster');

const listed = await handleInboundMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
  tools,
  callTool: async () => ({ content: [] })
});
assert.ok(listed.result.tools.some((t) => t.name === 'host_sessions_setStatus'));

let statusHits = 0;
let toolHits = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (req.url === '/status') {
      statusHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, phase: body.phase }));
      return;
    }
    if (req.url === '/tool') {
      toolHits += 1;
      assert.equal(body.name, 'host.ui.notify');
      assert.equal(body.resultView, 'model', 'stdio requests the model result before the host serialization budget');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/invoke') {
      assert.equal(body.token, 'gw');
      assert.equal(body.name, 'host_sessions_setStatus');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ isError: false, text: 'invoked' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const identity = {
  token: 'tok',
  statusUrl: `http://127.0.0.1:${port}/status`,
  toolUrl: `http://127.0.0.1:${port}/tool`
};
const httpPost = {
  async postJson(url, body, headers) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }
};
const allow = ['host.sessions.setStatus', 'host.ui.notify'];
const st = await dispatchInboundMcpTool(
  'host_sessions_setStatus',
  { phase: 'needs_you', note: '等验收' },
  identity,
  httpPost,
  allow
);
assert.equal(st.isError, undefined);
assert.equal(statusHits, 1);
const nt = await dispatchInboundMcpTool('host_ui_notify', { text: 'hi' }, identity, httpPost, allow);
assert.equal(toolHits, 1);
assert.match(nt.content[0].text, /ok/);

const denied = await dispatchInboundMcpTool('host_sessions_create', {}, identity, httpPost, allow);
assert.equal(denied.isError, true);
const oldAlias = await dispatchInboundMcpTool('sessions_setStatus', {}, identity, httpPost, allow);
assert.equal(oldAlias.isError, true, 'old public names do not remain callable aliases');

const cat = parseHostToolsCatalogJson({
  tools: [{ name: 'host_sessions_setStatus', description: 'd', inputSchema: { type: 'object', properties: {} } }]
});
assert.equal(cat[0].name, 'host_sessions_setStatus');
const invoked = await dispatchInboundMcpTool(
  'host_sessions_setStatus',
  { phase: 'done' },
  {
    token: 'gw',
    statusUrl: `http://127.0.0.1:${port}/invoke`,
    toolUrl: `http://127.0.0.1:${port}/invoke`,
    invokeStyle: true
  },
  httpPost,
  []
);
assert.equal(invoked.isError, false);
assert.equal(invoked.content[0].text, 'invoked');

const called = await handleInboundMcpMessage(
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'host_sessions_setStatus', arguments: { phase: 'done' } } },
  {
    tools,
    callTool: async (name, args) =>
      dispatchInboundMcpTool(name, args, identity, httpPost, allow)
  }
);
assert.equal(statusHits, 2);
assert.ok(called.result.content);

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('inbound-mcp: ok');
