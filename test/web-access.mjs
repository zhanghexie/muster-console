/**
 * 网页访问网关 e2e：构建产物 + dev 沙箱拉起真实应用，浏览器视角全链路验证。
 *
 * 前置：先 `npm run build`（网关静态服务 out/renderer）。需要 Electron；与
 * gui-chat-cdp.mjs 同类，不进 npm test（见 run.mjs EXCLUDE），手动运行：
 *   node test/web-access.mjs
 *
 * 覆盖：token 鉴权 → WS invoke（bootWait / sessions:list / create / 黑名单拒绝 /
 * 未知通道拒绝）→ 应用层 ping/pong → 事件广播回流（sessions:changed）→ session-status 推送帧
 * （Shell API 上报 needs_you 触发、同类重入不重发、done 跨触发类照发）→ send
 * 通道（pty:input 终端回显）→ hello caps 过滤（drop pty:data）→ HTTP 静态页与 /media 鉴权。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PORT = 17950;
const BASE = `http://127.0.0.1:${PORT}`;
const tokenFile = path.join(repoRoot, '.dev-sandbox', 'userData', 'web-access.json');

const indexHtml = path.join(repoRoot, 'out', 'renderer', 'index.html');
if (!fs.existsSync(indexHtml)) {
  console.error('缺少 out/renderer/index.html，请先 npm run build');
  process.exit(1);
}

const child = spawn(
  path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [repoRoot],
  {
    cwd: repoRoot,
    env: { ...process.env, MUSTER_WEB_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  }
);
let appLog = '';
const onLog = (chunk) => {
  const text = chunk.toString();
  appLog += text;
  process.stdout.write(`[app] ${text}`);
};
child.stdout.on('data', onLog);
child.stderr.on('data', onLog);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitToken() {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`应用提前退出（code=${child.exitCode}）`);
    try {
      const raw = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (typeof raw.token === 'string' && raw.token) return raw.token;
    } catch {
      /* 尚未生成 */
    }
    await sleep(500);
  }
  throw new Error(`60s 内未生成 token 文件: ${tokenFile}`);
}

/** token 文件写入早于 listen()，就绪以端口可达为准 */
async function waitGatewayUp() {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`应用提前退出（code=${child.exitCode}）`);
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('60s 内网关端口未就绪');
}

let msgId = 0;
const pending = new Map();
const events = [];
const pushes = []; // t:'push' 服务端主动推送帧（T1.2 session-status）
const pongs = [];
let ws;

function invoke(channel, args = []) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject, channel });
    ws.send(JSON.stringify({ t: 'invoke', id, channel, args }));
  });
}

function send(channel, args = []) {
  ws.send(JSON.stringify({ t: 'send', channel, args }));
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    sock.on('open', () => resolve(sock));
    sock.on('error', reject);
    sock.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'pong') {
        pongs.push(msg);
      } else if (msg.t === 'result' && pending.has(msg.id)) {
        const { resolve, reject, channel } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(`[${channel}] ${msg.error}`));
      } else if (msg.t === 'event') {
        events.push(msg);
      } else if (msg.t === 'push') {
        pushes.push(msg);
      }
    });
  });
}

async function waitEvent(channel, predicate, label) {
  for (let i = 0; i < 60; i++) {
    const hit = events.find((e) => e.channel === channel && predicate(e.payload));
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error(`10s 内未收到事件: ${label}`);
}

async function waitShellApi() {
  const file = path.join(repoRoot, '.dev-sandbox', 'userData', 'shell-api.json');
  for (let i = 0; i < 40; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (info.baseUrl) return info.baseUrl;
    } catch {
      /* 尚未生成 */
    }
    await sleep(500);
  }
  throw new Error('20s 内未找到 shell-api.json');
}

