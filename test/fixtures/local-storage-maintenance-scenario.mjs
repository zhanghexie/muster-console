/** Exercise the production Other data review and the restart action. */
export default async function ({ page, capture, assert }) {
  await page.evaluate(() => window.__uiFixture.enableStorageMaintenance());
  await page.getByRole('button', { name: '开始扫描' }).click();
  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^其他数据/ }).click();
  const cache = page.getByRole('checkbox', { name: '选择 工作台网页和图形缓存' });
  await cache.check();
  await page.getByRole('button', { name: '检查清理影响' }).click();
  const dialog = page.getByRole('dialog', { name: '确认清理所选项目？' });
  assert.match(await dialog.innerText(), /下次启动时清理/);
  assert.equal(await dialog.getByRole('button', { name: '取消' }).evaluate(el => el === document.activeElement), true);
  await capture('review');

  await dialog.getByRole('button', { name: '确认清理' }).click();
  await page.getByText('1 项等待重启清理').waitFor();
  await dialog.waitFor({ state: 'hidden' });
  const restart = page.getByRole('button', { name: '重启并清理' });
  assert.equal(await cache.isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: '选择 使用统计和明细' }).isEnabled(), true);
  const calls = () => page.evaluate(() => window.__uiFixture.calls.map(call => call.path));
  assert.equal((await calls()).includes('app.relaunch'), false);
  await capture('scheduled');
  await restart.click();
  assert.equal((await calls()).filter(route => route === 'app.relaunch').length, 1);
}
