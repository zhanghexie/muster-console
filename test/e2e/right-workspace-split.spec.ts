import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { buildSync } from 'esbuild';
import type { PanelFocusResponse, PanelRightLayoutResponse, PanelSnapshotResponse } from '../../src/shared/panelState';

test('right split keeps a file and native webpages live through layout changes', async ({}, info) => {
  test.setTimeout(60_000);
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir;
  const root = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'Static file preview for the split pane.\n');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'split',
    workspaces: [{ id: 'split', name: 'Split workspace', path: root, accentOff: true }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `right-split-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];

  const server = http.createServer((req, res) => {
    const name = req.url === '/second' ? 'Second page' : 'First page';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${name}</title><main style="padding: 12px; font: 16px system-ui"><h1>${name}</h1><label>Notes <input id="draft"></label></main>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env }).catch(error => {
    server.close();
    throw error;
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 880));
    await page.locator('.app-shell').waitFor();
    await page.evaluate(() => localStorage.setItem('muster.hSwitchMode', 'click'));
    await page.reload();
    await page.locator('.app-shell').waitFor();
    await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    const pane = page.locator('.right-workspace');
    await expect(page.locator('.main-view')).toHaveClass(/\bh-git\b/);
    const open = (url: string) => page.evaluate(url => window.api.browser.open({ url, workspaceId: 'split', scope: 'workspace' }), url);
    const nativeId = async (guest: ReturnType<typeof pane.locator>) => {
      const read = () => guest.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
      await expect.poll(async () => { try { return await read(); } catch { return 0; } }).toBeGreaterThan(0);
      return read();
    };
    const first = pane.locator(`webview[data-tab-id="${(await open(origin + '/first')).id}"]`);
    await expect(first).toHaveAttribute('data-browser-presentation', 'foreground');
    const firstId = await nativeId(first);
    const second = pane.locator(`webview[data-tab-id="${(await open(origin + '/second')).id}"]`);
    await expect(second).toHaveAttribute('data-browser-presentation', 'foreground');
    const secondId = await nativeId(second);
    await pane.getByRole('tab', { name: '文件', exact: true }).click();
    await pane.locator('.file-tree-row[title="notes.txt"]').dblclick();
    const file = pane.locator('.files-panel.is-shown');
    await expect(file).toContainText('Static file preview');
    const resourceDivider = pane.getByRole('separator', { name: '调整资源面板宽度' });
    const resourceLine = resourceDivider.locator('.split-pane-handle-line');
    const resourceGeometry = () => resourceDivider.evaluate(handle => {
      const { left, right } = handle.querySelector('.split-pane-handle-line')!.getBoundingClientRect();
      const content = handle.nextElementSibling!.getBoundingClientRect();
      const resources = handle.previousElementSibling!.getBoundingClientRect();
      return { center: (left + right) / 2, seam: (content.right + resources.left) / 2, gap: resources.left - content.right };
    });
    await expect(resourceLine).toHaveCSS('width', '1px');
    const resourceStart = await resourceGeometry();
    expect(resourceStart.gap).toBeCloseTo(4);
    expect(resourceStart.center).toBeCloseTo(resourceStart.seam);
    const resourceBox = (await resourceDivider.boundingBox())!;
    const resourceY = resourceBox.y + resourceBox.height / 3;
    await page.mouse.move(resourceStart.center, resourceY);
    await expect(resourceLine).toHaveCSS('width', '3px');
    await page.mouse.down();
    await page.mouse.move(resourceStart.center - 32, resourceY, { steps: 4 });
    await expect.poll(async () => (await resourceGeometry()).center).toBeLessThan(resourceStart.center - 28);
    await expect(resourceLine).toHaveCSS('width', '3px');
    await page.mouse.up();
    await expect(resourceLine).toHaveCSS('width', '3px');
    await page.mouse.move(resourceStart.center - 60, resourceY);
    await expect(resourceLine).toHaveCSS('width', '1px');
    await pane.getByRole('button', { name: '选择分屏布局' }).click();
    await page.getByTestId('right-snap-cell-focus-0').click();
    await pane.locator('[data-right-split-slot="1"]').getByRole('button', { name: 'First page' }).click();
    await pane.locator('[data-right-split-slot="2"]').getByRole('button', { name: 'Second page' }).click();
    await expect(first).toHaveAttribute('data-browser-presentation', 'foreground');
    await expect(second).toHaveAttribute('data-browser-presentation', 'foreground');
    await expect(file).toBeVisible();
    const webResource = await resourceGeometry();
    expect(webResource.gap).toBeCloseTo(0);
    expect(webResource.center).toBeCloseTo(webResource.seam);

    const rows = pane.getByRole('toolbar', { name: '当前内容工具' });
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('notes.txt');
    await rows.nth(0).getByRole('button', { name: '编辑', exact: true }).click();
    await expect(file.locator('.cm-content')).toBeVisible();
    await expect(pane.locator('.right-tab[aria-selected="true"]')).toContainText('notes.txt');
    await expect(rows.nth(1).getByRole('textbox', { name: '地址栏' })).toHaveValue(origin + '/first');
    await expect(rows.nth(2).getByRole('textbox', { name: '地址栏' })).toHaveValue(origin + '/second');
    const fileBox = (await file.boundingBox())!;
    const firstBox = (await first.boundingBox())!;
    const secondBox = (await second.boundingBox())!;
    expect(Math.abs(fileBox.x + fileBox.width - firstBox.x)).toBeLessThan(2);
    expect(Math.abs(firstBox.y + firstBox.height - secondBox.y + (await rows.nth(2).boundingBox())!.height)).toBeLessThan(2);
    expect(await nativeId(first)).toBe(firstId);
    expect(await nativeId(second)).toBe(secondId);
    await expect.poll(() => app.evaluate(({ webContents }, id) =>
      webContents.fromId(id)?.executeJavaScript('document.title'), firstId)).toBe('First page');
    await first.click({ position: { x: 90, y: 111 } });
    await expect(pane.locator('.right-tab[aria-selected="true"]')).toContainText('First page');
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.querySelector("#draft").value = "retained"'), firstId);
    const divider = page.getByTestId('right-split-divider');
    await divider.focus();
    await expect(divider).toBeFocused();
    const dividerLine = divider.locator('span');
    await expect(dividerLine).toHaveCSS('width', '1px');
    const dividerBox = (await divider.boundingBox())!;
    const x = dividerBox.x + dividerBox.width / 2, y = dividerBox.y + dividerBox.height / 4;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="separator"]')?.getAttribute('data-testid'), { x, y })).toBe('right-split-divider');
    await page.mouse.move(x, y);
    await expect(dividerLine).toHaveCSS('width', '3px');
    await page.mouse.down();
    await expect.poll(() => divider.evaluate(element => element.hasPointerCapture(1))).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.move(x - 15, y, { steps: 3 });
    await page.mouse.move(x + 45, y, { steps: 5 });
    await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
    await expect(dividerLine).toHaveCSS('width', '3px');
    await page.mouse.up();
    await expect(pane.locator('[data-snap-resizing]')).toHaveCount(0);
    await page.mouse.move(x + 65, y);
    await expect(dividerLine).toHaveCSS('width', '1px');

    const screenshot = async (name: string) => {
      await pane.evaluate(async node => {
        const animations = [...(node.closest('.h-strip')?.getAnimations() ?? []), ...node.getAnimations({ subtree: true })];
        await Promise.allSettled(animations.filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished));
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      const rect = (await pane.boundingBox())!;
      const pixels = await app.evaluate(async ({ BrowserWindow }, bounds) => {
        const clip = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
        return (await BrowserWindow.getAllWindows()[0].capturePage(clip)).toPNG().toString('base64');
      }, rect);
      fs.writeFileSync(info.outputPath(name), Buffer.from(pixels, 'base64'));
    };
    await expect(file.locator('.cm-content')).toBeVisible();
    await expect(file.locator('.cm-content')).toContainText('Static file preview');
    await expect(file.locator('.file-editor-pane.is-shown')).toHaveCSS('opacity', '1');
    await expect(pane.locator('.right-browser-stack')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(pane.locator('.right-browser-stack .browser-host')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await screenshot('split-dark.png');
    await pane.locator('[data-right-split-slot="0"]').getByRole('button', { name: '收起此侧' }).click();
    await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
    const hiddenFile = pane.locator('.right-content-page.files-panel');
    await expect(hiddenFile).toHaveCSS('transition-property', 'none');
    await expect(hiddenFile).toHaveCSS('visibility', 'hidden');
    await page.evaluate(() => window.api.themes.activate('light'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
    await expect(first).toBeInViewport();
    await expect(second).toBeInViewport();
    expect(await nativeId(first)).toBe(firstId);
    expect(await nativeId(second)).toBe(secondId);
    expect(await app.evaluate(({ webContents }, id) =>
      webContents.fromId(id)?.executeJavaScript('document.querySelector("#draft").value'), firstId)).toBe('retained');
    await screenshot('split-light-narrow.png');

    await test.step('host.panel.run reads, arranges, focuses and collapses the live right split', async () => {
      const bundle = info.outputPath('panel-tool.cjs');
      buildSync({ stdin: { contents: `
        export { schedulerProjectedCatalog } from './src/main/capabilities/catalog/projectedCatalog';
        export { expandRunToolCall } from './src/main/capabilities/runRouter';
        export { panelHost } from './src/main/capabilities/hosts/panel';
        export { runAsAgentWorkspace, runAsSchedulerTool } from './src/main/agent/agentScope';
      `, resolveDir: project, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
        outfile: bundle, logLevel: 'silent' });
      const workspace = (await page.evaluate(() => window.api.workspaces.list())).workspaces.find(item => item.id === 'split')!;
      const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
      type ToolResult = PanelSnapshotResponse | PanelRightLayoutResponse | PanelFocusResponse;
      const tool = (action: string, params: Record<string, unknown> = {}): Promise<ToolResult> =>
        app.evaluate(async ({ BrowserWindow }, input) => {
          const { createRequire } = process.getBuiltinModule('node:module') as typeof import('node:module');
          const m = createRequire(input.bundle)(input.bundle);
          const entry = m.schedulerProjectedCatalog().find((tool: { name: string }) => tool.name === 'host.panel.run');
          if (!entry) throw new Error('The public panel tool is unavailable');
          const route = m.expandRunToolCall(entry.sources[0], { action: input.action, params: input.params });
          const ctx = { getWindow: () => BrowserWindow.fromId(input.windowId),
            resolveBubbleWorkspaceId: () => input.workspace.id,
            config: { get: () => ({ activeWorkspaceId: input.workspace.id, workspaces: [input.workspace] }) } };
          return m.runAsAgentWorkspace(input.workspace.id, () => m.runAsSchedulerTool(() =>
            m.panelHost[`host.${route.targetTool}`](ctx, route.args)));
        }, { bundle, windowId, workspace, action, params });
      const list = async () => {
        const result = await tool('list');
        if (!result.ok || !('snapshot' in result)) throw new Error(JSON.stringify(result));
        return result.snapshot.right;
      };
      const before = await list();
      const tabIdFor = (name: string) => before.tabs.find(tab => tab.content.kind === 'web' && tab.content.title === name)!.id;
      const firstTabId = tabIdFor('First page'), secondTabId = tabIdFor('Second page');
      const fileTabId = before.tabs.find(tab => tab.content.kind === 'file' && tab.content.path === 'notes.txt')!.id;
      expect(before.split).toEqual({ layoutId: 'stack', tabIds: [firstTabId, secondTabId], ratio: 0.5 });
      await page.getByRole('button', { name: '折叠右侧栏', exact: true }).click();
      await expect(page.locator('.main-view')).toHaveClass(/\bh-terminal\b/);
      const layout = { layoutId: 'focus-mirror', tabIds: [firstTabId, secondTabId, fileTabId], ratios: [0.45, 0.6] };
      expect(await tool('split', { placement: 'right', ...layout })).toMatchObject({ ok: true, placement: 'right', split: layout });
      await expect(page.locator('.main-view')).toHaveClass(/\bh-git\b/);
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(2)).toContainText('notes.txt');
      await expect(divider).toHaveAttribute('aria-valuenow', '45');
      await expect(first).toHaveAttribute('data-browser-presentation', 'foreground');
      await expect(second).toHaveAttribute('data-browser-presentation', 'foreground');
      await expect(file).toBeVisible();
      expect(await nativeId(first)).toBe(firstId);
      expect(await nativeId(second)).toBe(secondId);
      expect(await tool('focus', { tabId: secondTabId })).toMatchObject({ ok: true });
      expect((await list()).selectedTabId).toBe(secondTabId);
      const resized = { ...layout, ratios: [0.52, 0.62] };
      expect(await tool('split', { placement: 'right', ...resized })).toMatchObject({ ok: true, selectedTabId: secondTabId, split: resized });
      await expect(divider).toHaveAttribute('aria-valuenow', '52');
      await expect(page.getByTestId('right-split-divider-1')).toHaveAttribute('aria-valuenow', '62');
      await screenshot('split-agent-narrow.png');
      expect(await tool('close', { placement: 'right', slot: 2 })).toMatchObject({ ok: true, split: before.split });
      expect(await tool('close', { placement: 'right' })).toMatchObject({ ok: true, selectedTabId: secondTabId, split: null });
      expect((await list()).tabs.map(tab => tab.id)).toEqual(before.tabs.map(tab => tab.id));
      await expect(divider).toHaveCount(0);
    });
  } finally {
    try { await app.close(); } finally { server.close(); }
  }
});
