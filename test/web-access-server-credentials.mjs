/**
 * R2 回归（审计 2026-10-02）：WebAccessServer 凭证变更的持久化合同与连接撤销。
 * 真实加载 src/main/webAccess/server.ts，仅 stub Electron / workspace 依赖边界。
 * 合同：轮换以原子落盘成功为判据；失败保留旧凭证并显式报错；成功轮换立即吊销
 * 旧连接（close 握手在途也不可再发帧）；重启后不得恢复已宣称撤销的旧凭证。
 * 还原修复即红：去掉「先 persist 后发布」或撤销摘表，对应用例失败。
 * Run: node test/web-access-server-credentials.mjs
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

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'web-access-srv-'));
const closeOwnerCalls = [];
const fakeElectron = {
  app: { getPath: () => fixture, getAppPath: () => root, isReady: () => true },
  ipcMain: Object.assign(new EventEmitter(), { handle() {} })
};
const overrides = new Map(
  [
    ['electron', fakeElectron],
    // 凭证链路用不到的重依赖（会拉真 Electron IPC 面）以边界 stub 隔离
    [
      path.join(root, 'src/main/workspaceFsProtocol.ts'),
      { handleWorkspaceMediaRequest: async () => new Response('x'), handleExternalFileRequest: async () => new Response('x') }
    ],
    [path.join(root, 'src/main/workspacePreview.ts'), { workspacePreviewsFor: () => ({ serve: async () => new Response('x') }) }],
    [
      path.join(root, 'src/main/workspaceRootUses.ts'),
      { workspaceRootUsesFor: () => ({ closeOwner: (id) => closeOwnerCalls.push(id) }) }
    ]
  ].map(([k, v]) => [k, v])
);
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
Module._load = originalLoad;

const credFile = path.join(fixture, 'web-access.json');
const diskToken = () => JSON.parse(fs.readFileSync(credFile, 'utf8')).token;
let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const newServer = () => {
  const s = new WebAccessServer();
  s.printUrls = () => {}; // 真实实现会 console.log 全部 URL，测试降噪（不影响被测逻辑）
  return s;
};
/** 注入写盘失败：拦 renameSync 覆盖凭证文件这一步（原子写的最后一步） */
const withRenameFailure = (fn) => {
  const real = fs.renameSync;
  fs.renameSync = function (from, to, ...args) {
    if (String(to) === credFile) throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' });
    return real.call(this, from, to, ...args);
  };
  try {
    return fn();
  } finally {
    fs.renameSync = real;
  }
};
/** 最小 fake WebSocket：只实现 server 用到的面 */
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closeCalls = [];
    this.send = (text) => this.sent.push(text);
    this.close = (code, reason) => this.closeCalls.push({ code, reason });
  }
}
const connect = (srv, token) => {
  const ws = new FakeWs();
  srv.handleConnection(ws, { url: `/ws?token=${token}`, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  return ws;
};

// The gateway must never use a remote request to launch a host desktop file.
{
  const srv = newServer();
  const ws = new FakeWs();
  await srv.handleInvoke(ws, 41, 'shell:openPath', ['/tmp/report.pdf']);
  const reply = JSON.parse(ws.sent.at(-1));
  assert.equal(reply.ok, false);
  assert.match(reply.error, /网页访问不支持通道: shell:openPath/);
  ok('远程调用不能启动宿主机默认应用');
}

// ── 启动载入：三态与停服策略 ──
{
  const srv = newServer();
  srv.loadOrInitInfo();
  assert.ok(diskToken().length >= 16, '首次启动生成并落盘 token');
  const again = newServer();
  again.loadOrInitInfo();
  assert.equal(again.getStatusInfo().token, diskToken(), '重启复用同一 token');
  ok('首次启动：生成凭证并落盘；重启复用（网址不变）');
}
{
  fs.writeFileSync(credFile, '{ broken json');
  const srv = newServer();
  srv.loadOrInitInfo();
  assert.notEqual(diskToken(), 'OLDTOKEN'.repeat(4));
  assert.match(diskToken(), /^[A-Za-z0-9_-]{16,128}$/);
  ok('文件损坏（JSON 坏）：生成新凭证覆盖（旧盘面作废，不再具备恢复条件）');
}
{
  const before = JSON.stringify({ token: 'K'.repeat(32), hookToken: 'L'.repeat(32), rotatedAt: 'keep-me' });
  fs.writeFileSync(credFile, before);
  const srv = newServer();
  srv.loadOrInitInfo();
  assert.equal(fs.readFileSync(credFile, 'utf8'), before, '完整信息复用不重写（rotatedAt 保持）');
  ok('完整文件：复用不重写，rotatedAt 保持真实生成时刻');
}
{
  fs.writeFileSync(credFile, JSON.stringify({ token: 'M'.repeat(32), hookSecret: 'sec', pushSubscription: { e: 1 }, rotatedAt: 'r' }));
  const srv = newServer();
  srv.loadOrInitInfo(); // hookToken 缺失 → 补生成
  const disk = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  assert.ok(disk.hookToken && disk.hookToken.length >= 16, 'hookToken 补生成');
  assert.equal(disk.token, 'M'.repeat(32));
  assert.equal(disk.hookSecret, 'sec');
  assert.deepEqual(disk.pushSubscription, { e: 1 });
  ok('hookToken 缺失：补生成并落盘，其余字段（secret/push/rotatedAt）原样保留');
}
{
  // 单独读失败（写盘正常）：停用并保留盘面——不生成新凭证覆盖（否则丢字段/意外轮换）
  const before = JSON.stringify({
    token: 'R'.repeat(32),
    hookToken: 'K'.repeat(32),
    rotatedAt: 'keep',
    hookSecret: 'keep-secret',
    pushSubscription: { endpoint: 'keep' },
    futureField: 42
  });
  fs.writeFileSync(credFile, before);
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (String(p) === credFile) throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
    return realRead.call(this, p, ...args);
  };
  let threw = null;
  try {
    newServer().loadOrInitInfo();
  } catch (e) {
    threw = e;
  } finally {
    fs.readFileSync = realRead;
  }
  assert.ok(threw, '读失败必须 throw（start 捕获后停用远程服务）');
  assert.ok(String(threw.message).includes('读取失败'));
  assert.equal(fs.readFileSync(credFile, 'utf8'), before, '盘面原样保留：token/hookToken/hookSecret/pushSubscription/未知字段全部不动');
  // 故障恢复后重启：旧凭证照常可用（未意外轮换、未丢字段）
  const srv = newServer();
  srv.loadOrInitInfo();
  assert.equal(srv.getStatusInfo().token, 'R'.repeat(32));
  assert.equal(srv.getStatusInfo().hook.secret, 'keep-secret');
  ok('读取失败（写盘正常）：throw 停用且盘面原样保留；故障恢复后旧凭证照常可用');
}
{
  // 读取失败 + 写盘失败（同目录 IO 异常）→ 启动即停服，不带不可持久化的凭证运行
  fs.writeFileSync(credFile, JSON.stringify({ token: 'N'.repeat(32) }));
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (String(p) === credFile) throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
    return realRead.call(this, p, ...args);
  };
  const realOpen = fs.openSync;
  fs.openSync = function (p, ...args) {
    if (String(p).startsWith(credFile)) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    return realOpen.call(this, p, ...args);
  };
  let threw = null;
  try {
    newServer().loadOrInitInfo();
  } catch (e) {
    threw = e;
  } finally {
    fs.readFileSync = realRead;
    fs.openSync = realOpen;
  }
  assert.ok(threw, '落盘失败必须 throw（start 捕获后停用远程服务）');
  assert.ok(String(threw.message).includes('远程访问停用'));
  ok('读取失败且落盘失败：启动路径 throw（停服待修复，不静默带病运行）');
}

