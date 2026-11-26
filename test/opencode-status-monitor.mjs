/** OpenCode 权威回合状态监控（runtime 脚本内轮询 /session/status → MUSTER_STATUS_URL）。
 * 负对照锚点：修复前 opencode 无 hooks，会话状态只能靠 pty 输出启发式——底部动画/resize
 * 重绘字节会把空闲会话钉在「工作中」。本用例证明状态由权威 busy 事实驱动，与字节无关。
 * 纯逻辑（翻转/心跳决策、busy 映射）+ 真实 HTTP 集成（假 server + resolveLaunch 真定时器）。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveLaunch,
  openCodeSessionBusy,
  nextMonitorReport,
  OPENCODE_TURN_EVENT,
  OPENCODE_MONITOR_HEARTBEAT_MS
} from '../src/main/runtime/builtins/scripts/opencode.mjs';
import { pause } from '../src/main/runtime/builtins/scripts/_native.mjs';

// ---------- 纯逻辑 ----------
// /session/status 映射：与 receiveMessage 的 idle 判定同口径取反
assert.equal(openCodeSessionBusy(undefined, 's'), false);
assert.equal(openCodeSessionBusy({}, 's'), false, '无本会话条目 = 空闲');
assert.equal(openCodeSessionBusy({ s: { type: 'idle' } }, 's'), false);
assert.equal(openCodeSessionBusy({ s: { type: 'running' } }, 's'), true);
assert.equal(openCodeSessionBusy({ s: { type: 'busy' } }, 's'), true);
assert.equal(openCodeSessionBusy({ other: { type: 'running' } }, 's'), false, '只看本会话，子代理回合不串扰');
assert.equal(openCodeSessionBusy({ s: 'garbage' }, 's'), false);

// 翻转必报；首帧（prevBusy=undefined）也报，让宿主立刻获得权威基线
assert.deepEqual(nextMonitorReport({ prevBusy: undefined, observedBusy: false, now: 1000, lastReportAt: undefined }),
  { report: true, activity: 'idle' });
assert.deepEqual(nextMonitorReport({ prevBusy: false, observedBusy: true, now: 2000, lastReportAt: 1000 }),
  { report: true, activity: 'active' });
assert.deepEqual(nextMonitorReport({ prevBusy: true, observedBusy: false, now: 3000, lastReportAt: 2000 }),
  { report: true, activity: 'idle' });
// 稳态不报：空闲静默；忙在心跳窗内不重复
assert.deepEqual(nextMonitorReport({ prevBusy: false, observedBusy: false, now: 999_999, lastReportAt: 0 }),
  { report: false });
assert.deepEqual(
  nextMonitorReport({ prevBusy: true, observedBusy: true, now: 10_000, lastReportAt: 0, heartbeatMs: OPENCODE_MONITOR_HEARTBEAT_MS }),
  { report: false }, '心跳窗内不重复上报');
// 忙超过心跳窗补报一次，维持 active 新鲜度（30s 窗口）
assert.deepEqual(
  nextMonitorReport({ prevBusy: true, observedBusy: true, now: OPENCODE_MONITOR_HEARTBEAT_MS + 1, lastReportAt: 0, heartbeatMs: OPENCODE_MONITOR_HEARTBEAT_MS }),
  { report: true, activity: 'active' });

// ---------- 集成：假 session server + 收集 statusUrl POST ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-monitor-'));
const reports = [];
let busyState = { ses_m: { type: 'idle' } };

const collector = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    reports.push(body ? JSON.parse(body) : null);
    res.writeHead(204); res.end();
  });
});
await new Promise((r) => collector.listen(0, '127.0.0.1', r));
const statusUrl = `http://127.0.0.1:${collector.address().port}/v1/s/token/status`;

const launch = await resolveLaunch({ sessionId: 'ses_m', cwd: tmp, extraArgs: [], env: { MUSTER_STATUS_URL: statusUrl } });
const wire = launch.command === 'cmd.exe' ? launch.args[3].split(' ') : launch.args;
const port = Number(wire[wire.indexOf('--port') + 1]);

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (route === '/session/status') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(busyState));
  } else { res.writeHead(204); res.end(); }
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const waitReports = async (n, label) => {
  for (let i = 0; i < 150 && reports.length < n; i++) await pause(100);
  assert.equal(reports.length, n, label);
};

try {
  // 首帧上报权威 idle（即使此刻 pty 因启动/重绘字节显示 working，也会被纠正）
  await waitReports(1, '初始 idle 应上报');
  assert.deepEqual(reports[0], { activity: 'idle', event: OPENCODE_TURN_EVENT });

  // 回合开始 → active；结束 → idle
  busyState = { ses_m: { type: 'running' } };
  await waitReports(2, '回合开始应上报 active');
  assert.equal(reports[1].activity, 'active');
  busyState = { ses_m: { type: 'idle' } };
  await waitReports(3, '回合结束应上报 idle');
  assert.equal(reports[2].activity, 'idle');

  // dispose 后不再轮询：翻转状态也不产生新上报
  launch.dispose();
  busyState = { ses_m: { type: 'running' } };
  await pause(3_500);
  assert.equal(reports.length, 3, 'dispose 后监控必须停摆');

  // 无 MUSTER_STATUS_URL（shell API 降级/非宿主）：不监控、不影响拉起
  const bare = await resolveLaunch({ sessionId: 'ses_bare', cwd: tmp, extraArgs: [] });
  const bareWire = bare.command === 'cmd.exe' ? bare.args[3].split(' ') : bare.args;
  const barePort = Number(bareWire[bareWire.indexOf('--port') + 1]);
  let bareHits = 0;
  const bareServer = http.createServer((req, res) => { bareHits++; res.writeHead(204); res.end(); });
  await new Promise((r) => bareServer.listen(barePort, '127.0.0.1', r));
  try {
    await pause(3_500);
    assert.equal(bareHits, 0, '无状态 URL 不轮询');
    bare.dispose();
  } finally { bareServer.closeAllConnections(); await new Promise((r) => bareServer.close(r)); }
} finally {
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  collector.closeAllConnections(); await new Promise((r) => collector.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('ok: opencode 回合状态监控（首帧基线/翻转上报/心跳窗/dispose 停摆/无 URL 降级）');
