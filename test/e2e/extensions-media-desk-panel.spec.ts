import { test, expect } from './fixtures/electron';
import { hasExtensionTestCenter, installCenterExtension } from './fixtures/centerExtension';
import path from 'node:path';

test.use({ isolatedSandbox: true });

test.skip(!hasExtensionTestCenter, 'Requires an explicit extension center fixture or GitHub credential');

test('media desk retains the original five views and studio in the real extension host', async ({ appCtx }) => {
  const { win } = appCtx;
  await installCenterExtension(win, 'dsh-media-desk');
  const more = win.getByRole('button', { name: '展开更多工具' });
  if (await more.isVisible().catch(() => false)) await more.click();
  await win.locator('[role="treeitem"][aria-label="媒体创作台"]').click();
  const frameSelector = 'iframe[aria-label="扩展面板 媒体创作台"]';
  const frame = win.frameLocator(frameSelector);
  const panel = win.locator('.ext-panel').filter({ has: win.locator(frameSelector) });
  await expect(frame.locator('.md-root')).toBeVisible({ timeout: 30000 });
  await expect(panel.getByTestId('extension-agent-toggle')).toHaveCount(0);
  await expect(panel.locator('.ext-agent-sidebar')).toHaveCount(0);
  await expect(frame.getByRole('textbox', { name: '记下灵感' })).toBeVisible();
  const capture = path.resolve('.tmp/ui-captures/dsh-media-desk');
  await win.screenshot({ path: path.join(capture, 'electron-home.png') });
  for (const [label, file] of [['内容', 'content'], ['排期', 'schedule'], ['复盘', 'insights'], ['风格', 'style']] as const) {
    await frame.getByRole('navigation', { name: '工作台导航' }).getByRole('button', { name: label, exact: true }).click();
    await expect(frame.getByRole('navigation', { name: '工作台导航' }).getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    await win.screenshot({ path: path.join(capture, `electron-${file}.png`) });
  }
  await frame.getByRole('navigation', { name: '工作台导航' }).getByRole('button', { name: '灵感', exact: true }).click();
  const input = frame.getByRole('textbox', { name: '记下灵感' });
  const title = `原版画布验收 ${Date.now()}`;
  await input.fill(title); await input.press('Enter');
  await expect(frame.locator('.md-node').filter({ hasText: title })).toBeVisible({ timeout: 10000 });
  await frame.locator('.md-node').filter({ hasText: title }).getByRole('button').first().click();
  await expect(frame.locator('.md-studio')).toBeVisible();
  await expect(frame.locator('.md-bento')).toBeVisible();
  await expect.poll(() => frame.locator('.md-studio').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  await win.screenshot({ path: path.join(capture, 'electron-studio.png') });
  await frame.getByRole('button', { name: '返回灵感' }).click();
  await expect(frame.locator('.md-studio')).toHaveCount(0);
  await panel.getByRole('button', { name: '重载', exact: true }).click();
  await expect(win.locator(frameSelector)).toHaveAttribute('src', /__ma_reload=1/);
  await expect(frame.locator('.md-node').filter({ hasText: title })).toBeVisible();
  await expect(panel.getByTestId('extension-agent-toggle')).toHaveCount(0);
  expect(appCtx.consoleErrors).toEqual([]);
});
