import { test, expect, _electron, chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// A non-loopback hostname mapped to localhost is a genuinely insecure HTTP origin.
// Each run owns its app, workspace, credentials, browser and port.
test('普通 HTTP 远程工作台可打开文件、搜索、加载会话历史和访问收藏', async () => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'web-uuid-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox', 'userData');
  const workspace = path.join(fixture, 'remote-workspace');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'hello-remote.txt'), 'Hello from remote HTTP');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', workspaces: [], activeWorkspaceId: null,
    openai: { baseUrl: '', apiKey: '', model: '' },
    mcp: { enabled: false, servers: [] }
  }));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `web-uuid-${process.pid}`,
    MUSTER_WEB: '1', MUSTER_WEB_PORT: '0', MUSTER_WEB_HOST: '127.0.0.1'
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP workbench.test 127.0.0.1', '--no-proxy-server'] });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const opened = await win.evaluate(async root => (window as any).api.workspaces.open({
      name: '远程测试', roots: [{ id: 'fixture', path: root }], defaultRootId: 'fixture', controlRootId: 'fixture'
    }), workspace);
    expect(opened.ok, opened.message).toBe(true);
    const bookmarkUrl = 'https://bookmark.test/remote';
    const saved = await win.evaluate(({ id, url }) => window.api.workspaceBookmarks.change(id, {
      kind: 'add', parentId: null, node: { id: 'remote-test-bookmark', label: '远程收藏验收', url }
    }), { id: opened.activeWorkspaceId, url: bookmarkUrl });
    expect(saved.ok).toBe(true);
    const status = await win.evaluate(() => (window as any).api.webAccess.status());
    expect(status.running, status.disabledReason).toBe(true);
    const gatewayResponse = await fetch(`http://127.0.0.1:${status.port}/?token=${encodeURIComponent(status.token)}`);
    expect(gatewayResponse.status).toBe(200);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(12_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://workbench.test:${status.port}/?token=${encodeURIComponent(status.token)}`);
    expect(await page.evaluate(() => ({ secure: window.isSecureContext, randomUUID: typeof crypto.randomUUID, randomValues: typeof crypto.getRandomValues })))
      .toEqual({ secure: false, randomUUID: 'undefined', randomValues: 'function' });
    const socketStatus = await page.evaluate(({ port, token }) => new Promise<string>(resolve => {
      const socket = new WebSocket(`ws://workbench.test:${port}/ws?token=${encodeURIComponent(token)}`);
      const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 5000);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('open'); };
      socket.onerror = () => { clearTimeout(timer); resolve('error'); };
      socket.onclose = event => { clearTimeout(timer); resolve(`closed:${event.code}`); };
    }), { port: status.port, token: status.token });
    expect(socketStatus).toBe('open');
    await page.locator('.app-shell').waitFor({ timeout: 30_000 });

    const expand = page.getByTitle('展开右侧栏', { exact: true });
    if (await expand.isVisible()) await expand.click();
    const side = page.locator('.side-tools-panel');
    await side.getByRole('tab', { name: '文件', exact: true }).click();
    const files = side.locator('.files-panel.is-shown');
    await side.getByRole('tree', { name: 'remote-workspace', exact: true }).getByText('hello-remote.txt', { exact: true }).click();
    await expect(files.locator('.cm-content')).toContainText('Hello from remote HTTP');
    await expect(page.getByText(/工作台崩溃/)).toHaveCount(0);

    await side.getByRole('button', { name: '搜索文件', exact: true }).click();
    const palette = page.getByRole('dialog', { name: '搜索', exact: true });
    await palette.getByRole('combobox').fill('hello-remote');
    await expect(palette.getByRole('option').filter({ hasText: 'hello-remote.txt' })).toBeVisible();
    await palette.getByRole('combobox').press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(files.locator('.cm-content')).toContainText('Hello from remote HTTP');
    expect(errors.filter(message => /randomUUID/i.test(message))).toEqual([]);

    await page.screenshot({ path: test.info().outputPath('remote-http-dark.png') });
    expect((await page.evaluate(async () => (window as any).api.themes.activate('light'))).ok).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.screenshot({ path: test.info().outputPath('remote-http-light.png') });
    await page.reload();
    await page.locator('.app-shell').waitFor({ timeout: 30_000 });
    await expect(page.getByText(/工作台崩溃/)).toHaveCount(0);
    expect(errors.filter(message => /randomUUID/i.test(message))).toEqual([]);

    const session = await page.evaluate(() => window.api.sessions.create({
      name: '远程历史验收', runtime: 'pi', force: true
    }));
    const history = await page.evaluate(id => window.api.agentSession.historyRange(id, undefined, 120), session.id);
    expect(history).toMatchObject({ messages: [], total: 0, hasEarlier: false });
    const chat = page.locator(`.agent-chat-view[data-session-id="${session.id}"]`);
    await expect(chat).toBeVisible();
    await expect(chat.getByText(/\[ipc\] 无此通道/)).toHaveCount(0);

    const browserAction = await page.evaluate(url => window.api.browser.open({ url }).then(() => null, error => error.message), bookmarkUrl);
    expect(browserAction).toBe('内置浏览器仅在 Muster 桌面应用中可用。请在桌面应用中继续此操作。');
    await side.getByRole('tab', { name: '浏览器', exact: true }).click();
    const bookmark = side.getByRole('link', { name: '远程收藏验收' });
    await expect(bookmark).toBeVisible();
    const context = page.context();
    await context.route(bookmarkUrl, route => route.fulfill({ body: 'Remote bookmark destination' }));
    await bookmark.focus();
    const [tab] = await Promise.all([context.waitForEvent('page'), bookmark.press('Enter')]);
    await expect(tab.getByText('Remote bookmark destination')).toBeVisible();
    expect(await tab.evaluate(() => window.opener === null)).toBe(true);
    await tab.close();
    await page.bringToFront();

    const bookmarks = side.locator('.right-bookmarks');
    await bookmarks.screenshot({ path: test.info().outputPath('remote-bookmarks-light.png') });
    expect((await page.evaluate(() => window.api.themes.activate('dark'))).ok).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.setViewportSize({ width: 1000, height: 760 });
    await expect(bookmark).toBeVisible();
    await bookmarks.screenshot({ path: test.info().outputPath('remote-bookmarks-dark-narrow.png') });
    await bookmarks.getByRole('button', { name: '打开主页' }).click();
    await expect(page.getByText(browserAction, { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('remote-browser-desktop-hint.png') });
  } finally {
    await browser.close();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
