import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('会话链接在工作台打开，右键通过真实 IPC 选择系统打开', async ({}, info) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir, root = path.join(cwd, 'workspace'), userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  const file = path.join(root, 'report #1.md');
  const targetLine = '第 16 行定位目标';
  const lines = Array.from({ length: 48 }, (_, index) => `示例正文 ${index + 1}`);
  lines[0] = '# 会话文件预览';
  lines[1] = '';
  lines[15] = targetLine;
  fs.writeFileSync(file, lines.join('\n'));
  const fileHref = encodeURI(file.replaceAll('\\', '/')).replaceAll('#', '%23');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'chat-links', defaultCwd: root,
    workspaces: [{ id: 'chat-links', name: '会话链接测试', path: root }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  const sessionId = 'aa02e75a-4f2d-4708-84e7-d45dc21076ba';
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{
    id: sessionId, type: 'terminal', launchKind: 'agent', runtime: 'pi', name: '链接会话',
    workspaceId: 'chat-links', cwd: root, createdAt: Date.now(), lifecycle: 'idle'
  }]));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>会话链接网页</title><h1>内置浏览器链接测试</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${base}/target`;
  const history = path.join(userData, 'agent-sessions'); fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, `${sessionId}.json`), JSON.stringify({ version: 2, messages: [{
    id: 'chat-link-fixture', role: 'user', ts: Date.now(),
    parts: [{ kind: 'text', text: `[预览网页](${url})\n\n[本地文档](report%20%231.md)` }]
  }, {
    id: 'chat-line-link-fixture', role: 'assistant', ts: Date.now(),
    parts: [{ kind: 'text', text: `[查看第 16 行](${fileHref}:16)` }]
  }] }));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `chat-links-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
  const shots = path.join(project, '.tmp/ui-captures/chat-link-navigation'); fs.mkdirSync(shots, { recursive: true });
  try {
    await app.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0].setSize(1500, 920);
      const calls: Array<{ kind: string; target: string }> = [];
      (globalThis as any).__chatLinkShellCalls = calls;
      shell.openPath = async target => { calls.push({ kind: 'file', target }); return ''; };
      shell.openExternal = async target => { calls.push({ kind: 'web', target }); };
      shell.showItemInFolder = target => { calls.push({ kind: 'reveal', target }); };
    });
    const win = await app.firstWindow();
    const pageErrors: string[] = []; win.on('pageerror', error => pageErrors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await expect(win.getByTestId('confirm-mask')).toHaveCount(0);
    await win.evaluate(async id => window.api.sessions.select(id), sessionId);
    const chat = win.locator(`.agent-chat-view[data-session-id="${sessionId}"]`);
    const webLink = chat.getByRole('link', { name: '预览网页' });
    const fileLink = chat.getByRole('link', { name: /本地文档/ });
    await expect(webLink).toBeVisible({ timeout: 25_000 }); await expect(fileLink).toBeVisible();

    try { await fileLink.click({ button: 'right', timeout: 8_000 }); }
    catch (error) {
      const mask = win.getByTestId('confirm-mask');
      if (await mask.isVisible().catch(() => false)) throw new Error(`Unexpected confirmation: ${await mask.innerText()}`);
      throw error;
    }
    await expect(win.getByRole('menuitemcheckbox', { name: '在系统默认应用中打开' })).toBeVisible();
    await win.screenshot({ path: path.join(shots, 'dark-file-menu.png') });
    await win.getByRole('menuitemcheckbox', { name: '在系统默认应用中打开' }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__chatLinkShellCalls)).toContainEqual({ kind: 'file', target: file });

    await win.evaluate(async () => window.api.themes.activate('light'));
    await expect.poll(() => win.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
    await webLink.click({ button: 'right' });
    await expect(win.getByRole('menuitemcheckbox', { name: '在系统浏览器中打开' })).toBeVisible();
    await win.screenshot({ path: path.join(shots, 'light-web-menu.png') });
    await win.getByRole('menuitemcheckbox', { name: '在系统浏览器中打开' }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__chatLinkShellCalls)).toContainEqual({ kind: 'web', target: url });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
    await fileLink.click({ button: 'right' });
    const menu = win.getByRole('menu');
    await expect(menu).toBeVisible();
    const bounds = (await menu.boundingBox())!, viewportWidth = await win.evaluate(() => window.innerWidth);
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewportWidth);
    await win.screenshot({ path: path.join(shots, 'light-narrow-file-menu.png') });
    await win.keyboard.press('Escape');
    await fileLink.click();
    await expect(win.locator('.right-content-page.is-shown .file-editor')).toContainText('会话文件预览', { timeout: 20_000 });

    // Switch back to the chat and open the localhost URL in the real webview.
    await win.keyboard.press('Control+Shift+Backslash');
    await expect(webLink).toBeVisible();
    await webLink.click();
    const view = win.locator('.right-content-page.is-shown webview');
    await expect(view).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => {
      const id = await view.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
      return app.evaluate(async ({ webContents }, guestId) => webContents.fromId(guestId)?.executeJavaScript('document.title'), id);
    }, { timeout: 20_000 }).toBe('会话链接网页');

    await win.keyboard.press('Control+Shift+Backslash');
    await chat.getByRole('link', { name: '查看第 16 行' }).click();
    const activeLine = win.locator('.right-content-page.is-shown .file-editor .cm-line.cm-activeLine');
    await expect(activeLine).toHaveText(targetLine);
    await expect(activeLine).toBeInViewport();
    await win.screenshot({ path: path.join(shots, 'file-line-16.png') });
    expect(pageErrors).toEqual([]);
  } finally {
    const owned = app.process();
    // This fixture owns the entire isolated application; do not leave a pending
    // Electron close request when the application prevents normal window close.
    if (owned.exitCode === null && owned.signalCode === null && owned.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(owned.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
      } else owned.kill('SIGKILL');
    }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
