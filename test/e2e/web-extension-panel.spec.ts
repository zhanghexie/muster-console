import { test, expect, _electron, chromium, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const panelSelector = 'iframe.ext-panel-frame[aria-label="扩展面板 工作日报"]';

async function openDailyReport(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('.app-shell').waitFor();
  const expand = page.getByRole('button', { name: '展开更多工具' });
  if (await expand.isVisible()) await expand.click();
  const dailyReport = page.getByRole('treeitem', { name: '工作日报', exact: true });
  await expect(dailyReport.locator('.extension-nav-icon-image')).toHaveCSS('mask-image', /^url\(/);
  await dailyReport.click();
  await expect(page.frameLocator(panelSelector).locator('#genStatus')).toContainText('当前工作区');
}

test('网页工作日报可交互、重载，关闭或断线只释放本连接的面板', async ({ request }, testInfo) => {
  const project = path.resolve(__dirname, '../..');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-web-daily-'));
  const profile = path.join(fixture, '.dev-sandbox', 'userData');
  const workspace = path.join(fixture, 'workspace');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({
    locale: 'zh-CN', workspaces: [], activeWorkspaceId: null,
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] }
  }));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `web-daily-${process.pid}`,
    MUSTER_WEB: '1', MUSTER_WEB_PORT: '0', MUSTER_WEB_HOST: '127.0.0.1'
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: fixture, env });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const desktop = await app.firstWindow();
    await desktop.locator('.app-shell').waitFor();
    const opened = await desktop.evaluate(root => window.api.workspaces.open({
      name: '远程工作日报', roots: [{ id: 'fixture', path: root }], defaultRootId: 'fixture', controlRootId: 'fixture'
    }), workspace);
    expect(opened.ok, opened.message).toBe(true);
    await desktop.evaluate(() => window.api.extensionCatalog.trust({ scope: 'global', extensionId: 'daily-report', mode: 'trusted-persistent' }));
    const status = await desktop.evaluate(() => window.api.webAccess.status());
    expect(status.running, status.disabledReason).toBe(true);

    browser = await chromium.launch({ args: ['--host-resolver-rules=MAP workbench.test 127.0.0.1', '--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const peer = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const peerPorts: string[] = [];
    peer.on('websocket', socket => peerPorts.push(new URL(socket.url()).port));
    await peer.addInitScript(() => {
      let gateway: WebSocket | undefined;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (new URL(this.url).pathname === '/ws') gateway = this;
        }
      };
      window.addEventListener('test:disconnect-gateway', () => gateway?.close());
    });
    const url = `http://workbench.test:${status.port}/?token=${encodeURIComponent(status.token)}`;
    const errors: string[] = [];
    const browserCalls: string[] = [];
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const frame = JSON.parse(String(payload)) as { channel?: string };
      if (frame.channel?.startsWith('browser:')) browserCalls.push(frame.channel);
    }));
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => {
      if (msg.type() === 'error' && /Content Security Policy|CORS policy/.test(msg.text())) errors.push(msg.text());
    });
    await openDailyReport(page, url);
    await openDailyReport(peer, url);

    const frame = page.frameLocator(panelSelector), peerFrame = peer.frameLocator(panelSelector);
    const frameUrl = await page.locator(panelSelector).getAttribute('src');
    const peerUrl = await peer.locator(panelSelector).getAttribute('src');
    const transport = `http://127.0.0.1:${status.port}`;
    const asset = new URL('../__sdk__/sdk.js', new URL(frameUrl!, transport));
    const ownToken = asset.pathname.split('/')[3];
    const sdk = await request.get(asset.href, { headers: { Origin: 'null' } });
    expect(sdk.ok()).toBe(true);
    expect(sdk.headers()).toMatchObject({ 'access-control-allow-origin': 'null', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
    await expect(frame.locator('.day-stamp')).toHaveCSS('font-family', /Georgia/);
    expect(await frame.locator('#genStatus').evaluate(async () => {
      const module = await import(new URL('../domain.mjs', location.href).href);
      return typeof module.createDomainRuntime;
    })).toBe('function');

    const foreign = await peer.evaluate(async token => Promise.all([
      window.api.extensionSurface.call({ token, method: 'domain.snapshot', args: [] }),
      window.api.extensionSurface.reloadExtension(token),
      window.api.extensionSurface.closeExtension(token)
    ].map(call => call.then(() => null, error => String(error)))), ownToken);
    expect(foreign).toEqual(Array(3).fill(expect.stringContaining('Extension view belongs to another client')));
    const detached = await page.evaluate(token => window.api.workbench.panelPlacement({ token, placement: 'window' })
      .then(() => null, error => String(error)), ownToken);
    expect(detached).toContain('网页访问不支持通道');

    await frame.locator('#todoText').fill('浏览器新建待办');
    await frame.getByRole('button', { name: '添加', exact: true }).click();
    const todo = frame.locator('.todo-item').filter({ hasText: '浏览器新建待办' });
    await expect(todo).toBeVisible();
    await expect(peerFrame.locator('.todo-item').filter({ hasText: '浏览器新建待办' })).toBeVisible();

    const controls = page.locator('.ext-panel-statusbar').filter({ hasText: '工作日报' });
    await expect(controls.locator('.ext-panel-meta > span[aria-hidden="true"]')).toHaveCSS('mask-image', /^url\(/);
    await controls.getByRole('button', { name: '重载', exact: true }).click();
    await expect(page.locator(panelSelector)).toHaveAttribute('src', /__ma_reload=1/);
    await expect(todo).toBeVisible();
    await peerFrame.locator('#todoText').fill('重载后收到的待办');
    await peerFrame.getByRole('button', { name: '添加', exact: true }).click();
    await expect(frame.locator('.todo-item').filter({ hasText: '重载后收到的待办' })).toBeVisible();
    expect((await page.evaluate(() => window.api.themes.activate('dark'))).ok).toBe(true);
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: testInfo.outputPath('web-daily-report.png') });

    await peer.evaluate(() => window.dispatchEvent(new Event('test:disconnect-gateway')));
    await expect.poll(async () => (await request.head(new URL(peerUrl!, transport).href)).status()).toBe(401);
    await expect(peerFrame.locator('.todo-item').filter({ hasText: '重载后收到的待办' })).toBeVisible({ timeout: 15_000 });
    await expect(peer.locator(panelSelector)).not.toHaveAttribute('src', peerUrl!);
    expect(peerPorts).toEqual(Array(2).fill(String(status.port)));
    const reconnectedUrl = await peer.locator(panelSelector).getAttribute('src');
    await peer.close();
    await expect.poll(async () => (await request.head(new URL(reconnectedUrl!, transport).href)).status()).toBe(401);
    await todo.getByRole('button', { name: '已完成', exact: true }).click();
    await expect(frame.locator('[data-stat="open-todos"] .stat-value')).toHaveText('1');
    const done = frame.locator('[data-g="done"]');
    if (await done.getAttribute('aria-expanded') === 'false') await done.press('Enter');
    await expect(todo.getByRole('button', { name: '已完成', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect((await page.evaluate(() => window.api.themes.activate('light'))).ok).toBe(true);
    await page.setViewportSize({ width: 1080, height: 760 });
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.screenshot({ path: testInfo.outputPath('web-daily-report-light-narrow.png') });
    await controls.getByRole('button', { name: '关闭面板', exact: true }).click();
    await expect(page.locator(panelSelector)).toHaveCount(0);
    await expect.poll(async () => (await request.head(asset.href, { headers: { Authorization: `Bearer ${status.token}` } })).status()).toBe(401);
    expect(browserCalls).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await app.close().catch(() => {});
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
