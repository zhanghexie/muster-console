import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

test('右侧标签右键全屏：原生网页保活、顶栏自动隐藏与 guest Esc', async ({}, info) => {
  test.setTimeout(80_000);
  const project = path.resolve(__dirname, '../..'), cwd = info.outputDir, root = path.join(cwd, 'workspace');
  const profile = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(root, 'test.txt'), 'fullscreen file');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'right-full',
    workspaces: [{ id: 'right-full', name: 'Fullscreen', path: root, accentOff: true }], webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(profile, 'sessions.json'), '[]');
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>全屏网页</title><body style="font:18px system-ui;padding:40px;background:#dce7ff"><h1>右侧网页全屏</h1><input id="draft"><div style="height:1800px"></div>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `right-full-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project], cwd, env });
  try {
    const win = await app.firstWindow(); win.setDefaultTimeout(10_000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await win.locator('.app-shell').waitFor({ timeout: 35_000 });
    await win.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    const opened = await win.evaluate(url => window.api.browser.open({ url, workspaceId: 'right-full', scope: 'workspace' }), url);
    const webview = win.locator(`webview[data-tab-id="${opened.id}"]`);
    await expect(webview).toBeVisible();
    const guestId = await webview.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('Boolean(document.getElementById("draft"))'), guestId)).toBe(true);
    // Activate the actually visible right-page peek before addressing its tabs.
    await win.mouse.click(await win.evaluate(() => innerWidth - 20), 200);
    await expect(win.locator('.main-view')).toHaveClass(/\bh-git\b/);
    await expect.poll(() => win.locator('.h-strip').evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.getElementById("draft").value="保留网页草稿"'), guestId);
    const parent = await webview.evaluateHandle(element => element.parentElement);
    await win.getByRole('tab', { name: '文件', exact: true }).click();
    await win.locator('.right-files-resources').getByTitle('test.txt', { exact: true }).dblclick();
    const fileTab = win.locator('.right-tab').filter({ hasText: 'test.txt' });
    await expect(fileTab).toHaveAttribute('aria-selected', 'true');
    const webTab = win.locator('.right-tab').filter({ hasText: '全屏网页' });
    await webTab.click();
    const output = path.join(project, '.tmp/ui-captures/right-tabs-fullscreen'); fs.mkdirSync(output, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await win.evaluate(theme => window.api.themes.activate(theme), theme);
      await expect.poll(() => win.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
      const originalBounds = await win.locator('.right-workspace').boundingBox();
      await webTab.click({ button: 'right' });
      await expect.poll(() => win.getByRole('menu').evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
      const menuPixels = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG());
      fs.writeFileSync(path.join(output, `${theme}-menu.png`), Buffer.from(menuPixels));
      await win.getByRole('menuitemcheckbox', { name: '全屏显示', exact: true }).click();
      await expect(win.locator('.right-workspace')).toHaveClass(/is-tab-fullscreen/);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
      await expect.poll(() => win.locator('.right-workspace').evaluate(element => {
        const r = element.getBoundingClientRect(); return Math.abs(r.x) + Math.abs(r.y) + Math.abs(r.width - innerWidth) + Math.abs(r.height - innerHeight);
      })).toBeLessThan(1);
      await expect.poll(() => win.locator('.right-workspace-toolbar').evaluate(element => Number(getComputedStyle(element).opacity))).toBe(0);
      expect(await webview.evaluate((element, parent) => element.parentElement === parent, parent)).toBe(true);
      const screenshot = async (name: string) => {
        await expect.poll(() => win.locator('.right-workspace').evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity))).toBe(false);
        const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG());
        fs.writeFileSync(path.join(output, `${theme}-${name}.png`), Buffer.from(bytes));
      };
      await screenshot('fullscreen');
      await win.locator('.right-fullscreen-hotzone').hover();
      await expect.poll(() => win.locator('.right-workspace-toolbar').evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
      await screenshot('toolbar');
      await fileTab.click();
      await expect(win.locator('.right-workspace')).toHaveClass(/is-tab-fullscreen/);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
      await expect(win.locator('.right-workspace-toolbar')).toHaveAttribute('data-mp-stage', 'in');
      await expect(win.locator('.right-content-page.is-shown .file-editor')).toBeVisible();
      await expect(win.locator('.right-content-page.is-shown .file-editor')).toContainText('fullscreen file');
      await win.mouse.move(100, 200);
      await expect.poll(() => win.locator('.right-workspace-toolbar').evaluate(element => Number(getComputedStyle(element).opacity))).toBe(0);
      await screenshot('file-fullscreen');
      await win.locator('.right-fullscreen-hotzone').hover();
      await expect.poll(() => win.locator('.right-workspace-toolbar').evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
      await webTab.click();
      await expect(webview).toBeVisible();
      await expect(win.locator('.right-workspace')).toHaveClass(/is-tab-fullscreen/);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
      await screenshot('switched-back');
      if (theme === 'dark') await win.getByRole('button', { name: '退出全屏', exact: true }).click();
      else {
        await webview.evaluate(element => (element as Electron.WebviewTag).focus());
        await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }), guestId);
      }
      await expect(win.locator('.right-workspace')).not.toHaveClass(/is-tab-fullscreen/);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
      await expect(win.locator('.main-view')).toHaveClass(/\bh-git\b/);
      await expect.poll(() => win.locator('.h-strip').evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
      const restoredBounds = await win.locator('.right-workspace').boundingBox();
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(restoredBounds![key] - originalBounds![key])).toBeLessThan(1);
      expect(await webview.evaluate(element => (element as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
      expect(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.getElementById("draft").value'), guestId)).toBe('保留网页草稿');
      await screenshot('restored');
    }
  } finally {
    await app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); }).catch(() => {});
    await app.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
