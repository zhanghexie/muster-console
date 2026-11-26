export default async function ({ page, capture, assert }) {
  await page.evaluate(() => window.__uiFixture.failStorageCleanup('w1', '测试项目当前仍被占用'));
  await page.getByRole('button', { name: '开始扫描' }).click();
  await page.getByRole('checkbox', { name: '选择 任务界面调整' }).check();
  await page.getByRole('button', { name: '检查清理影响' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认清理' }).click();
  await page.getByText('未完成 1 项').waitFor();
  assert.equal(await page.locator('.local-storage-result-list').count(), 0);
  assert.ok(await page.getByRole('navigation', { name: '存储类别' }).isVisible());
  await capture('failure-summary');
  const toggle = page.getByRole('button', { name: '查看未完成项目' });
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.getByRole('button', { name: '查看详情' }).click();
  await page.locator('.app-tip-region').getByText(/测试项目当前仍被占用/).waitFor();
  await capture('failure-detail');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.path === 'localStorage.scan').length), 1);
}
