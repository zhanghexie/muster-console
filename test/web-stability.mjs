/**
 * 网关协议集成（最小 WS 服务端 + 客户端，复用 shared/wsProtocol 契约）：
 *   ping/pong、hello caps 过滤、可靠 send 断线重发。
 * 不依赖 Electron（真网关 e2e 仍是 test/web-access.mjs）。
 * 并行安全：listen(0) 取随机端口。
 * Run: node test/web-stability.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-stability-'));
const compile = createSharedCompiler(root, tmp);
const {
  encodeHello,
  encodePing,
  encodeFilter,
  parseClientControl,
  capsDropList,
  mergeDropList,
  shouldDropChannel,
  isReliableSend,
  outboxEnqueue,
  outboxOnDisconnect,
  outboxFlush,
  encodePong
} = await import(pathToFileURL(compile('shared/wsProtocol.ts')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const ok = (cond, label) => {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
};

/**
 * 最小网关：与 WebAccessServer.handleClientMessage / broadcastEvent 同一套
 * parseClientControl + shouldDropChannel 契约（server.ts 调用点若丢掉过滤，
 * 本文件仍守纯函数；server 调用点由 web-access.mjs / code review 覆盖）。
 */
function attachHub(wss) {
  const clients = new Map();
  wss.on('connection', (ws) => {
    const meta = { drop: null, capsDrop: [] };
    clients.set(ws, meta);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const ctrl = parseClientControl(msg);
      if (ctrl?.kind === 'ping') {
        ws.send(encodePong());
        return;
      }
      if (ctrl?.kind === 'hello') {
        meta.capsDrop = capsDropList(ctrl.caps);
        meta.drop = mergeDropList(meta.capsDrop, null);
        return;
      }
      if (ctrl?.kind === 'filter') {
        meta.drop = mergeDropList(meta.capsDrop, ctrl.drop);
        return;
      }
      if (msg.t === 'send' && typeof msg.channel === 'string') {
        hub.received.push({ channel: msg.channel, args: msg.args });
      }
    });
  });
  const hub = {
    received: [],
    broadcastEvent(channel, payload) {
      const frame = JSON.stringify({ t: 'event', channel, payload });
      for (const [ws, meta] of clients) {
        if (shouldDropChannel(meta.drop, channel)) continue;
        try {
          ws.send(frame);
        } catch {
          /* drop */
        }
      }
    }
  };
  return hub;
}

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const client = {
      ws,
      frames: [],
      lastRxAt: 0,
      outbox: [],
      send(channel, args) {
        const reliable = isReliableSend(channel);
        const text = JSON.stringify({ t: 'send', channel, args });
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(text);
            return;
          } catch {
            /* fallthrough */
          }
        }
        this.outbox = outboxEnqueue(this.outbox, { text, reliable, channel });
      },
      flush() {
        const { remaining, giveUp } = outboxFlush(this.outbox, (text) => ws.send(text));
        this.outbox = remaining;
        return giveUp;
      }
    };
    ws.on('open', () => {
      client.lastRxAt = Date.now();
      resolve(client);
    });
    ws.on('error', reject);
    ws.on('message', (raw) => {
      client.lastRxAt = Date.now();
      const msg = JSON.parse(String(raw));
      client.frames.push(msg);
    });
    ws.on('close', () => {
      client.outbox = outboxOnDisconnect(client.outbox);
    });
  });
}

async function waitUntil(fn, label, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`timeout: ${label}`);
}

const server = http.createServer();
const wss = new WebSocketServer({ server });
const hub = attachHub(wss);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `ws://127.0.0.1:${port}`;

