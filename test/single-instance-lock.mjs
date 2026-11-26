/**
 * 强制单实例守卫（X5-F01，用户拍板超出报告建议档）：
 * src/main/index.ts 的实例锁接线静态断言——锁请求必须先于所有启动期写盘副作用，
 * 未拿到锁的实例要提示后退出，主实例 second-instance 聚焦主窗，
 * 「另有实例」提醒收敛为仅同 userData（跨 userData 共存是刻意支持形态）。
 * Electron 实例锁本身无法离线驱动（需真实 app），此处守接线形态；
 * 还原修复（去掉锁）即红。运行: node test/single-instance-lock.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'src/renderer/src/App.tsx'), 'utf8');

// 1) 锁在位：请求结果落变量，失败分支提示后退出
assert.match(
  src,
  /const gotSingleInstanceLock = app\.requestSingleInstanceLock\(\);/,
  '必须调用 app.requestSingleInstanceLock 并落 gotSingleInstanceLock'
);
const lockAt = src.indexOf('const gotSingleInstanceLock');
assert.ok(lockAt > 0, '单实例锁代码块必须存在');
assert.match(src, /if \(!gotSingleInstanceLock\) \{[\s\S]*?dialog\.showErrorBox\([\s\S]*?app\.quit\(\);[\s\S]*?\}/, '锁失败分支：先 showErrorBox 提示再 app.quit()');
assert.match(src, /if \(!gotSingleInstanceLock\) \{[\s\S]*?app\.quit\(\);[\s\S]*?process\.exit\(0\);/, '锁失败分支必须在后续配置和沙箱写入前立即退出');
const sandboxRedirectAt = src.indexOf('setupDevSandbox({ initialize: false })');
assert.ok(sandboxRedirectAt > 0 && sandboxRedirectAt < lockAt, '开发沙箱只能在锁前完成 userData 重定向，不得初始化文件');
const sandboxInitAt = src.indexOf('setupDevSandbox();', lockAt);
assert.ok(sandboxInitAt > lockAt, '开发沙箱文件初始化必须在持锁后进行');

// 2) 主实例：second-instance 聚焦/复原主窗
assert.match(
  src,
  /app\.on\('second-instance', \(_event, commandLine, workingDirectory\) => \{[\s\S]*?relaySecondInstance\(commandLine, workingDirectory\);[\s\S]*?\}\);/,
  'second-instance 事件必须把启动请求交给主实例'
);
assert.match(src, /mainWindow\.webContents\.send\('app:second-instance', request\)/, '第二实例请求必须经 IPC 发送给主窗口');
assert.match(src, /pendingSecondInstanceRequests/, '窗口尚未 ready 时必须保留第二实例请求');
assert.match(appSrc, /app:second-instance.*workingDirectory/s, '渲染层必须接收第二实例工作目录');
assert.match(appSrc, /workingDirectory\.replace/, '相对启动参数必须基于第二实例工作目录解析');

// 3) 锁先于启动期写盘副作用：配置、原生扩展加载和协议注册都被锁守卫，
//    且锁请求位置在这些副作用之前
assert.ok(
  lockAt < src.indexOf('new ConfigManager()'),
  '锁请求必须先于 ConfigManager 构造（后续恢复链的入口）'
);
assert.match(
  src,
  /if \(gotSingleInstanceLock\) \{\s*\n\s*collectStartupSchemes\(/,
  'collectStartupSchemes（含 startupNative.load）必须由单实例锁守卫'
);

// 4) whenReady 不得为将退出的第二实例起启动链
assert.match(
  src,
  /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]{0,200}if \(!gotSingleInstanceLock\) return;/,
  'whenReady 回调开头必须为未拿到锁的实例直接 return'
);

// 5) 「另有实例」提醒按单实例语义收敛：只对同 userData 的残留实例警示
assert.match(
  src,
  /listAppInstances\(\)\.filter\(\s*\n\s*\(x\) => x\.pid !== process\.pid && x\.userData === userDataDir\s*\n\s*\)/,
  '多实例提醒必须过滤为仅同 userData 实例（跨 userData 共存不再打扰）'
);
assert.ok(
  !src.includes('本机另有 {{n}} 个运行中的工作台实例'),
  '旧的「本机另有 N 个实例」全量提醒文案应已收敛'
);

// 6) 就绪事件（X7-F01）：启动链收口时给渲染层推 app:boot:ready
assert.match(
  src,
  /webContents\.send\('app:boot:ready', result\)/,
  '启动链 finally 必须广播 app:boot:ready（bootWait 超时降级挂载的重拉信号）'
);

console.log('single-instance-lock: 6 组接线断言全绿');
