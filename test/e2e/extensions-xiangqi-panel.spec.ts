import path from 'node:path';
import { test, expect, repoRoot } from './fixtures/electron';

test.use({ isolatedSandbox: true });

test('中国象棋安装后可以键盘落子、重载续弈并悔棋', async ({ appCtx }, testInfo) => {
  const { app, win } = appCtx;
  const directory = path.join(repoRoot, 'resources', 'extensions', 'xiangqi');
  await app.evaluate(({ dialog }, localPackage) => {
    const showOpenDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = showOpenDialog;
      return { canceled: false, filePaths: [localPackage] };
    };
  }, directory);
  const installed = await win.evaluate(async () => {
    const result = await window.api.extensionCatalog.installLocal();
    if (!('extensionId' in result)) throw new Error('棋局测试没有安装扩展');
    const { activeWorkspaceId: workspaceId } = await window.api.config.get();
    if (!workspaceId) throw new Error('棋局测试缺少工作区');
    await window.api.extensions.setEnabledAll({ workspaceId, extensionId: result.extensionId, enabled: true });
    return result.extensionId;
  });
  expect(installed).toBe('xiangqi');

  const expand = win.getByRole('button', { name: '展开更多工具' });
  if (await expand.isVisible()) await expand.click();
  await win.getByRole('treeitem', { name: '中国象棋', exact: true }).click();
  await win.getByRole('button', { name: '信任开发目录' }).click();
  const selector = 'iframe[aria-label="扩展面板 中国象棋"]';
  const frame = win.frameLocator(selector);
  const turn = frame.locator('#turn');
  const count = frame.locator('#move-count');
  const from = frame.locator('[data-square="58"]');
  const to = frame.locator('[data-square="49"]');
  await expect(turn).toHaveText('轮到你走棋', { timeout: 20_000 });

  await from.press('Enter');
  await expect(from).toHaveAttribute('aria-pressed', 'true');
  await expect(to).toHaveAttribute('data-legal', '');
  await from.press('ArrowUp');
  await expect(to).toBeFocused();
  await to.press('Enter');
  await expect(count).toHaveText('2 着');
  await expect(to.locator('.piece')).toHaveText('兵');
  await expect(frame.locator('#save-text')).toContainText('棋局已保存');

  await win.getByRole('button', { name: '重载', exact: true }).click();
  await expect(win.locator(selector)).toHaveAttribute('src', /__ma_reload=1/);
  await expect(count).toHaveText('2 着', { timeout: 20_000 });
  await expect(to.locator('.piece')).toHaveText('兵');
  await expect(frame.locator('#moves')).toContainText('兵五进一');

  await frame.getByRole('button', { name: '提示', exact: true }).click();
  await expect(frame.locator('#message')).toContainText('建议：');
  await expect(frame.locator('[data-hint]')).toHaveCount(2);
  await expect(count).toHaveText('2 着');

  await win.evaluate(() => window.api.themes.activate('light'));
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(to.locator('.piece')).toHaveCSS('corner-shape', 'round');
  await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
  await win.locator(selector).screenshot({ path: testInfo.outputPath('xiangqi-light.png') });

  await frame.getByRole('button', { name: '新局', exact: true }).click();
  const confirmation = win.getByRole('dialog', { name: '开始一盘新棋？' });
  await expect(confirmation).toBeVisible({ timeout: 5000 }).catch(async failure => {
    throw new Error(`${failure.message}\n面板：${await frame.locator('#failure-text').textContent()}\n宿主：${appCtx.consoleErrors.join(' | ')}`);
  });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(count).toHaveText('2 着');

  await frame.getByRole('button', { name: '悔棋', exact: true }).click();
  await expect(count).toHaveText('0 着');
  await expect(from.locator('.piece')).toHaveText('兵');
  await frame.getByRole('button', { name: '翻转', exact: true }).click();
  await expect(from).toHaveAttribute('data-visual', '31');
  await frame.getByRole('button', { name: '双人同屏' }).click();
  await expect(turn).toHaveText('轮到红方');
  await from.click();
  await to.click();
  await expect(count).toHaveText('1 着');
  await expect(turn).toHaveText('轮到黑方');

  await win.locator(selector).evaluate(node => { node.style.width = '300px'; });
  await win.evaluate(() => window.api.themes.activate('dark'));
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await frame.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  const square = await to.boundingBox();
  expect(square?.width).toBeGreaterThan(24);
  await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
  await win.locator(selector).screenshot({ path: testInfo.outputPath('xiangqi-dark-narrow.png') });
  await expect(frame.locator('#failure')).toBeHidden();
});
