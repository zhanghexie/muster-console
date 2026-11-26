import { test, expect } from './fixtures/electron';
import http from 'node:http';

test.use({ isolatedSandbox: true });

test('provider catalog refresh uses real IPC, replaces candidates and preserves configured/default models', async ({ appCtx }, info) => {
  let mode: 'normal' | 'error' | 'empty' = 'normal';
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    expect(req.headers.authorization).toBe('Bearer catalog-fixture-key');
    if (mode === 'error') { res.writeHead(401).end('Invalid fixture credentials'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: mode === 'empty' ? [] : [{ id: 'server-new' }, { id: 'server-long-model-name-for-narrow-window-layout' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const llm = { activeProviderId: 'catalog-fixture', activeModelId: 'configured', providers: [{ id: 'catalog-fixture', name: 'Catalog fixture',
    baseUrl, apiKey: 'catalog-fixture-key', enabled: true, models: [{ id: 'configured', name: 'Configured default' }] }] };
  try {
    const win = appCtx.win;
    await win.evaluate(async value => { await window.api.config.update({ llm: value }); }, llm);
    await win.reload(); await win.locator('.app-shell').waitFor();
    const openModels = async () => {
      await win.getByRole('button', { name: '设置', exact: true }).first().click();
      await win.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '模型与输入', exact: true }).click();
    };
    await openModels();
    const refresh = win.getByRole('button', { name: '刷新目录', exact: true });
    await expect(refresh).toBeEnabled(); expect(requests).toHaveLength(0);
    await refresh.click();
    await expect(win.getByRole('button', { name: '从目录添加（2）' })).toBeVisible();
    expect(requests).toEqual(['/v1/models']);
    await win.getByRole('button', { name: '从目录添加（2）' }).click();
    await expect(win.getByRole('button', { name: 'server-new', exact: true })).toBeVisible();
    await win.locator('.llm-add-model-row').screenshot({ path: info.outputPath('catalog-refreshed.png') });
    expect((await win.evaluate(() => window.api.config.get())).llm).toEqual(expect.objectContaining(llm));

    mode = 'error'; await refresh.click();
    await expect(win.getByRole('alert').filter({ hasText: 'HTTP 401' })).toBeVisible();
    await expect(win.getByRole('button', { name: 'server-new', exact: true })).toBeVisible();
    await expect(refresh).toBeEnabled();
    mode = 'empty'; await refresh.click();
    await expect(win.getByRole('button', { name: '从目录添加（0）' })).toBeVisible();
    await expect(win.getByText('目录中没有尚未添加的模型。')).toBeVisible();
    await expect(win.getByRole('button', { name: 'server-new', exact: true })).toHaveCount(0);
    expect((await win.evaluate(() => window.api.config.get())).llm?.activeModelId).toBe('configured');

    // Reload reads persisted cache through the real preload; it never fetches implicitly.
    const count = requests.length;
    await win.reload(); await win.locator('.app-shell').waitFor();
    await openModels();
    await expect(win.getByRole('button', { name: '从目录添加（0）' })).toBeVisible();
    expect(requests).toHaveLength(count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('an unlisted model uses the automatic input defaults in settings and Core', async ({ appCtx }, info) => {
  const { app, win } = appCtx;
  const llm = {
    activeProviderId: 'fixture-unlisted', activeModelId: 'unlisted-model',
    providers: [{ id: 'fixture-unlisted', name: 'Unlisted fixture',
      baseUrl: 'https://unlisted.example/v1', apiKey: '',
      models: [{ id: 'unlisted-model', name: 'Unlisted model' }] }]
  };
  for (const themeId of ['dark', 'light']) {
    await win.evaluate(async patch => { await window.api.config.update(patch); }, { llm, locale: 'zh-CN' as const, themeId });
    await win.reload();
    await win.locator('.app-shell').waitFor();
    await expect(win.locator('html')).toHaveAttribute('data-theme', themeId);
    const context = await win.evaluate(() => window.api.chat.context());
    expect(context).toMatchObject({ provider: llm.activeProviderId, modelId: llm.activeModelId,
      contextWindow: 1_000_000, supportsImages: true });

    await win.getByRole('button', { name: '设置', exact: true }).first().click();
    await win.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '模型与输入', exact: true }).click();
    const row = win.locator('.llm-model-row-item').filter({ has: win.getByText('unlisted-model', { exact: true }) });
    await expect(row.getByText('1M')).toBeVisible();
    await expect(row.getByText('多模态')).toBeVisible();
    await row.getByTitle('编辑模型配置').click();
    const dialog = win.locator('.llm-model-dialog');
    await expect(dialog.getByLabel('上下文窗口')).toHaveValue('1000000');
    await dialog.getByRole('button', { name: /高级$/ }).click();
    const images = dialog.getByRole('checkbox', { name: '支持图片输入（多模态）' });
    await expect(images).toBeChecked();
    if (themeId === 'light') {
      const browserWindow = await app.browserWindow(win);
      const minimumWidth = await browserWindow.evaluate(window => {
        const [width] = window.getMinimumSize();
        window.setContentSize(width, 800);
        return width;
      });
      await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(minimumWidth);
      await images.uncheck();
      await expect(dialog.getByRole('button', { name: '恢复默认', exact: true })).toBeVisible();
    }
    await dialog.screenshot({ path: info.outputPath(`automatic-model-input-${themeId}.png`), animations: 'disabled' });
    if (themeId === 'light') {
      await dialog.getByRole('button', { name: '恢复默认', exact: true }).click();
      await expect(images).toBeChecked();
    }
  }
});
