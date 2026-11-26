/**
 * updater 通知接线契约自测（2026-09-14 子代理评审回归）。
 *
 * updater/index.ts 依赖 electron 宿主，node 侧无法直载；但评审实锤过两类纯接线 bug：
 * ① 已 downloaded 后再次检查更新，update-available 无条件覆盖条目回「正在后台下载」，
 *    而 announceDownloaded 被 announcedVersion 早退——条目永停下载中文案（托盘同屏矛盾）；
 * ② 通知推送每次现取 activeWorkspaceId，下载中切工区后同键查找落空 → 新建条目、旧条目冻结。
 * 故按 test/bgtask-message-gate.mjs 先例做源码契约断言：还原修复（删守卫/改回现取工区）
 * 时本用例应转红。
 *
 * 运行: node test/updater-notify-wiring.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/main/updater/index.ts'), 'utf8');

/** 取函数全文（从声明到下一个顶层 function/结尾），避免跨函数误匹配 */
function fnBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const next = src.slice(start + 1).search(/\nfunction |\n\/\*\*|\nexport /);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

// ---------- 1. notifyUpdateStart 必须有 announcedVersion 守卫（P0 回归） ----------
assert.match(
  fnBody('notifyUpdateStart'),
  /if \(announcedVersion === version\) return;/,
  'notifyUpdateStart 必须守卫「同版本已播报过已就绪」，否则重复检查会把条目倒回下载中文案且不再自愈'
);

// ---------- 2. 通知条目归属固定工区快照，不得现取 activeWorkspaceId ----------
assert.ok(
  fnBody('notifyUpdateStart').includes('notifyWsId = activeWsId()'),
  'notifyWsId 必须在下载开始时快照'
);
const pushSites = src.match(/workspaceId: [^,\n]+/g) ?? [];
assert.deepEqual(
  pushSites,
  ['workspaceId: notifyWsId'],
  '所有更新通知必须经 pushUpdaterNotify 用固定 notifyWsId（现取 activeWsId 会在切工区后分裂同键条目）'
);

// ---------- 3. 更新通知统一出口无条件 toast（应用内通知面板已移除） ----------
const pushFn = fnBody('pushUpdaterNotify');
assert.match(
  pushFn,
  /toast: true/,
  'pushUpdaterNotify 必须无条件 toast:true——应用内通知面板已移除，系统 toast 是唯一通知出口'
);
const announce = fnBody('announceDownloaded');
assert.match(
  announce,
  /pushUpdaterNotify\(t\('新版本/,
  'announceDownloaded 必弹 toast（窗口可见与否都弹）'
);
assert.ok(
  announce.includes("'新版本 v{{version}} 已就绪，重启工作台后完成更新'"),
  '下载完成必须复用同键已就绪文案'
);

// ---------- 4. 下载失败必须收口通知条目（下载态才推，防启动检查误报） ----------
const errorHandler = src.slice(src.indexOf("updater.on('error'"), src.indexOf('const delay ='));
assert.match(
  errorHandler,
  /failedDuringDownload = status\.state === 'downloading'/,
  'error 处理必须以下载态收口通知条目（state 须在 setStatus 置 error 前求值）；启动静默检查失败时 state 是 checking，不会误报'
);
assert.match(
  errorHandler,
  /pushUpdaterNotify\(downloadFailedNotifyText\(/,
  '下载失败必须同键推终态文案，条目不能永停「正在下载 N%」'
);

// ---------- 5. download-progress：幽灵事件防御 + 解除已就绪播报守卫 ----------
const progressHandler = src.slice(
  src.indexOf("updater.on('download-progress'"),
  src.indexOf("updater.on('update-downloaded'")
);
assert.match(
  progressHandler,
  /if \(status\.state !== 'downloading'\) return;/,
  'downloaded/error 后迟到的进度事件不得把状态机倒回下载中（托盘/任务栏会诈尸）'
);
assert.match(
  progressHandler,
  /^\s*announcedVersion = null;/m,
  '真下载进行中必须解除「已就绪」播报守卫，否则同版本重下（撤回重发/缓存损坏）后条目永停下载中文案'
);

// ---------- 6. 同键常量唯一来源：surface 导出，index 不得内联字面量 ----------
assert.ok(
  !src.includes("'updater:progress'"),
  'UPDATE_NOTIFY_KEY 必须从 surface 导入，不得在 index 内联字面量'
);

// ---------- 7. X7-F03：quit 被确认门取消（返回工作台）的安装暂缓姿态 ----------
const deferred = fnBody('noteInstallDeferred');
assert.ok(deferred.includes('installRequestedAt = 0'), 'noteInstallDeferred 必须清 installRequestedAt 残留（否则占 30s 安装失败窗）');
assert.match(deferred, /pushUpdaterNotify\(t\('更新已暂缓/, '取消路径必须 toast「更新已暂缓」——安装静默中止是 X7-F03 的原始缺口');
const install = fnBody('installNow');
assert.match(
  install,
  /runningTasks\(\)/,
  'installNow 前必须查扩展任务 runningTasks——非空时暂缓而非硬撞 before-quit 确认门'
);
assert.match(install, /更新已暂缓/, '扩展任务运行中的暂缓分支必须带提示');

console.log('updater-notify-wiring: all assertions passed');
