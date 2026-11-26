import { test, expect } from './fixtures/electron';
import { hasExtensionTestCenter } from './fixtures/centerExtension';
import fs from 'node:fs/promises';
import path from 'node:path';

test.use({ isolatedSandbox: true });

test.skip(!hasExtensionTestCenter || Boolean(process.env.MUSTER_EXTENSION_CENTER_URL?.trim())
  || process.env.MUSTER_EXTENSION_CENTER_LOCAL === '1', 'Requires the public GitHub extension center');

test('shows the source of the live GitHub catalog in the list and release details', async ({ appCtx }, testInfo) => {
  const { win } = appCtx;
  const tools = win.getByRole('button', { name: '展开实用工具' });
  if (await tools.isVisible()) await tools.click();
  await win.getByRole('listitem').filter({ hasText: '扩展管理' }).click();
  const tabs = win.getByRole('tablist', { name: '扩展管理' });
  await expect(tabs.getByRole('tab')).toHaveText([/^全局扩展/, /^项目扩展/, '扩展中心']);
  const tabsTop = () => tabs.evaluate(element => (element as HTMLElement).offsetTop);
  const initialTop = await tabsTop();
  await tabs.getByRole('tab', { name: /^全局扩展/ }).focus();
  await win.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: /^项目扩展/ })).toBeFocused();
  await win.keyboard.press('Enter');
  const project = win.getByRole('tabpanel', { name: /^项目扩展/ });
  await expect(project).toHaveCSS('opacity', '1');
  expect(await tabsTop()).toBe(initialTop);
  await win.locator('.ext-extension-manager').screenshot({ path: testInfo.outputPath('extension-management-project.png') });
  await win.keyboard.press('ArrowLeft');
  await win.keyboard.press('Enter');
  const installed = win.getByRole('tabpanel', { name: /全局扩展/ });
  const dailyReport = installed.getByRole('article').filter({ hasText: '工作日报' });
  await expect(dailyReport.getByText('已启用', { exact: true })).toBeVisible();
  await expect(installed.getByText('待审核', { exact: true })).toHaveCount(0);
  await expect(win.getByRole('button', { name: '安装内置样例' })).toHaveCount(0);
  await win.getByRole('tab', { name: '扩展中心', exact: true }).click();

  const center = win.getByRole('tabpanel', { name: '扩展中心', exact: true });
  const toolbar = center.locator('.ext-extension-center-toolbar');
  const release = center.getByRole('button', { name: '查看扩展详情 五子棋' });
  await expect(release).toBeVisible({ timeout: 15_000 });
  await toolbar.getByRole('button', { name: '刷新' }).click();
  await expect(release).toBeVisible({ timeout: 15_000 });
  await expect(toolbar.getByText('GitHub 扩展中心', { exact: true })).toBeVisible();
  await expect(center.getByRole('heading', { level: 2 })).toHaveText(['创作', '阅读', '游戏']);
  const rows = center.locator('.ext-extension-center-list article');
  const rowWidths = () => rows.evaluateAll(items => [...new Set(items.map(item => Math.round(item.getBoundingClientRect().width)))]);
  expect(await rowWidths()).toHaveLength(1);
  await center.screenshot({ path: testInfo.outputPath('github-center-list.png') });

  await release.click();
  const detail = center.getByRole('article', { name: '五子棋' });
  await expect(detail.getByText('GitHub 扩展中心', { exact: true })).toBeVisible();
  await expect(detail.getByRole('link', { name: '查看仓库' })).toHaveAttribute('href', 'https://github.com/zhanghexie/muster-extension-gomoku');
  await detail.screenshot({ path: testInfo.outputPath('github-center-detail.png') });

  await detail.getByRole('button', { name: '返回扩展中心' }).click();
  await expect(release).toBeVisible();
  expect(await win.evaluate(() => window.api.themes.activate('light', { scope: 'workspace' }))).toMatchObject({ ok: true });
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
  await win.locator('.ext-extension-manager').evaluate(element => { element.style.inlineSize = '390px'; });
  expect(await rowWidths()).toHaveLength(1);
  expect(await center.locator('.ext-extension-center-list-view').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const tabTops = await tabs.getByRole('tab').evaluateAll(elements => [...new Set(elements.map(element => element.getBoundingClientRect().top))]);
  expect(tabTops).toHaveLength(1);
  await win.locator('.ext-extension-manager').screenshot({ path: testInfo.outputPath('github-center-narrow.png') });
});