// ── rotateToken：成功判据 + 重启不复活 ──
{
  fs.writeFileSync(credFile, JSON.stringify({ token: 'OLDTOKEN'.repeat(4), hookToken: 'H'.repeat(32), rotatedAt: 'r0', pushSubscription: { p: 1 }, futureField: 9 }));
  const srv = newServer();
  srv.loadOrInitInfo();
  const old = srv.getStatusInfo().token;
  const res = withRenameFailure(() => srv.rotateToken());
  assert.equal(res.ok, false, '落盘失败必须显式返回失败');
  assert.ok(res.error.length > 0);
  assert.equal(srv.getStatusInfo().token, old, '失败后内存保持旧 token（保留旧状态）');
  assert.equal(diskToken(), 'OLDTOKEN'.repeat(4), '失败后磁盘未被部分改动');
  const restarted = newServer();
  restarted.loadOrInitInfo();
  assert.equal(restarted.getStatusInfo().token, old, '未宣称成功的轮换：重启仍是旧 token（与失败策略一致）');
  ok('rotateToken 落盘失败：ok:false + 内存/磁盘均保持旧值（未宣称成功，无误导）');
}
{
  fs.writeFileSync(credFile, JSON.stringify({ token: 'OLDTOKEN'.repeat(4), hookToken: 'H'.repeat(32), rotatedAt: 'r0', pushSubscription: { p: 1 }, futureField: 9 }));
  const srv = newServer();
  srv.loadOrInitInfo();
  const old = srv.getStatusInfo().token;
  const res = srv.rotateToken();
  assert.equal(res.ok, true);
  assert.notEqual(res.status.token, old);
  const disk = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  assert.equal(disk.token, res.status.token, '成功后磁盘=新 token');
  assert.deepEqual(disk.pushSubscription, { p: 1 }, '轮换保留 pushSubscription');
  assert.equal(disk.futureField, 9, '轮换保留未知字段');
  assert.equal(disk.hookToken, 'H'.repeat(32), '轮换不动 hookToken');
  const restarted = newServer();
  restarted.loadOrInitInfo();
  assert.equal(restarted.getStatusInfo().token, res.status.token);
  assert.notEqual(restarted.getStatusInfo().token, old);
  ok('rotateToken 成功：磁盘/重启均为新 token，pushSubscription 与未知字段保留');
}
{
  // 成功轮换立即吊销旧连接：close 握手在途也不可再发新请求
  fs.writeFileSync(credFile, JSON.stringify({ token: 'T'.repeat(32), hookToken: 'H'.repeat(32), rotatedAt: 'r' }));
  const srv = newServer();
  srv.ctx = { config: {} }; // Real startup supplies the workspace owner registry.
  srv.loadOrInitInfo();
  const token = srv.getStatusInfo().token;
  const ws = connect(srv, token);
  assert.ok(srv.getStatusInfo().running !== undefined);
  // 建立连接后 server 已登记该客户端：先验证合法帧可用
  ws.emit('message', JSON.stringify({ t: 'ping' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(ws.sent.at(-1)).t, 'pong', '吊销前 ping 正常回 pong');
  const res = srv.rotateToken();
  assert.equal(res.ok, true);
  assert.deepEqual(ws.closeCalls.map((c) => c.code), [4001], '旧连接收到 close 4001');
  // close 是异步握手：模拟客户端延迟完成 close（不触发 close 事件）仍试图发新帧
  const sentBefore = ws.sent.length;
  ws.emit('message', JSON.stringify({ t: 'invoke', id: 1, channel: 'app:version', args: [] }));
  ws.emit('message', JSON.stringify({ t: 'send', channel: 'pty:input', args: ['x'] }));
  ws.emit('message', JSON.stringify({ t: 'ping' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ws.sent.length, sentBefore, '吊销后旧连接任何帧都得不到受理（无 reply/pong）');
  assert.ok(closeOwnerCalls.length >= 1, '吊销时释放 owner 资源');
  // 新 token 连接不受影响
  const ws2 = connect(srv, res.status.token);
  ws2.emit('message', JSON.stringify({ t: 'ping' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(ws2.sent.at(-1)).t, 'pong', '新 token 连接正常');
  ok('成功轮换立即吊销旧连接：close(4001) + owner 释放；close 在途不能发新 invoke/send/ping');
}

// ── rotateHookToken / setHookSecret / pushSubscription ──
{
  fs.writeFileSync(credFile, JSON.stringify({ token: 'A'.repeat(32), hookToken: 'H'.repeat(32), rotatedAt: 'r' }));
  const srv = newServer();
  srv.loadOrInitInfo();
  const res = withRenameFailure(() => srv.rotateHookToken());
  assert.equal(res.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(credFile, 'utf8')).hookToken, 'H'.repeat(32), 'hook 轮换失败保留旧值');
  const okRes = srv.rotateHookToken();
  assert.equal(okRes.ok, true);
  const disk = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  assert.equal(disk.hookToken, srv.getStatusInfo().hook.path.split('/').pop(), 'hook 轮换成功落盘');
  assert.equal(disk.token, 'A'.repeat(32), 'hook 轮换不动网页访问 token');
  assert.equal(disk.rotatedAt, 'r', 'hook 轮换不动 rotatedAt');
  ok('rotateHookToken：失败保留旧 hook 地址；成功只动 hookToken（网页 token/rotatedAt 不被意外修改）');
}
{
  fs.writeFileSync(credFile, JSON.stringify({ token: 'A'.repeat(32), hookToken: 'H'.repeat(32), rotatedAt: 'r', hookSecret: 'old' }));
  const srv = newServer();
  srv.loadOrInitInfo();
  assert.equal(srv.setHookSecret('  new-secret  ').ok, true);
  let disk = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  assert.equal(disk.hookSecret, 'new-secret', '设置成功（trim）');
  assert.equal(srv.setHookSecret('').ok, true);
  disk = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  assert.ok(!('hookSecret' in disk), '空串清除字段');
  const fail = withRenameFailure(() => srv.setHookSecret('later'));
  assert.equal(fail.ok, false);
  assert.equal(srv.getStatusInfo().hook.secret, '', '失败后内存保持清除态');
  ok('setHookSecret：设置/trim、空串清除、失败保留当前态');
}
{
  fs.writeFileSync(credFile, JSON.stringify({ token: 'A'.repeat(32), hookToken: 'H'.repeat(32), rotatedAt: 'r' }));
  const srv = newServer();
  srv.loadOrInitInfo();
  assert.equal(srv.setPushSubscription({ endpoint: 'e1' }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(credFile, 'utf8')).pushSubscription, { endpoint: 'e1' });
  assert.equal(srv.setPushSubscription(null).ok, true);
  assert.ok(!('pushSubscription' in JSON.parse(fs.readFileSync(credFile, 'utf8'))), 'null 清除存储位');
  assert.equal(withRenameFailure(() => srv.setPushSubscription({ endpoint: 'e2' })).ok, false);
  ok('setPushSubscription：与轮换同路径（成功判据/清除/失败保留）');
}

console.log(`web-access-server-credentials: ${passed} 组断言全绿`);
fs.rmSync(fixture, { recursive: true, force: true });
