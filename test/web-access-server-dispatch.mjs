/**
 * R1 回归（审计 2026-10-02）：WebAccessServer 消息入口的结构验证与局部失败收尾。
 * 真实加载 server.ts + ipc/handle.ts（Electron 为 stub），经 handleConnection 建立的
 * fake ws 逐条发畸形帧：null / 数组 / 数字 / 字符串 / 无效 JSON / 未知 t / 错误
 * id / 错误 channel / 错误 args——要求零 unhandledRejection、零错误形状回复、
 * 连接不僵死（随后合法帧仍可用）；未鉴权连接仍被 4001 拒绝。
 * 还原修复即红：去掉 parseClientFrame 结构验证或 message 回调 catch，对应用例失败。
 * Run: node test/web-access-server-dispatch.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename
    }).outputText,
    filename
  );

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'web-access-dispatch-'));
const closeOwnerCalls = [];
const fakeElectron = {
  app: { getPath: () => fixture, getAppPath: () => root, isReady: () => true },
  ipcMain: Object.assign(new EventEmitter(), { handle() {} })
};
fakeElectron.ipcMain.on('pty:input', (...args) => sentChannels.push(['pty:input', args]));
const overrides = new Map([
  ['electron', fakeElectron],
  [
    path.join(root, 'src/main/workspaceFsProtocol.ts'),
    { handleWorkspaceMediaRequest: async () => new Response('x'), handleExternalFileRequest: async () => new Response('x') }
  ],
  [path.join(root, 'src/main/workspacePreview.ts'), { workspacePreviewsFor: () => ({ serve: async () => new Response('x') }) }],
  [
    path.join(root, 'src/main/workspaceRootUses.ts'),
    { workspaceRootUsesFor: () => ({ closeOwner: (id) => closeOwnerCalls.push(id) }) }
  ]
]);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (overrides.has(request)) return overrides.get(request);
  if (request.startsWith('.') && parent?.filename) {
    const abs = path.resolve(path.dirname(parent.filename), request);
    for (const suffix of ['.ts', '/index.ts']) {
      const hit = overrides.get(abs + suffix);
      if (hit !== undefined) return hit;
    }
  }
  return originalLoad.apply(this, arguments);
};
const { WebAccessServer } = require(path.join(root, 'src/main/webAccess/server.ts'));
const { handle, ipcCaller } = require(path.join(root, 'src/main/ipc/handle.ts'));
Module._load = originalLoad;

// 全局 unhandledRejection 侦测：任何逃逸（还原修复的形态）立即失败退出，
// 不被顶层 await 的评估 rejection 静默吞掉（否则 exit 0 掩盖红）
const rejections = [];
process.on('unhandledRejection', (reason) => {
  rejections.push(String(reason));
  console.error('检测到逃逸 unhandledRejection:', reason);
  process.exit(1);
});

// 注册一个合法 invoke 通道（回复合同用）
handle('test:echo', (_event, value) => ({ echoed: value }));
let browserOpens = 0;
handle('browser:open', () => { browserOpens++; });

const sentChannels = [];

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closeCalls = [];
    this.readyState = 1;
    this.terminateCalls = 0;
    this.send = (text) => this.sent.push(text);
    this.close = (code, reason) => this.closeCalls.push({ code, reason });
    this.terminate = () => {
      this.terminateCalls++;
    };
  }
}

const srv = new WebAccessServer();
srv.ctx = { config: {} }; // releaseClientViews 需要 ctx（真实链路由 start 注入）
srv.printUrls = () => {};
srv.loadOrInitInfo();
const token = srv.getStatusInfo().token;
const ws = new FakeWs();
srv.handleConnection(ws, { url: `/ws?token=${token}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
const send = (raw) => ws.emit('message', raw);
const settle = () => new Promise((r) => setTimeout(r, 25));
let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ── 畸形帧全家桶：静默丢弃、无 rejection、不僵死 ──
{
  const before = ws.sent.length;
  send('null'); // 合法 JSON 但 null —— 审计 R1 的原始触发帧
  send('[1,2,3]'); // 数组
  send('42'); // 数字
  send('"hello"'); // 字符串
  send('true'); // 布尔
  send('not-json{'); // 无效 JSON
  send(JSON.stringify({ t: 'unknown-type' })); // 未知 t
  send(JSON.stringify({ t: 'invoke' })); // 缺 id
  send(JSON.stringify({ t: 'invoke', id: 'not-number', channel: 'test:echo' })); // id 非数字
  send(JSON.stringify({ t: 'invoke', id: 1.1, channel: 123 })); // channel 非字符串
  send(JSON.stringify({ t: 'invoke', id: 1.2, channel: 'test:echo', args: 'not-array' })); // args 非数组（归一为 []）
  send(JSON.stringify({ t: 'send', channel: 42 })); // send channel 非字符串
  await settle();
  // args 非数组的 invoke 归一 [] 后是合法帧 → 会有一条正常 result 回复；其余畸形帧零回复
  const results = ws.sent.slice(before).map((s) => JSON.parse(s));
  assert.equal(results.length, 1, `畸形帧中只有 args-归一帧得到一条回复，实际 ${results.length}`);
  assert.equal(results[0].t, 'result');
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[0].result, {}); // args 归一 [] → echo(undefined) → JSON 丢弃 undefined 字段
  assert.equal(rejections.length, 0, '零 unhandledRejection');
  ok('null/数组/标量/无效 JSON/未知 t/错误 id/channel 均被结构验证拦截（无 rejection、无错误形状帧）');
}
{
  // 连接未僵死：随后合法帧照常服务
  const before = ws.sent.length;
  send(JSON.stringify({ t: 'ping' }));
  await settle();
  assert.equal(JSON.parse(ws.sent[before]).t, 'pong');
  send(JSON.stringify({ t: 'invoke', id: 7, channel: 'test:echo', args: ['still-alive'] }));
  await settle();
  const reply = JSON.parse(ws.sent[ws.sent.length - 1]);
  assert.equal(reply.id, 7);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result, { echoed: 'still-alive' });
  ok('畸形帧后连接仍可用（ping→pong、invoke→result 合同不变）');
}
{
  // 业务错误仍按回复合同返回（不是静默）：未知通道
  send(JSON.stringify({ t: 'invoke', id: 8, channel: 'nope:nope', args: [] }));
  await settle();
  const reply = JSON.parse(ws.sent[ws.sent.length - 1]);
  assert.equal(reply.id, 8);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /无此通道/);
  ok('合法形状但业务失败（未知通道）仍走错误回复合同');
}
{
  // send 白名单：允许的通道被 emit、其余静默丢弃
  const before = sentChannels.length;
  send(JSON.stringify({ t: 'send', channel: 'pty:input', args: ['k'] }));
  send(JSON.stringify({ t: 'send', channel: 'evil:channel', args: ['x'] }));
  await settle();
  assert.equal(sentChannels.length - before, 1, '白名单 send 放行一条、非白名单丢弃');
  ok('send 白名单合同保持（pty:input 放行，未知通道静默丢弃）');
}
{
  // invoke 黑名单回归（reliability/web-access F-01）：原生对话框通道不许从 web 触发——
  // 否则文件/目录选择框模态弹在宿主机上，宿主无人时挂起到超时。
  // 本地 fixture 没注册这些 handler，还原修复（移出黑名单）时拒绝会变成「无此通道」，
  // 断言锚定错误文案差异即可分辨守卫是否在位。
  const deny = async (id, channel, args) => {
    send(JSON.stringify({ t: 'invoke', id, channel, args }));
    await settle();
    return JSON.parse(ws.sent.at(-1));
  };
  for (const channel of ['app:pickWallpaper', 'capabilityManagement:pickDirectory']) {
    const r = await deny(20, channel, []);
    assert.equal(r.ok, false, `${channel} 应被 web 黑名单拒绝`);
    assert.match(r.error, /不支持通道|无此通道/, `${channel} 拒绝文案为黑名单口径`);
  }
  const removed = await deny(21, 'workbench:managePackage', [{ action: 'install' }]);
  assert.match(removed.error, /无此通道/, 'retired package management is not registered');
  ok('原生选择对话框仍被拒绝，旧包管理通道已移除');
  const browser = await deny(22, 'browser:open', [{ url: 'https://example.test/' }]);
  assert.deepEqual(browser, { t: 'result', id: 22, ok: false,
    error: '内置浏览器仅在 Muster 桌面应用中可用。请在桌面应用中继续此操作。' });
  assert.equal(browserOpens, 0);
  ok('网页端的宿主浏览器调用被拒绝，并返回桌面操作指引');
}
{
  // 未鉴权连接：仍被 4001 拒绝，且不发任何帧
  const bad = new FakeWs();
  srv.handleConnection(bad, { url: '/ws?token=wrong-token-value', headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  assert.deepEqual(bad.closeCalls.map((c) => c.code), [4001]);
  assert.equal(bad.sent.length, 0);
  bad.emit('message', JSON.stringify({ t: 'invoke', id: 1, channel: 'test:echo', args: [] }));
  await settle();
  assert.equal(bad.sent.length, 0, '未鉴权连接的帧不受理');
  assert.equal(rejections.length, 0);
  ok('未鉴权连接：close 4001 且帧不受理（鉴权边界未被重构波及）');
}
{
  // hello/filter/ping/pong 控制帧合同（caps 过滤照常）
  send(JSON.stringify({ t: 'hello', caps: { terminal: false, stream: false } }));
  send(JSON.stringify({ t: 'filter', drop: ['agent:token'] }));
  send(JSON.stringify({ t: 'pong' }));
  await settle();
  assert.equal(rejections.length, 0);
  ok('hello/filter/pong 控制帧照常（兴趣过滤入口不受影响）');
}
{
  // close 后连接摘表：close 事件触发的资源清理路径（owner 释放幂等）
  ws.emit('close');
  send(JSON.stringify({ t: 'invoke', id: 9, channel: 'test:echo', args: [] }));
  await settle();
  assert.equal(rejections.length, 0, 'close 后的迟到帧不产生 rejection');
  ok('close 后迟到帧静默丢弃（资源释放与分派收尾一致）');
}
{
  // 分派器意外抛错（未来改动引入的 bug 形态）：message 回调的局部 catch 兜底——
  // 记日志、terminate 连接、摘出 clients 表并释放 owner（与 close 清理路径一致），
  // 不得变成全局 unhandledRejection 或留下僵尸连接
  const ws2 = new FakeWs();
  srv.handleConnection(ws2, { url: `/ws?token=${token}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  const ownerBefore = closeOwnerCalls.length;
  const realHandleInvoke = srv.handleInvoke.bind(srv);
  srv.handleInvoke = async () => {
    throw new Error('injected dispatch failure');
  };
  try {
    ws2.emit('message', JSON.stringify({ t: 'invoke', id: 99, channel: 'test:echo', args: [] }));
    await settle();
    assert.equal(rejections.length, 0, '意外异常被局部 catch 接住，零逃逸');
    assert.ok(ws2.terminateCalls >= 1, '连接被 terminate（不残留僵尸）');
    assert.ok(closeOwnerCalls.length > ownerBefore, 'owner 资源被释放');
    // 摘表验证：随后帧静默（不在 clients 表，不受理）
    const sentBefore = ws2.sent.length;
    ws2.emit('message', JSON.stringify({ t: 'ping' }));
    await settle();
    assert.equal(ws2.sent.length, sentBefore, '摘表后不再受理新帧');
  } finally {
    srv.handleInvoke = realHandleInvoke;
  }
  // 兄弟连接不受牵连：新连接正常服务
  const ws3 = new FakeWs();
  srv.handleConnection(ws3, { url: `/ws?token=${token}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  ws3.emit('message', JSON.stringify({ t: 'ping' }));
  await settle();
  assert.equal(JSON.parse(ws3.sent.at(-1)).t, 'pong', '其它连接不受单连接故障牵连');
  ok('分派器意外抛错：局部 catch + terminate + 摘表 + owner 释放，不影响其它连接');
}

// ── web-access F-02：未鉴权静态面收敛（仅 /assets/ 与既有白名单免 token）──
// 直接驱动 handleRequest：入口页之外的一切根级静态路径未授权一律 401，
// /assets/* 免鉴权放行到 serveStatic（本仓 out/renderer 缺产物时走 404/dev fallback，
// 关键断言是「不 401」）。还原修复（恢复 serveStatic 全放行）时 401 组断言转红。
{
  const request = (pathname, query = '') => {
    const res = {
      headersSent: false,
      statusCode: 0,
      chunks: [],
      writeHead(status) { this.statusCode = status; this.headersSent = true; return this; },
      end(body) { this.chunks.push(String(body ?? '')); },
      destroy() { this.destroyed = true; }
    };
    const req = {
      url: `${pathname}${query}`,
      method: 'GET',
      headers: {}
    };
    void srv.handleRequest(req, res);
    return res;
  };
  await settle();
  // 未授权：入口页与其余根级路径（未来 version.json 等产物）一律 401
  for (const p of ['/', '/index.html', '/version.json', '/config-snapshot.json']) {
    const res = request(p);
    await settle();
    assert.equal(res.statusCode, 401, `未授权访问 ${p} 必须 401`);
  }
  // /assets/* 免鉴权（内容 hash 无密）：不是 401（缺产物时 404）
  {
    const res = request('/assets/app-abc123.js');
    await settle();
    assert.notEqual(res.statusCode, 401, '/assets/* 未授权也放行（不是 401）');
  }
  // 带正确 token：入口页不再 401（缺产物时走 dev fallback 200）
  {
    const res = request('/', `?token=${token}`);
    await settle();
    assert.notEqual(res.statusCode, 401, '带 token 的入口页不 401');
  }
  {
    const { applyLocaleSetting } = require(path.join(root, 'src/shared/i18n/index.ts'));
    const promises = require('node:fs/promises'), realStat = promises.stat;
    promises.stat = (file, ...args) => path.resolve(String(file)) === path.join(root, 'src/main/renderer/index.html')
      ? Promise.reject(Object.assign(new Error('fixture: missing renderer'), { code: 'ENOENT' })) : realStat(file, ...args);
    try {
      applyLocaleSetting('en');
      const res = request('/index.html', `?token=${token}`);
      await settle();
      const html = res.chunks.join('');
      assert.equal(res.statusCode, 200);
      assert.match(html, /<html lang="en">/);
      assert.match(html, /Muster Console Web Access/);
      assert.match(html, /Production page/);
      assert.ok(html.includes(token), 'authenticated fallback retains the access token');
    } finally { promises.stat = realStat; applyLocaleSetting('zh-CN'); }
  }
  ok('静态鉴权面收敛：非 /assets/ 根级路径未授权一律 401（web-access F-02）');
}


// ── X4-F07：usage 通道改走统一 handle()（通道注册表可见 + 网关侧显式拒绝）──
{
  const { hasIpcChannel } = require(path.join(root, 'src/main/ipc/handle.ts'));
  const { registerUsageIpc } = require(path.join(root, 'src/main/ipc/usage.ts'));
  const fakeCtx = { usage: { getDays: () => ({}), getLlmCallsRange: () => ({ rows: [], total: 0 }), getToolFailures: () => [], getLlmByExtRange: () => [], getLlmCall: () => null } };
  registerUsageIpc(fakeCtx);
  assert.equal(hasIpcChannel('usage:summary'), true, 'usage:summary 进统一注册表（X4-F07）');
  assert.equal(hasIpcChannel('usage:llm-call'), true, 'usage:llm-call 进统一注册表（X4-F07）');
  // web 网关维持不放行：denylist 拒绝优先于注册表
  const ws4 = new FakeWs();
  srv.handleConnection(ws4, { url: `/ws?token=${token}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  ws4.emit('message', JSON.stringify({ t: 'invoke', id: 500, channel: 'usage:summary', args: [] }));
  await settle();
  const reply = JSON.parse(ws4.sent.at(-1));
  assert.equal(reply.ok, false, 'usage:summary 走 web 网关被拒（分级现状维持）');
  assert.match(reply.error, /不支持通道/, '拒绝文案来自 denylist');
  const { applyLocaleSetting } = require(path.join(root, 'src/shared/i18n/index.ts'));
  try {
    applyLocaleSetting('en');
    ws4.emit('message', JSON.stringify({ t: 'invoke', id: 501, channel: 'usage:summary', args: [] }));
    ws4.emit('message', JSON.stringify({ t: 'invoke', id: 502, channel: 'unknown:fixture', args: [] }));
    await settle();
    const replies = ws4.sent.map(text => JSON.parse(text));
    assert.equal(replies.find(item => item.id === 501)?.error, 'Web access does not support channel: usage:summary');
    assert.equal(replies.find(item => item.id === 502)?.error, '[ipc] Unknown channel: unknown:fixture');
  } finally { applyLocaleSetting('zh-CN'); }
  ok('usage 通道统一注册（桌面可用）+ web 网关维持不放行（X4-F07 + usage F-03 现状）');
}

{
  const gateway = new WebAccessServer();
  gateway.loadOrInitInfo();
  const client = new FakeWs(), peer = new FakeWs();
  for (const socket of [client, peer]) {
    gateway.handleConnection(socket, { url: `/ws?token=${gateway.getStatusInfo().token}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  }
  const closed = [];
  let finishClose, finishOpen, enteredOpen;
  const closing = new Promise(resolve => { finishClose = resolve; });
  const opening = new Promise(resolve => { enteredOpen = resolve; });
  gateway.ctx = { config: {}, extensionSystem: { extensionHost: { close: async token => {
    closed.push(token);
    if (token === 'first-view') await closing;
  } } } };
  let emit;
  handle('extensionSurface:open', (event, token) => {
    if (token === 'late-view') return new Promise(resolve => { finishOpen = () => resolve({ token }); enteredOpen(); });
    emit = ipcCaller(event).sendEvent;
    return { token };
  });
  const invoke = (id, token) => gateway.handleClientMessage(client, JSON.stringify({ t: 'invoke', id, channel: 'extensionSurface:open', args: [token] }));
  await invoke(1, 'first-view');
  const event = { token: 'first-view', topic: 'state.changed', value: {} };
  emit('extensionSurface:event', event);
  assert.deepEqual(JSON.parse(client.sent.at(-1)), { t: 'event', channel: 'extensionSurface:event', payload: event });
  assert.deepEqual(peer.sent, [], 'unrelated connections do not receive extension events');

  const late = invoke(2, 'late-view');
  await opening;
  const previousFrames = client.sent.length;
  client.emit('close');
  finishOpen();
  await late;
  assert.deepEqual(closed, ['first-view', 'late-view'], 'a late open result is closed after its caller disconnects');
  assert.equal(gateway.extensionViewOwners.size, 0, 'no revoked view can serve resources');
  emit('extensionSurface:event', event);
  assert.equal(client.sent.length, previousFrames, 'no event or late reply gets sent to a disconnected client');

  let stopped = false;
  const stopping = gateway.stop().then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false, 'shutdown waits for the disconnected panel to finish closing');
  finishClose();
  await stopping;
  ok('扩展事件仅投递到所属连接，断线撤销资源并回收在途打开的面板');
}

{
  let finish, entered = false;
  const shutdownWs = new FakeWs();
  srv.handleConnection(shutdownWs, { url: `/ws?token=${srv.getStatusInfo().token}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  srv.handleInvoke = async () => { entered = true; await new Promise(resolve => { finish = resolve; }); };
  shutdownWs.emit('message', JSON.stringify({ t: 'invoke', id: 600, channel: 'test:echo', args: [] }));
  await settle(); assert.equal(entered, true);
  let stopped = false;
  const stopping = srv.stop().then(() => { stopped = true; });
  await settle(); assert.equal(stopped, false, 'closing transport must await an accepted invoke');
  assert.ok(shutdownWs.terminateCalls > 0, 'shutdown revokes the client transport');
  finish(); await stopping;
  entered = false;
  shutdownWs.emit('message', JSON.stringify({ t: 'invoke', id: 601, channel: 'test:echo', args: [] }));
  await settle(); assert.equal(entered, false, 'no new invoke after admission stops');
  ok('shutdown waits accepted invokes independently of disconnected sockets');
  await assert.rejects(srv.start(srv.ctx), /stopping/, 'stopped web owner cannot listen again');
  const racing = new WebAccessServer();
  const previousPort = process.env.MUSTER_WEB_PORT;
  process.env.MUSTER_WEB_PORT = '0';
  try {
    const startup = racing.start({ config: {} });
    const shutdown = racing.stop();
    await Promise.all([startup, shutdown]);
    assert.equal(racing.httpServer, null, 'late listen is fully closed before stop completes');
    assert.equal(racing.wss, null);
    await assert.rejects(racing.start({ config: {} }), /stopping/);
  } finally {
    if (previousPort === undefined) delete process.env.MUSTER_WEB_PORT; else process.env.MUSTER_WEB_PORT = previousPort;
    await racing.stop();
  }
}
assert.equal(rejections.length, 0, '全程零 unhandledRejection');
console.log(`web-access-server-dispatch: ${passed} 组断言全绿`);
fs.rmSync(fixture, { recursive: true, force: true });