test('opens a verified download without trusting a development directory', async ({ appCtx }, testInfo) => {
  const { win, app } = appCtx;
  const centerTab = win.getByRole('tab', { name: '扩展中心', exact: true });
  if (!await centerTab.isVisible()) {
    const tools = win.getByRole('button', { name: '展开实用工具' });
    if (await tools.isVisible()) await tools.click();
    await win.getByRole('listitem').filter({ hasText: '扩展管理' }).click();
  }
  await centerTab.click();
  const center = win.getByRole('tabpanel', { name: '扩展中心', exact: true });
  const card = center.getByRole('article').filter({ hasText: 'muster/gomoku' });
  await card.getByRole('button', { name: '安装', exact: true }).click();
  await expect(card.getByText('已安装', { exact: true }).first()).toBeVisible();

  await win.getByRole('tab', { name: /^全局扩展/ }).click();
  const globalPanel = win.getByRole('tabpanel', { name: /^全局扩展/ });
  await expect(globalPanel).toHaveCSS('opacity', '1');
  await expect(win.locator('.ext-extension-center')).toHaveCSS('visibility', 'hidden');
  await expect(globalPanel.getByRole('heading', { level: 2 })).toHaveText(['下载的扩展', '本地扩展']);
  const downloadedGroup = globalPanel.locator('section').filter({ has: win.getByRole('heading', { name: '下载的扩展' }) });
  await expect(downloadedGroup.getByRole('switch', { name: '启用 五子棋' })).toBeVisible();
  await win.locator('.ext-extension-manager').screenshot({ path: testInfo.outputPath('extension-management-global.png') });
  const activation = win.getByRole('switch', { name: '启用 五子棋' });
  await activation.click();
  await expect(activation).toHaveAttribute('aria-checked', 'true');
  const moreTools = win.getByRole('button', { name: '展开更多工具' });
  if (await moreTools.isVisible()) await moreTools.click();
  const panelEntry = win.locator('[role="treeitem"][aria-label="五子棋"]');
  await panelEntry.click();
  const frame = win.frameLocator('iframe[aria-label="扩展面板 五子棋"]');
  await expect(frame.locator('#board')).toBeVisible({ timeout: 8000 });
  await expect(win.getByRole('button', { name: '信任开发目录' })).toHaveCount(0);
  await frame.locator('.app').screenshot({ path: testInfo.outputPath('official-gomoku.png') });

  const profile = await app.evaluate(({ app }) => {
    if (process.env.MUSTER_SANDBOX !== '1') throw new Error('Expected an isolated test profile');
    return app.getPath('userData');
  });
  expect(path.basename(path.resolve(profile, '..', '..'))).toMatch(/^muster-e2e-/);
  const panelFile = path.join(profile, 'extensions', 'global', 'gomoku', 'ui', 'panel.html');
  const original = await fs.readFile(panelFile);
  await win.locator('.ext-panel-statusbar').getByRole('button', { name: '关闭面板' }).click();
  await expect(frame.locator('#board')).not.toBeVisible();
  try {
    await fs.appendFile(panelFile, '\n<!-- Local edit -->\n');
    await expect(win.evaluate(async () => {
      const { activeWorkspaceId } = await window.api.config.get();
      if (!activeWorkspaceId) throw new Error('Expected an active test workspace');
      return window.api.extensionSurface.openExtension({ workspaceId: activeWorkspaceId, scope: 'global', extensionId: 'gomoku' });
    })).rejects.toThrow(/development trust is required/);
  } finally {
    await fs.writeFile(panelFile, original);
  }
});
