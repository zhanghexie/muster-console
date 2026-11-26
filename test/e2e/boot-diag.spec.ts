/**
 * 启动自报错陷阱（index.html 内联脚本）生命周期回归：
 * React 挂载后任何 window error（含 ResizeObserver 自限良性提示）都不得再弹
 * 「启动失败 / Boot error」红条且永无机制收走；良性提示也不进 renderer-errors
 * 落盘上报，但真实错误的上报通道必须仍存活（防过滤假绿）。
 *
 * 落盘断言按本轮 marker 做增量对比：沙箱 reset 不清 userData/logs，
 * renderer-errors.ndjson 会跨轮残留（含转红自查轮写入的良性记录），
 * 不能对整份文件做包含/不包含断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, repoRoot } from './fixtures/electron';

const errLogPath = () =>
  path.join(repoRoot, '.dev-sandbox', 'userData', 'logs', 'renderer-errors.ndjson');

const readErrLog = (): string => {
  try {
    return fs.readFileSync(errLogPath(), 'utf8');
  } catch {
    return '';
  }
};

/** 本轮新增的落盘内容（追加写 + 256KB 才轮转，测试里 baseline 必是前缀） */
const errLogGrowth = (baseline: string): string => {
  const now = readErrLog();
  return now.startsWith(baseline) ? now.slice(baseline.length) : now;
};

const dispatchError = (win: Page, message: string) =>
  win.evaluate(
    (msg) => {
      window.dispatchEvent(new ErrorEvent('error', { message: msg, error: new Error(msg) }));
    },
    message
  );

test('挂载后错误不弹启动失败红条；良性 RO 提示不上报、真实错误通道存活', async ({
  appCtx
}) => {
  const { win } = appCtx;
  // 看门狗 3s 一 tick：挂载后等一个完整 tick，确保陷阱已退役（监听已摘除）
  await win.waitForTimeout(3500);
  expect(await win.locator('.boot-diag').count()).toBe(0);

  // marker 后缀不影响前缀识别（isBenignRendererError 按前缀匹配），但让落盘断言唯一
  const marker = `e2e-bootdiag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const baseline = readErrLog();

  // 良性 ResizeObserver 自限提示：不得出红条，也不得进 renderer-errors 落盘
  await dispatchError(win, `ResizeObserver loop completed with undelivered notifications. [${marker} benign]`);
  await win.waitForTimeout(500);
  expect(await win.locator('.boot-diag').count()).toBe(0);
  expect(errLogGrowth(baseline).includes(`[${marker} benign]`)).toBe(false);

  // 真实错误：同样不得被标成「启动失败」，但上报通道必须存活
  await dispatchError(win, `[${marker} real] post-mount error must not be labeled boot failure`);
  await win.waitForTimeout(800);
  expect(await win.locator('.boot-diag').count()).toBe(0);
  const growth = errLogGrowth(baseline);
  expect(growth.includes(`[${marker} real]`), growth).toBe(true);
});