async function waitPush(predicate, label) {
  for (let i = 0; i < 20; i++) {
    const hit = pushes.find(predicate);
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error(`10s 内未收到推送帧: ${label}`);
}

async function reportPhase(baseUrl, sessionId, phase, label) {
  const r = await fetch(`${baseUrl}/v1/session-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, phase, label })
  });
  assert.equal(r.status, 200, `session-status 上报应 200（phase=${phase}）`);
  return r.json();
}

try {
  // 0. 等网关就绪 + 读 token
  await waitGatewayUp();
  const token = await waitToken();

  // 1. 鉴权拒绝：无 token 连不上
  let refused = false;
  try {
    await connectWs(`${BASE.replace('http', 'ws')}/ws`);
  } catch {
    refused = true;
  }
  // ws 库在握手 401/关闭时可能 open 后立即 close，也算拒绝
  assert.ok(refused || !ws || ws.readyState !== WebSocket.OPEN, '无 token 不应建立 WS');

  // 2. 带 token 连接
  ws = await connectWs(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
  console.log('=== [web-access] WS 已连接');

  // 2b. 应用层心跳：ping → pong（半开检测契约）
  ws.send(JSON.stringify({ t: 'ping' }));
  for (let i = 0; i < 20 && pongs.length === 0; i++) await sleep(50);
  assert.ok(pongs.length >= 1, '应答应用层 ping 的 pong');
  console.log('=== [web-access] ping/pong ok');

  // 3. bootWait：后台启动链完成
  const boot = await invoke('app:boot:wait');
  assert.equal(boot.ok, true, 'bootWait 应 ok');
  console.log('=== [web-access] bootWait ok');

  // 4. sessions:list（{ sessions, activeId } 投影）
  const listing = await invoke('sessions:list');
  assert.ok(Array.isArray(listing?.sessions), 'sessions:list 应返回 { sessions, activeId }');
  console.log(`=== [web-access] sessions:list ${listing.sessions.length} 条`);

  // 5. create → sessions:changed 事件回流
  const created = await invoke('sessions:create', [{ name: 'web-access-e2e' }]);
  assert.ok(created && created.id, 'sessions:create 应返回会话');
  await waitEvent('sessions:changed', (p) => p?.sessions?.some((s) => s.id === created.id), 'sessions:changed');
  console.log(`=== [web-access] sessions:create + 事件回流 ok (${created.id})`);

  // 6. send 通道：终端输入回显（send→ipcMain.emit→pty→webContents.send→广播）
  // 先等 shell 首帧输出再敲命令，避免输入落在 shell 初始化窗口里
  await waitEvent('pty:data', (p) => p?.sessionId === created.id, 'pty 首帧输出');
  send('pty:input', [created.id, 'echo web-e2e-ok\r']);
  let ptyText = '';
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    ptyText = events
      .filter((e) => e.channel === 'pty:data' && e.payload?.sessionId === created.id)
      .map((e) => e.payload.data)
      .join('');
    if (ptyText.includes('web-e2e-ok')) break;
  }
  if (!ptyText.includes('web-e2e-ok')) {
    // pty:data 事件可能被并入大块，兜底拉一次缓冲
    const buffer = await invoke('pty:getBuffer', [created.id]);
    assert.ok(
      String(buffer).includes('web-e2e-ok'),
      `终端应回显输入，buffer 末尾: ${String(buffer).slice(-200)}`
    );
  }
  console.log('=== [web-access] pty:input 终端回显 ok');

  // 7. 服务端推送（T1.2）：Shell API 上报 phase → NotifyBus 决策通过 → WS push 帧
  //    （needs_you 首评触发 / 同类重入不发 / done 跨触发类照发——决策矩阵见 notifyDecision）
  const shellBase = await waitShellApi();
  await reportPhase(shellBase, created.id, 'needs_you', 'e2e 需要你');
  const push1 = await waitPush(
    (m) => m.type === 'session-status' && m.sessionId === created.id && m.phase === 'needs_you',
    'needs_you 首次翻转推送'
  );
  assert.ok(
    push1.label.includes('web-access-e2e') && push1.label.includes('需要你'),
    `label 应为「会话名 · 需要你」形态，实得: ${push1.label}`
  );
  await reportPhase(shellBase, created.id, 'needs_you', '同类重入');
  await sleep(1500);
  assert.equal(
    pushes.filter((m) => m.sessionId === created.id).length,
    1,
    '同类重入（no-flip）不应重复推送'
  );
  await reportPhase(shellBase, created.id, 'done', 'e2e 完成');
  await waitPush(
    (m) => m.type === 'session-status' && m.sessionId === created.id && m.phase === 'done',
    'done 翻转推送'
  );
  console.log('=== [web-access] session-status 推送帧 ok');

  // 8. 黑名单与未知通道
  await assert.rejects(invoke('app:quit'), /不支持通道/, 'app:quit 应被 web 黑名单拒绝');
  await assert.rejects(invoke('app:pickWallpaper'), /不支持通道/, 'app:pickWallpaper 应被 web 黑名单拒绝');
  await assert.rejects(invoke('capabilityManagement:pickDirectory'), /不支持通道/, 'capabilityManagement:pickDirectory 应被 web 黑名单拒绝');
  await assert.rejects(
    invoke('workbench:managePackage', [{ action: 'install', installationWorkspaceId: '@global' }]),
    /无此通道/,
    '旧版扩展安装通道已移除'
  );
  await assert.rejects(invoke('definitely:not-a-channel'), /无此通道/);
  console.log('=== [web-access] 通道黑名单/未知通道拒绝 ok');

  // 8b. hello caps 过滤：terminal:false 的客户端不再收 pty:data（手机弱网防洪泛）
  {
    const filtered = await connectWs(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const filteredEvents = [];
    filtered.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'event') filteredEvents.push(m);
    });
    filtered.send(JSON.stringify({ t: 'hello', caps: { terminal: false, stream: false } }));
    await sleep(100);
    send('pty:input', [created.id, 'echo caps-filter-probe\r']);
    await sleep(800);
    assert.ok(
      !filteredEvents.some((e) => e.channel === 'pty:data'),
      'terminal:false 客户端不应收到 pty:data'
    );
    assert.ok(
      events.some((e) => e.channel === 'pty:data' && e.payload?.sessionId === created.id),
      '未声明 caps 的客户端仍收全量（向后兼容）'
    );
    filtered.close();
    console.log('=== [web-access] hello caps 过滤 ok');
  }

  // 9. HTTP：入口页未授权 401 且响应体不含 token（A2-7-1）；带 query token 200；
  // /media 无 token 401、带 token 200、不存在 404
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 401, '入口页无 token 应 401（A2-7-1）');
  const anonBody = await page.text();
  assert.ok(!anonBody.includes(token), '无 token 响应体不得包含 token 串');
  const htmlRes = await fetch(`${BASE}/?token=${token}`);
  assert.equal(htmlRes.status, 200, '带 query token 的入口不受影响');
  const html = await htmlRes.text();
  assert.ok(html.includes('<title>MetaAgent'), '静态页应是渲染层入口');
  const extEnc = encodeURIComponent(path.join(repoRoot, 'package.json'));
  const r401 = await fetch(`${BASE}/media/ext/${extEnc}`);
  assert.equal(r401.status, 401, '/media 无 token 应 401');
  const r200 = await fetch(`${BASE}/media/ext/${extEnc}?token=${token}`);
  assert.equal(r200.status, 200, '/media 带 token 应 200');
  const r404 = await fetch(`${BASE}/media/ext/${encodeURIComponent('Z:/no/such/file.png')}?token=${token}`);
  assert.equal(r404.status, 404, '/media 不存在文件应 404');
  console.log('=== [web-access] HTTP 静态页 / media 鉴权 ok');

  // 10. 清理会话（应用语义：删除仅对已归档会话开放）
  await invoke('sessions:setArchived', [created.id, true]);
  await invoke('sessions:close', [created.id]);

  // 11. 桌面壳无致命错误
  await sleep(1000);
  assert.ok(!appLog.includes('[fatal]'), '应用日志不应出现 [fatal]');
  console.log('=== [web-access] 全部通过');
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  } else {
    child.kill();
  }
}
