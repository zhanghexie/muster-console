/**
 * 启动/退出链加固合同（reliability/X7-启动与更新链 F-05/F-06）。
 * src/main/index.ts 依赖 electron 宿主无法直载，按 updater-notify-wiring.mjs 先例做
 * 源码合同断言：还原修复（去掉 try/catch、删心跳周期刷新、删 before-quit 清理）时
 * 对应用例转红。
 * 运行: node test/boot-chain-hardening.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const hostEntrypoints = fs.readFileSync(path.join(root, 'src/main/bootstrap/registerHostEntrypointDomains.ts'), 'utf8');
const bootSources = `${src}\n${hostEntrypoints}`;

// ---------- X7-F05：shellApi.start 失败降级提示，不中断启动链 ----------
const shellStartAt = bootSources.search(/await shellApi!?\.start\(\)/);
assert.ok(shellStartAt >= 0, 'X7-F05：源码必须保留 shellApi.start() 启动入口');
const shellStart = bootSources.slice(
  bootSources.lastIndexOf('try {', shellStartAt),
  bootSources.indexOf('const webAccess = new WebAccessServer()', shellStartAt)
);
assert.ok(
  /try\s*\{\s*await shellApi!?\.start\(\);\s*\} catch/.test(shellStart),
  'X7-F05：await shellApi.start() 必须包 try/catch——监听失败降级为 notify，不得中断整条后台链'
);
assert.match(shellStart, /工具网关启动失败/, '降级提示必须说明 Agent 工具网关不可用');
assert.match(shellStart, /桌面功能不受影响/, '降级提示必须交代桌面不受影响');
// baseUrl 为空的降级护栏：不注入残缺宿主身份环境
const hostEnv = src.slice(src.indexOf('pty.getHostEnv ='), src.indexOf('const ptyPidBySession'));
assert.match(
  hostEnv,
  /if \(!base\) return \{\};/,
  'X7-F05：shellApi.baseUrl 为空时 getHostEnv 必须短路返回空 env'
);

// ---------- X7-F06：实例心跳周期刷新 + 退出清理 ----------
const heartbeat = src.slice(src.indexOf('writeInstanceHeartbeat({'), src.indexOf('// 单实例锁（X5-F01）收敛后'));
assert.match(
  heartbeat,
  /(?:setInterval\(\(\) => \{[\s\S]*?writeInstanceHeartbeat|startupWork\.schedule\([\s\S]*?writeInstanceHeartbeat)/,
  'X7-F06：boot 末尾之外必须有受生命周期管理的周期心跳（updatedAt 不得恒等于 startedAt）'
);
if (/setInterval\(\(\)/.test(heartbeat)) {
  assert.match(heartbeat, /unref\?\.\(\)/, '独立心跳定时器必须 unref（不阻退出）');
} else {
  assert.match(heartbeat, /startupWork\.schedule\(5 \* 60_000/, '调度式心跳必须有五分钟周期');
}
assert.match(heartbeat, /startedAt: heartbeatStartedAt/, '周期刷新必须保住 startedAt 不漂移');
const quitBlock = src.slice(src.indexOf("app.on('before-quit'"), src.indexOf('// ── 后台启动链'));
assert.match(
  quitBlock,
  /(?:clearInterval\(heartbeatTimer\)|removeInstanceHeartbeat\(appInstance\.id\))/,
  'X7-F06：before-quit 必须清理实例心跳（退出清理）'
);

// ---------- X7-F03：before-quit 确认门取消路径通知 updater ----------
assert.match(
  quitBlock,
  /noteInstallDeferred\(\)/,
  'X7-F03：确认门选「返回工作台」必须调 noteInstallDeferred——清 installRequestedAt 残留并 toast 更新已暂缓'
);

console.log('boot-chain-hardening: all assertions passed');
