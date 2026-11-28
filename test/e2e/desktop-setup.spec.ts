import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Fixture = typeof globalThis & { desktopSetupFixture: {
  permissions: { screenRecording: boolean; accessibility: boolean };
  opened: string[];
  requested: string[];
  revealed: string[];
  resolveScreenRequest(): void;
  sendFailure(result: unknown): void;
} };

test('desktop setup works through the local Electron preload and IPC', async ({}, info) => {
  const root = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'desktop-setup-e2e-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const main = path.join(directory, 'main.cjs');
    await build({ entryPoints: [path.join(__dirname, 'fixtures/desktop-setup-main.ts')], outfile: main,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi'], logLevel: 'silent' });
    await build({ entryPoints: [path.join(__dirname, 'fixtures/desktop-setup-renderer.tsx')], outfile: path.join(directory, 'renderer.js'),
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const styles = ['base.css', 'settings.css'].map(file => {
      const url = pathToFileURL(path.join(root, 'src/renderer/src/styles', file)).href;
      return `<link rel="stylesheet" href="${url}">`;
    }).join('');
    fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Desktop setup</title>${styles}<link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'desktop-setup-fixture', main: 'main.cjs' }));
    fs.mkdirSync(path.join(directory, 'profile'));
    const env = { ...process.env, MUSTER_DESKTOP_SETUP_FIXTURE: directory,
      MUSTER_DESKTOP_SETUP_PRELOAD: path.join(root, 'out/preload/index.js') };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [directory], env });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const setup = page.getByRole('region', { name: '电脑操作' });
    await setup.getByRole('button', { name: '检查电脑操作状态' }).click();
    const card = setup.getByRole('article', { name: '电脑操作状态' });

    if (process.platform === 'darwin') {
      await expect(card.getByRole('listitem')).toHaveCount(2);
      await expect(card.getByText(/当前运行的 Electron\.app/)).toBeVisible();
      for (const [theme, width] of [['dark', 920], ['light', 390], ['dark', 390]] as const) {
        await page.evaluate(value => (window as unknown as { setDesktopSetupFixtureTheme(theme: typeof value): void })
          .setDesktopSetupFixtureTheme(value), theme);
        await page.setViewportSize({ width, height: 580 });
        await expect.poll(() => card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await setup.screenshot({ path: info.outputPath(`desktop-setup-${theme}-${width}.png`), animations: 'disabled' });
      }
      const screenLink = card.getByRole('button', { name: '打开屏幕录制设置' });
      const accessibilityLink = card.getByRole('button', { name: '打开辅助功能设置' });
      expect(await app.evaluate(() => (globalThis as Fixture).desktopSetupFixture.requested)).toEqual([]);
      const accessibilityRequest = card.getByRole('button', { name: '请求辅助功能授权' });
      await accessibilityRequest.focus();
      await page.keyboard.press('Enter');
      await expect(card.getByRole('status')).toContainText('已向 macOS 请求授权');
      await expect(accessibilityRequest).toBeFocused();
      await card.getByRole('button', { name: '请求屏幕录制授权' }).click();
      await expect.poll(() => app!.evaluate(() => (globalThis as Fixture).desktopSetupFixture.requested))
        .toEqual(['accessibility', 'screenRecording']);
      await expect(card.getByRole('button', { name: '重新检测' })).toBeDisabled();
      expect(await page.evaluate(() => window.api.desktopSetup.requestPermission('accessibility')))
        .toEqual({ ok: false, code: 'request_in_progress' });
      await app.evaluate(() => (globalThis as Fixture).desktopSetupFixture.resolveScreenRequest());
      await expect(card.getByRole('status')).toContainText('已向 macOS 请求授权');
      await card.getByRole('button', { name: '在 Finder 中显示当前应用' }).click();
      const exe = await app.evaluate(({ app }) => app.getPath('exe'));
      expect(await app.evaluate(() => (globalThis as Fixture).desktopSetupFixture.revealed)).toEqual([path.resolve(exe, '../../..')]);
      expect(await page.evaluate(() => window.api.desktopSetup.requestPermission('custom:' as 'accessibility')))
        .toEqual({ ok: false, code: 'invalid_permission' });
      await screenLink.click();
      await accessibilityLink.click();
      await expect.poll(() => app!.evaluate(() => (globalThis as Fixture).desktopSetupFixture.opened)).toEqual([
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      ]);
      expect(await page.evaluate(() => window.api.desktopSetup.openSettings('custom:' as 'accessibility')))
        .toEqual({ ok: false, code: 'invalid_permission' });
      await app.evaluate(() => Object.assign((globalThis as Fixture).desktopSetupFixture.permissions, {
        screenRecording: true, accessibility: true
      }));
      const recheck = card.getByRole('button', { name: '重新检测' });
      await expect(recheck).toBeEnabled();
      await recheck.focus();
      await expect(recheck).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(card.getByRole('status')).toContainText('当前进程已检测到');
      await expect(recheck).toBeFocused();
      await expect(screenLink).toHaveCount(0);
      await app.evaluate(() => (globalThis as Fixture).desktopSetupFixture.sendFailure({
        ok: false, code: 'permission_required', permissions: ['accessibility'], source: 'driver'
      }));
      const notice = page.locator('.desktop-setup-notice');
      await expect(notice.getByRole('status')).toHaveText('桌面驱动未检测到 macOS 授权');
      await expect(notice.getByRole('button', { name: '打开辅助功能设置' })).toBeVisible();
      await expect(notice.getByRole('button', { name: '打开屏幕录制设置' })).toHaveCount(0);
      await expect(notice.getByRole('button', { name: '请求辅助功能授权' })).toHaveCount(0);
      const closeNotice = notice.getByRole('button', { name: '关闭电脑操作提示' });
      await expect(closeNotice).toBeInViewport({ ratio: 1 });
      await expect(notice.getByRole('button', { name: '重新检测' })).toBeInViewport({ ratio: 1 });
      await expect.poll(() => notice.locator('.desktop-setup-content').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await notice.screenshot({ path: info.outputPath('desktop-setup-notice-dark-390.png'), animations: 'disabled' });
      await closeNotice.click();
      await expect(notice).toHaveCount(0);
    } else {
      await expect(card.getByRole('status')).toHaveText('缺少桌面驱动');
      await expect(card.getByRole('button', { name: /打开.+设置/ })).toHaveCount(0);
      expect(await page.evaluate(() => window.api.desktopSetup.openSettings('accessibility')))
        .toEqual({ ok: false, code: 'unsupported_platform' });
      expect(await page.evaluate(() => window.api.desktopSetup.requestPermission('accessibility')))
        .toEqual({ ok: false, code: 'unsupported_platform' });
      expect(await page.evaluate(() => window.api.desktopSetup.revealApp()))
        .toEqual({ ok: false, code: 'unsupported_platform' });
      expect(await app.evaluate(() => (globalThis as Fixture).desktopSetupFixture.opened)).toEqual([]);
    }

    const externalWindowErrors = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const external = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: false, contextIsolation: true } });
      try {
        await external.loadURL('about:blank');
        return await external.webContents.executeJavaScript(`Promise.all([
          window.api.desktopSetup.status(),
          window.api.desktopSetup.openSettings('accessibility'),
          window.api.desktopSetup.requestPermission('accessibility'),
          window.api.desktopSetup.revealApp()
        ].map(request => request.then(() => '', error => error.message)))`);
      } finally { external.destroy(); }
    }, env.MUSTER_DESKTOP_SETUP_PRELOAD);
    expect(externalWindowErrors).toEqual([
      expect.stringContaining('Desktop setup is only available in the local workbench'),
      expect.stringContaining('Desktop setup is only available in the local workbench'),
      expect.stringContaining('Desktop setup is only available in the local workbench'),
      expect.stringContaining('Desktop setup is only available in the local workbench')
    ]);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
