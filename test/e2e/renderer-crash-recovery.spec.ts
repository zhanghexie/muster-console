/**
 * 渲染进程崩溃自愈链路（真实崩溃）：
 * 主进程强制杀渲染进程 → render-process-gone 死因落盘 main.log →
 * 滑动窗口限频决策自动 reload → 界面重新水合可用。
 *
 * 把修复还原（handler 只 console.error 不 reload / 不落盘）时本文件应转红。
 * main.log 断言按本轮 marker 前缀做增量对比（reset 沙箱不清 userData/logs，
 * 与 boot-diag 的 renderer-errors 增量断言同款手法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, repoRoot } from './fixtures/electron';

const mainLogPath = () => path.join(repoRoot, '.dev-sandbox', 'userData', 'logs', 'main.log');

const readMainLog = (): string => {
  try {
    return fs.readFileSync(mainLogPath(), 'utf8');
  } catch {
    return '';
  }
};

/** 本轮新增的落盘内容（追加写 + 1MB 才轮转，baseline 必是前缀） */
const mainLogGrowth = (baseline: string): string => {
  const now = readMainLog();
  return now.startsWith(baseline) ? now.slice(baseline.length) : now;
};

test('渲染进程崩溃 → 死因落盘 → 自动 reload 界面恢复', async ({ appCtx }) => {
  const { app, win } = appCtx;
  await win.waitForSelector('.app-shell', { timeout: 60_000 });
  const baseline = readMainLog();

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.webContents.forcefullyCrashRenderer();
  });

  // playwright 的 CDP session 在渲染进程崩溃后自身报废（evaluate/Page 一律
  // "Target crashed"，时机不巧还会把 runner 打穿）——恢复断言全部走文件系统
  // 证据，不再调用任何 playwright API。期望的 main.log 序列（主进程落盘）：
  //   [renderer gone] reason=crashed ... -> reload 1/   ← 死因 + 限频决策
  //     ctx url=...                                     ← 崩溃现场快照（URL/内存/console 环）
  //   [renderer did-finish-load] ...                    ← reload 重载完成
  const deadline = Date.now() + 30_000;
  let ok = false;
  let snapshot = '';
  while (Date.now() < deadline && !ok) {
    await new Promise((r) => setTimeout(r, 500));
    const growth = mainLogGrowth(baseline);
    const afterGone = growth.split('[renderer gone]').pop() ?? '';
    ok = growth.includes('[renderer gone] reason=crashed') && growth.includes('-> reload 1/');
    ok = ok && afterGone.includes('ctx url='); // 崩溃现场快照随死因行落盘
    ok = ok && afterGone.includes('did-finish-load');
    snapshot = growth;
  }
  expect(ok, `main.log growth tail:\n${snapshot.slice(-1500)}`).toBe(true);
});
