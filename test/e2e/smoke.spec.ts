/**
 * 启动冒烟：主窗口骨架渲染 + preload 桥就绪 + 启动期渲染层零 console 错误。
 * 收编自 test/check-ui.mjs（原脚本需手动起 app + 9222，且只打印不断言）。
 */
import { test, expect } from './fixtures/electron';

test('主窗口渲染出应用骨架', async ({ appCtx }) => {
  await expect(appCtx.win.locator('#root .app-shell')).toBeVisible();
  await expect(appCtx.win.locator('.main-view')).toBeVisible();
});

test('preload 桥就绪（window.api 可用）', async ({ appCtx }) => {
  const ok = await appCtx.win.evaluate(() => {
    const api = (window as unknown as { api?: { chat?: { send?: unknown } } }).api;
    return typeof api === 'object' && typeof api?.chat?.send === 'function';
  });
  expect(ok).toBe(true);
});

test('启动期渲染层无 console error/warning、无未捕获异常', async ({ appCtx }) => {
  // 等懒加载 chunk（SettingsModal 等不在首屏，但首帧后短驻留可暴露加载即抛错）
  await appCtx.win.waitForTimeout(1500);
  expect(appCtx.consoleErrors, appCtx.consoleErrors.join('\n')).toEqual([]);
});
