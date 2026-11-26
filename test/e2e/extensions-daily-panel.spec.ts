import { test, expect } from './fixtures/electron';

test('daily-report 面板与 DomainRuntime 写入链路', async ({ appCtx }, testInfo) => {
  const { win } = appCtx;
  const expandExtensions = win.getByRole('button', { name: '展开更多工具' });
  if (await expandExtensions.isVisible().catch(() => false)) await expandExtensions.click();
  await win.locator('[role="treeitem"][aria-label="工作日报"]').click();
  const trustButton = win.getByRole('button', { name: '信任开发目录' });
  if (await trustButton.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)) await trustButton.click();
  const frame = win.frameLocator('iframe.ext-panel-frame[aria-label="扩展面板 工作日报"]');
  await frame.locator('#todoText').waitFor({ state: 'visible', timeout: 20_000 });
  await expect(frame.locator('#genStatus')).toContainText('当前工作区');
  const title = `E2E 日报 ${Date.now()}`;
  await frame.locator('#todoText').fill(title);
  await frame.getByRole('button', { name: '添加' }).click();
  const item = frame.locator('.todo-item').filter({ hasText: title });
  await expect(item).toBeVisible({ timeout: 10_000 });
  await expect(frame.locator('.d-date')).toHaveText(/\d{4}-\d{2}-\d{2}/);
  const open = Number(await frame.locator('[data-stat="open-todos"] .stat-value').innerText());
  await item.getByRole('button', { name: '已完成', exact: true }).click();
  await expect(frame.locator('[data-stat="open-todos"] .stat-value')).toHaveText(String(open - 1));
  const group = frame.locator('[data-g="done"]');
  if (await group.getAttribute('aria-expanded') === 'false') {
    await group.focus(); await group.press('Enter');
  }
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(item).toBeVisible();
  await expect(item.getByRole('button', { name: '已完成', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const dateButton = frame.locator('.cal-day:not(.selected):not(.other)').first();
  const selected = await dateButton.getAttribute('data-d');
  await dateButton.focus(); await dateButton.press('Enter');
  await expect(frame.locator('.d-date')).toHaveText(selected!);
  await frame.locator('#calToday').click();
  await expect(item).toBeVisible();
  await expect(frame.locator('.day-stamp')).toHaveCSS('font-family', /Georgia/);
  await frame.locator('.app').screenshot({ path: testInfo.outputPath('daily-report.png') });
  expect(appCtx.consoleErrors, `console errors: ${appCtx.consoleErrors.slice(0, 4).join(' | ')}`).toEqual([]);
});
