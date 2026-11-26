import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const { PNG } = require('playwright-core/lib/utilsBundle');

test('HTML 文件预览首次打开和切回均绘制实际像素', async ({}, info) => {
  test.setTimeout(65_000);
  const project = path.resolve(__dirname, '../..'), cwd = info.outputDir;
  const root = path.join(cwd, 'workspace'), userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(root, 'paint.html'), '<!doctype html><style>html,body{margin:0;min-height:100vh}body{background:linear-gradient(90deg,rgb(12,148,88) 50%,rgb(180,36,88) 50%);color:white;font:20px system-ui}h1{padding:16px}button{position:absolute;left:12px;top:110px}</style><h1>PREVIEW PAINT OK</h1><button onclick="this.textContent=Number(this.textContent)+1">0</button>');
  fs.writeFileSync(path.join(root, 'other.txt'), 'switch away from the HTML iframe');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'paint',
    workspaces: [{ id: 'paint', name: 'Paint test', path: root }], webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `paint-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env, timeout: 35_000 });
  const output = path.join(project, '.tmp/ui-captures/html-preview-paint'); fs.mkdirSync(output, { recursive: true });
  try {
    const win = await app.firstWindow(); await win.locator('.app-shell').waitFor({ timeout: 35_000 });
    await win.evaluate(() => localStorage.setItem('muster.hSwitchMode', 'click'));
    await win.reload();
    await win.locator('.app-shell').waitFor({ timeout: 35_000 });
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1400, 900); window.show(); window.focus(); });
    const session = await win.evaluate(async root => {
      const request = { runtime: 'pi', force: true, cwd: root, workspaceId: 'paint', name: 'HTML paint' };
      return window.api.sessions.create(request);
    }, root);
    await win.evaluate(async id => window.api.sessions.select(id), session.id);
    await win.keyboard.press('Escape'); await win.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    const pane = win.locator('.right-workspace'); await expect(pane).toBeVisible();
    await pane.getByRole('tablist', { name: '资源面板' }).getByRole('tab', { name: '文件', exact: true }).click();
    const row = (name: string) => pane.locator(`.right-resource-page.is-shown .file-tree-row[title="${name}"]`);
    for (const phase of ['first-dark', 'return-light', 'narrow-light']) {
      if (phase !== 'first-dark') {
        await row('other.txt').click(); await expect(pane.locator('.cm-content:visible')).toContainText('switch away');
        await win.evaluate(() => window.api.themes.activate('light'));
      }
      if (phase === 'narrow-light') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 760));
      await row('paint.html').click();
      const frame = pane.locator('iframe.file-editor-preview-html:visible'); await expect(frame).toBeVisible();
      await expect(win.frameLocator('iframe.file-editor-preview-html:visible').locator('h1')).toHaveText('PREVIEW PAINT OK');
      // Capture the containing Electron window's pixels, not just the iframe DOM.
      await expect.poll(async () => {
        const rect = (await frame.boundingBox())!;
        const data = await app.evaluate(async ({ BrowserWindow }, rect) => (await BrowserWindow.getAllWindows()[0].capturePage({
          x: Math.ceil(rect.x), y: Math.ceil(rect.y), width: Math.floor(rect.width - 1), height: Math.floor(rect.height - 1)
        })).toPNG().toString('base64'), rect);
        const buffer = Buffer.from(data, 'base64'), png = PNG.sync.read(buffer);
        const y = Math.min(160, png.height - 10);
        const pixel = (fraction: number) => Array.from(png.data.subarray((y * png.width + Math.floor(png.width * fraction)) * 4, (y * png.width + Math.floor(png.width * fraction)) * 4 + 3));
        fs.writeFileSync(path.join(output, `${phase}.png`), buffer);
        return [pixel(0.25), pixel(0.75)];
      }, { timeout: 8_000 }).toEqual([[12, 148, 88], [180, 36, 88]]);
      if (phase === 'first-dark') {
        const button = win.frameLocator('iframe.file-editor-preview-html:visible').getByRole('button');
        const strip = win.locator('.h-strip');
        const waitForSlide = () => strip.evaluate(async el => {
          await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
        });
        await win.keyboard.press('Control+Shift+Backslash');
        await expect(win.locator('.main-view')).toHaveClass(/\bh-terminal\b/);
        await waitForSlide();
        const hit = (await button.boundingBox())!;
        await win.mouse.click(hit.x + hit.width / 2, hit.y + hit.height / 2);
        await expect(win.locator('.main-view')).toHaveClass(/\bh-git\b/);
        await waitForSlide();
        await expect(button).toHaveText('0');
        await button.click();
        await expect(button).toHaveText('1');
      }
    }
  } finally { await app.close(); }
});
