/** Real HTTP/WS/MCP/worker processes; fake engines, no provider calls or credentials. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { resolveLaunch as openCodeLaunch } from '../src/main/runtime/builtins/scripts/opencode.mjs';
import { prepareCodexTui, readActiveCodexTurn } from '../src/main/runtime/builtins/scripts/_codex-native.mjs';
import { prepareClaudeChannel, claudeChannelSupport } from '../src/main/runtime/builtins/scripts/_claude-native.mjs';
import { cliOutput, pause } from '../src/main/runtime/builtins/scripts/_native.mjs';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-native-'));
const input = (intent = 'normal', messageId = 'mail-1') => ({ intent, messageId, text: '宿主收信提醒',
  sessionId: 'engine', hostSessionId: 'host', cwd: tmp, signal: new AbortController().signal, isCurrent: () => true });
const until = async (condition, label) => {
  for (let n = 0; n < 300; n++) { if (condition()) return; await pause(10); }
  throw new Error(`Timeout: ${label}`);
};

try {
  // A real child proves cmd.exe forwarding does not pass literal quotes on Windows.
  const script = path.join(tmp, 'args.cjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const argv = ['ws://127.0.0.1:1234', 'spaces here', '中文'];
  assert.deepEqual(JSON.parse(await cliOutput([process.execPath, script, ...argv], tmp)), argv);

  // OpenCode talks to the server belonging to this exact TUI launch.
  const launch = await openCodeLaunch({ sessionId: 'ses_native', extraArgs: [] });
  const wire = launch.command === 'cmd.exe' ? launch.args[3].split(' ') : launch.args;
  const port = Number(wire[wire.indexOf('--port') + 1]);
  const calls = [];
  let busy = false, abortIdle = true, abortResult = true;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(`opencode:${launch.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`);
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('directory'), tmp);
    let body = ''; for await (const chunk of req) body += chunk;
    const route = req.url.split('?')[0];
    calls.push({ route, method: req.method, body: body ? JSON.parse(body) : undefined });
    res.setHeader('content-type', 'application/json');
    if (route === '/doc') res.end(JSON.stringify({ paths: { '/session/{sessionID}/prompt_async': { post: {} } } }));
    else if (route === '/session/status') res.end(JSON.stringify(busy ? { ses_native: { type: 'busy' } } : {}));
    else if (route.endsWith('/abort')) { if (abortIdle) busy = false; res.end(JSON.stringify(abortResult)); }
    else { res.writeHead(204); res.end(); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    assert.deepEqual(await launch.receiveMessage(input()), { status: 'accepted', method: 'sent' });
    assert.equal(calls.at(-1).body.parts[0].text, input().text);
    busy = true;
    assert.equal((await launch.receiveMessage(input())).status, 'deferred');
    assert.equal(calls.at(-1).route, '/session/status', 'normal does not abort');
    assert.deepEqual(await launch.receiveMessage(input('interrupt')), { status: 'accepted', method: 'stopped-and-sent' });
    assert.deepEqual(calls.slice(-4).map(call => call.route), ['/session/status', '/session/ses_native/abort', '/session/status', '/session/ses_native/prompt_async']);
    busy = true; abortResult = false;
    assert.equal((await launch.receiveMessage(input('interrupt'))).status, 'deferred', 'retrying a stopped notice must not stop a new turn');
    await assert.rejects(launch.receiveMessage(input('interrupt', 'different-priority')), /abort 未确认/);
    const count = calls.length;
    assert.equal((await launch.receiveMessage({ ...input(), isCurrent: () => false })).status, 'deferred');
    assert.equal(calls.length, count);
    launch.dispose();
    assert.equal((await launch.receiveMessage(input())).status, 'deferred');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  const v2 = await openCodeLaunch({ sessionId: 'ses_v2', extraArgs: [] });
  const v2args = v2.command === 'cmd.exe' ? v2.args[3].split(' ') : v2.args;
  const v2calls = [];
  const v2server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const route = req.url.split('?')[0];
    v2calls.push(route); res.setHeader('content-type', 'application/json');
    if (route === '/doc') return res.end(JSON.stringify({ paths: { '/api/session/{sessionID}/prompt': { post: {
      requestBody: { content: { 'application/json': { schema: { properties: { delivery: { enum: ['queue', 'steer'] } } } } } },
    } } } }));
    assert.fail('an incompatible /api route must not receive a prompt');
  });
  await new Promise(resolve => v2server.listen(Number(v2args[v2args.indexOf('--port') + 1]), '127.0.0.1', resolve));
  try {
    assert.equal((await v2.receiveMessage(input())).status, 'unsupported');
    assert.equal((await v2.receiveMessage(input('interrupt'))).status, 'unsupported');
    assert.deepEqual(v2calls, ['/doc'], 'a new API alone cannot justify switching the existing TUI execution path');
    assert.equal(v2calls.filter(route => route === '/doc').length, 1, 'pin capability to the actual server process');
  } finally { v2.dispose(); v2server.closeAllConnections(); await new Promise(resolve => v2server.close(resolve)); }

  // Actual WebSocket framing, bearer auth, same thread, guarded turn identity, no UI input.
  const codexReports = [];
  const codexCollector = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => { codexReports.push(body ? JSON.parse(body) : null); res.writeHead(204); res.end(); });
  });
  await new Promise(resolve => codexCollector.listen(0, '127.0.0.1', resolve));
  const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wsServer, 'listening');
  let auth, ownerArgs, disposed = 0, active = false, mismatch = false, emitTurns = true, queueUnsupported = false, socketBroadcast;
  const rollout = path.join(tmp, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'rollout-turn' } }) + '\n');
  assert.equal(await readActiveCodexTurn(rollout), 'rollout-turn');
  fs.appendFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'task_started fake-id' } }) + '\n');
  assert.equal(await readActiveCodexTurn(rollout), 'rollout-turn', 'never parse lifecycle IDs out of model text');
  const rpcCalls = [];
  wsServer.on('connection', (socket, request) => {
    auth = request.headers.authorization;
    socket.on('message', data => {
      const msg = JSON.parse(String(data)); rpcCalls.push(msg);
      if (msg.id === undefined) return;
      let result = {};
      if (msg.method === 'thread/start' || msg.method === 'thread/resume') result = { thread: { id: 'thread-native' } };
      else if (msg.method === 'thread/loaded/list') result = { data: ['thread-native'] };
      else if (msg.method === 'thread/read') result = { thread: { id: msg.params.threadId, path: rollout, status: { type: active ? 'active' : 'idle' } } };
      else if (msg.method === 'turn/start') result = { turn: { id: 'turn-new' } };
      else if (msg.method === 'thread/queue/add') {
        if (queueUnsupported) return socket.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'method not found' } }));
        result = { queuedSubmission: { id: 'queued-native', clientUserMessageId: msg.params.clientUserMessageId } };
      }
      else if (msg.method === 'turn/steer') {
        if (mismatch) return socket.send(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'expected turn mismatch' } }));
        result = { turnId: msg.params.expectedTurnId };
      }
      if (msg.method === 'thread/read' && active && emitTurns)
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-native', turn: { id: 'turn-native' } } }));
      // An unrelated server request may share the client's numeric ID namespace.
      socket.send(JSON.stringify({ id: msg.id, method: 'item/commandExecution/requestApproval', params: {} }));
      socket.send(JSON.stringify({ id: msg.id, result }));
    });
  });
  const codex = await prepareCodexTui({ mode: 'start', sessionId: 'codex-pending-test', cwd: tmp, extraArgs: [], WebSocket,
    env: { MUSTER_NATIVE_FIXTURE: 'backend-env', MUSTER_STATUS_URL: `http://127.0.0.1:${codexCollector.address().port}/v1/s/token/status` } },
    () => { throw Error('unexpected fallback'); }, {
      probeCli: async () => '--remote-auth-token-env --ws-token-sha256 queue command', allocatePort: async () => wsServer.address().port,
      startOwner: (args, options) => { ownerArgs = args; assert.equal(options.env.MUSTER_NATIVE_FIXTURE, 'backend-env');
        return { child: { pid: 1234 }, assertAlive() {}, dispose() { disposed++; } }; },
    });
  try {
    assert.deepEqual(codex.deliveryCapabilities, { interject: true, snapshot: false });
    assert.equal(auth, `Bearer ${codex.env.MUSTER_CODEX_TOKEN}`);
    assert.equal(ownerArgs.at(-1), createHash('sha256').update(codex.env.MUSTER_CODEX_TOKEN).digest('hex'));
    assert.equal(codex.externalSessionId, undefined, 'the TUI creates its own thread');
    let bound;
    const stopBinding = codex.onSessionId(id => { bound = id; });
    assert.deepEqual(await codex.receiveMessage(input()), { status: 'accepted', method: 'queued' });
    assert.equal(bound, 'thread-native'); stopBinding();
    // 官方回合通知 → activity：本 thread 的 turn/started 报 active，其他 thread 不串扰
    socketBroadcast = (msg) => { for (const client of wsServer.clients) client.send(JSON.stringify(msg)); };
    socketBroadcast({ method: 'turn/started', params: { threadId: 'thread-native', turn: { id: 'turn-monitor' } } });
    socketBroadcast({ method: 'turn/started', params: { threadId: 'other-thread', turn: { id: 'turn-other' } } });
    await until(() => codexReports.some(r => r?.activity === 'active'), 'turn/started 应上报 active');
    assert.equal(codexReports.at(-1).event, 'codex-turn');
    socketBroadcast({ method: 'turn/completed', params: { threadId: 'other-thread', turn: { id: 'turn-other' } } });
    await pause(150);
    assert.ok(!codexReports.some(r => r?.activity === 'idle'), '其他 thread 的完成不得上报 idle');
    socketBroadcast({ method: 'turn/completed', params: { threadId: 'thread-native', turn: { id: 'turn-monitor' } } });
    await until(() => codexReports.some(r => r?.activity === 'idle'), 'turn/completed 应上报 idle');
    assert.equal(rpcCalls.some(call => call.method === 'thread/start'), false, 'do not manufacture an unmaterialized empty thread');
    active = true;
    assert.equal((await codex.receiveMessage({ ...input(), idleOnly: true })).status, 'deferred', 'host notices never enter the native queue while active');
    assert.deepEqual(await codex.receiveMessage(input()), { status: 'accepted', method: 'queued' });
    assert.deepEqual(await codex.receiveMessage(input('interrupt')), { status: 'accepted', method: 'steered' });
    assert.equal(rpcCalls.at(-1).params.expectedTurnId, 'turn-native');
    mismatch = true;
    assert.equal((await codex.receiveMessage(input('interrupt'))).status, 'deferred');
    mismatch = false; emitTurns = false;
    assert.equal((await codex.receiveMessage(input('interrupt'))).method, 'steered');
    assert.equal(rpcCalls.at(-1).params.expectedTurnId, 'rollout-turn', 'missed native turn-start events use only the bound rollout ID');
    fs.appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'rollout-turn' } }) + '\n');
    assert.equal(await readActiveCodexTurn(rollout), undefined);
    assert.equal((await codex.receiveMessage(input('interrupt'))).status, 'deferred', 'a completed rollout cannot invent the currently active ID');
    queueUnsupported = true; active = false;
    assert.deepEqual(await codex.receiveMessage(input()), { status: 'accepted', method: 'sent' });
    active = true;
    assert.equal((await codex.receiveMessage(input())).status, 'deferred', 'older servers never steer ordinary mail');
    const count = rpcCalls.length;
    assert.equal((await codex.receiveMessage({ ...input(), isCurrent: () => false })).status, 'deferred');
    assert.equal(rpcCalls.length, count);
    codex.dispose(); codex.dispose(); assert.equal(disposed, 1);
  } finally { for (const client of wsServer.clients) client.terminate(); await new Promise(resolve => wsServer.close(resolve)); codexCollector.closeAllConnections(); await new Promise(resolve => codexCollector.close(resolve)); }
  const oldCodex = await prepareCodexTui({ cwd: tmp, extraArgs: [] }, () => ({ command: 'old-codex', args: [] }), { probeCli: async () => 'old CLI' });
  assert.equal(oldCodex.deliveryCapabilities, undefined, 'legacy CLI has no native preemption declaration; ordinary input remains available');
  assert.equal((await oldCodex.receiveMessage(input())).status, 'unsupported');
  assert.match(oldCodex.warning, /升级 Codex/);
  let fallbackArgs;
  const safeFallback = await prepareCodexTui({ cwd: tmp, extraArgs: ['--model', 'fixture', '--', 'prompt'] },
    args => { fallbackArgs = args; return { command: 'legacy', args }; }, { probeCli: async () => '--no-daemon' });
  assert.deepEqual(fallbackArgs, ['--model', 'fixture', '--no-daemon', '--', 'prompt'], 'legacy CLI must not reuse an unrelated shared daemon');
  assert.equal(safeFallback.warning, undefined);
  assert.equal((await safeFallback.receiveMessage(input())).status, 'unsupported');
  await prepareCodexTui({ cwd: tmp, extraArgs: ['--no-daemon'] },
    args => { fallbackArgs = args; return { command: 'legacy', args }; }, { probeCli: async () => '--no-daemon' });
  assert.deepEqual(fallbackArgs, ['--no-daemon'], 'an explicit no-daemon option is not duplicated');
  let probes = 0;
  await prepareCodexTui({ cwd: tmp, extraArgs: [] }, args => { fallbackArgs = args; return { command: 'legacy', args }; },
    { probeCli: async () => ++probes === 1 ? '--remote-auth-token-env --no-daemon' : 'old server' });
  assert.deepEqual(fallbackArgs, ['--no-daemon'], 'an unsupported remote server also avoids the shared daemon');

  // Native TUI 不接受 --add-dir 与 --remote 同命令：额外 workspace roots 必须转为 app-server
  // 的 sandbox_workspace_write.writable_roots（回归：此前 --add-dir 拼进 TUI 命令行致 codex 拒启）。
  const extraRoot = 'E:\\work dir\\额外';
  let rootsOwnerArgs;
  const rooted = await prepareCodexTui({ mode: 'start', sessionId: 'codex-pending-roots', cwd: tmp,
    extraArgs: ['--add-dir', extraRoot, '--model', 'gpt-5'], WebSocket: class {}, env: {} },
    () => { throw Error('unexpected fallback'); }, {
      probeCli: async () => '--remote-auth-token-env --ws-token-sha256 queue', allocatePort: async () => 59999,
      startOwner: (args) => { rootsOwnerArgs = args; return { child: { pid: 99 }, assertAlive() {}, dispose() {} }; },
      openRpc: async () => ({ onNotification() {}, async request() { return {}; }, notify() {}, dispose() {} }),
    });
  try {
    assert.ok(rootsOwnerArgs.includes('-c'), 'app-server must receive the roots via -c config override');
    assert.ok(rootsOwnerArgs.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(extraRoot)}]`),
      `writable_roots must carry the host workspace root verbatim, got: ${rootsOwnerArgs.join(' ')}`);
    const rootsWire = rooted.command === 'cmd.exe' ? rooted.args[3].split(' ') : rooted.args;
    assert.ok(!rootsWire.includes('--add-dir'), 'TUI command line must not carry --add-dir beside --remote');
    assert.equal(rootsWire[rootsWire.indexOf('--model') + 1], 'gpt-5', 'unrelated extraArgs still reach the TUI');
  } finally { rooted.dispose(); }
  const bareRoots = await prepareCodexTui({ mode: 'start', sessionId: 'codex-pending-bare', cwd: tmp,
    extraArgs: [], WebSocket: class {}, env: {} }, () => { throw Error('unexpected fallback'); }, {
      probeCli: async () => '--remote-auth-token-env --ws-token-sha256 queue', allocatePort: async () => 59999,
      startOwner: (args) => { rootsOwnerArgs = args; return { child: { pid: 99 }, assertAlive() {}, dispose() {} }; },
      openRpc: async () => ({ onNotification() {}, async request() { return {}; }, notify() {}, dispose() {} }),
    });
  try { assert.ok(!rootsOwnerArgs.includes('-c'), 'no roots declared means no config override'); } finally { bareRoots.dispose(); }

  // Claude capability failures differ from known unsupported; preserve the vendor gates.
  assert.equal(await claudeChannelSupport(tmp, async () => { throw Error('Input must be provided'); }, {}), null);
  assert.match(await claudeChannelSupport(tmp, async () => { throw Error("unknown option '--dangerously-load-development-channels'"); }, {}), /不支持/);
  assert.match(await claudeChannelSupport(tmp, async () => { throw Error('must not probe'); }, { CLAUDE_CODE_USE_VERTEX: '1' }), /Vertex/);
  await assert.rejects(claudeChannelSupport(tmp, async () => { throw Error('permission denied'); }, {}), /permission denied/);
  const channel = await prepareClaudeChannel(args => ({ command: 'claude', args }));
  const configPath = channel.args[channel.args.indexOf('--mcp-config') + 1];
  const spec = JSON.parse(fs.readFileSync(configPath)).mcpServers['muster-mailbox'];
  assert.ok(channel.args.includes('--dangerously-load-development-channels'));
  assert.ok(!channel.args.includes('--dangerously-skip-permissions'));
  assert.equal((await channel.receiveMessage(input())).status, 'deferred', 'no MCP init is not ready');
  const denied = await fetch(spec.env.MUSTER_CHANNEL_URL + '/next'); assert.equal(denied.status, 403);
  const sidecar = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  createInterface({ input: sidecar.stdout }).on('line', line => lines.push(JSON.parse(line)));
  sidecar.stderr.on('data', () => {});
  try {
    sidecar.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    await until(() => lines.some(line => line.id === 1), 'MCP initialize');
    assert.deepEqual(lines[0].result.capabilities.experimental, { 'claude/channel': {} });
    sidecar.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    let receipt;
    for (let n = 0; n < 100; n++) {
      receipt = await channel.receiveMessage(input());
      if (receipt.status !== 'deferred') break;
      await pause(10);
    }
    assert.deepEqual(receipt, { status: 'accepted', method: 'written' }, 'stdio write is not a processing ACK');
    assert.equal(lines.filter(line => line.method === 'notifications/claude/channel').length, 1);
    assert.equal((await channel.receiveMessage(input('interrupt', 'priority'))).status, 'unsupported', 'a channel queue cannot impersonate a native interrupt');
    assert.deepEqual(await channel.receiveMessage(input('normal', 'mail-2')), { status: 'accepted', method: 'written' });
    assert.equal(lines.filter(line => line.method === 'notifications/claude/channel').length, 2);
    assert.equal(lines.at(-1).params.meta.message_id, 'mail-2');
  } finally {
    const exited = sidecar.exitCode === null && sidecar.signalCode === null ? once(sidecar, 'exit') : Promise.resolve();
    sidecar.stdin.end(); sidecar.kill(); channel.dispose(); channel.dispose(); await exited;
  }
  assert.equal(fs.existsSync(configPath), false);

  console.log('ok: builtin native HTTP/WS/MCP, identity/auth/unknown ACK/cleanup/compatibility');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