try {
  /* ── 1. ping → pong ── */
  const c1 = await connectClient(url);
  c1.ws.send(encodePing());
  await waitUntil(() => c1.frames.some((f) => f.t === 'pong'), 'pong');
  ok(true, '应用层 ping/pong');
  ok(Date.now() - c1.lastRxAt < 500, '收到帧刷新 lastRxAt（半开检测前提）');

  /* ── 2. 未声明 caps → 全量广播（向后兼容） ── */
  hub.broadcastEvent('pty:data', { data: 'legacy' });
  hub.broadcastEvent('agent:token', { tok: 1 });
  await waitUntil(
    () =>
      c1.frames.some((f) => f.t === 'event' && f.channel === 'pty:data') &&
      c1.frames.some((f) => f.t === 'event' && f.channel === 'agent:token'),
    'legacy 全量'
  );
  ok(true, '未声明 caps 的客户端收全量事件');

  /* ── 3. hello caps 过滤（手机：无 pty:data / agent:token） ── */
  const c2 = await connectClient(url);
  c2.ws.send(encodeHello({ terminal: false, stream: false }));
  await sleep(50);
  hub.broadcastEvent('pty:data', { data: 'flood' });
  hub.broadcastEvent('agent:token', { tok: 2 });
  hub.broadcastEvent('agent:thinking', { th: 1 });
  hub.broadcastEvent('agent:message', { id: 'm1' });
  hub.broadcastEvent('agent:history', { list: [] });
  await waitUntil(() => c2.frames.some((f) => f.channel === 'agent:message'), 'message 仍达');
  await sleep(100);
  ok(!c2.frames.some((f) => f.channel === 'pty:data'), 'terminal:false 丢 pty:data');
  ok(!c2.frames.some((f) => f.channel === 'agent:token'), 'stream:false 丢 agent:token');
  ok(!c2.frames.some((f) => f.channel === 'agent:thinking'), 'stream:false 丢 agent:thinking');
  ok(c2.frames.some((f) => f.channel === 'agent:message'), '保留 agent:message');
  ok(c2.frames.some((f) => f.channel === 'agent:history'), '保留 agent:history');
  // 同一时刻 c1 仍收全量
  await waitUntil(() => c1.frames.some((f) => f.channel === 'pty:data' && f.payload?.data === 'flood'), 'c1 全量');
  ok(true, 'caps 过滤不影响未声明客户端');

  /* ── 4. filter 显式覆盖 ── */
  const c3 = await connectClient(url);
  c3.ws.send(encodeFilter(['sessions:changed']));
  await sleep(50);
  hub.broadcastEvent('sessions:changed', { sessions: [] });
  hub.broadcastEvent('fs:changed', {});
  await waitUntil(() => c3.frames.some((f) => f.channel === 'fs:changed'), 'fs 仍达');
  ok(!c3.frames.some((f) => f.channel === 'sessions:changed'), 'filter drop 命中丢弃');

  /* ── 5. 可靠 send 断线重发（审批回执不丢） ── */
  const c4 = await connectClient(url);
  // 先在线发一条，确认可达
  c4.send('ui:confirm:r-online', [{ confirmed: true }]);
  await waitUntil(() => hub.received.some((r) => r.channel === 'ui:confirm:r-online'), '在线可靠 send');
  ok(true, '可靠 send 在线送达');

  // 模拟半开：本地 send 进 outbox（非 OPEN）
  c4.ws.close();
  await waitUntil(() => c4.ws.readyState === WebSocket.CLOSED, 'closed');
  c4.send('ui:confirm:r1', [{ confirmed: true }]);
  c4.send('pty:input', ['s', 'x']);
  ok(c4.outbox.length === 2, '非 OPEN 时两类 send 都入 outbox 尽量送达');
  // 断线语义：可靠保留、不可靠丢
  c4.outbox = outboxOnDisconnect(c4.outbox);
  ok(c4.outbox.length === 1 && c4.outbox[0].channel === 'ui:confirm:r1', 'onclose 只留可靠回执');
  ok(isReliableSend('ui:confirm:r1') && !isReliableSend('pty:input'), '可靠性分类与 outbox 语义一致');

  // 重连 flush 重发
  const c4b = await connectClient(url);
  c4b.outbox = c4.outbox;
  const giveUp = c4b.flush();
  ok(giveUp.length === 0 && c4b.outbox.length === 0, '重连后可靠 outbox 冲刷清空');
  await waitUntil(() => hub.received.some((r) => r.channel === 'ui:confirm:r1'), '可靠回执重发到达');
  ok(true, '可靠 send 重连后至少一次重发');

  /* ── 6. flush 中途失败保留剩余 ── */
  const items = [
    { text: JSON.stringify({ t: 'send', channel: 'ui:confirm:a', args: [] }), reliable: true, channel: 'ui:confirm:a', attempts: 0 },
    { text: JSON.stringify({ t: 'send', channel: 'ui:confirm:b', args: [] }), reliable: true, channel: 'ui:confirm:b', attempts: 0 }
  ];
  const { remaining, giveUp: g2 } = outboxFlush(items, (text) => {
    if (text.includes('ui:confirm:b')) throw new Error('mid fail');
  });
  ok(remaining.length === 1 && remaining[0].channel === 'ui:confirm:b', '中途失败剩余保留（不整段丢）');
  ok(g2.length === 0, '单次失败不放弃');

  c1.ws.close();
  c2.ws.close();
  c3.ws.close();
  c4b.ws.close();
} finally {
  wss.close();
  server.close();
}

console.log(`web-stability: ${passed} 项断言全部通过`);
