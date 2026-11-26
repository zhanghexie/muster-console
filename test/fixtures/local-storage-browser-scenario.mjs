export default async function ({ page, capture, assert }) {
  await page.getByRole('button', { name: '开始扫描' }).click();
  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^浏览器/ }).click();
  assert.ok(await page.getByText(/下载来源或完成记录未知，不可清理。/).count());
  await page.getByRole('button', { name: /old-download.txt/ }).scrollIntoViewIfNeeded();
  await capture('unknown-download');
  await page.getByRole('button', { name: /浏览器站点数据/ }).click();
  await capture('browser-details');
  await page.getByRole('checkbox', { name: '选择 浏览器站点数据' }).check();
  await page.getByRole('button', { name: '检查清理影响' }).click();
  const dialog = page.getByRole('dialog', { name: '确认清理所选项目？' });
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAttribute('data-mp-stage') === 'in');
  await page.waitForTimeout(300);
  assert.ok(await dialog.getByText(/Cookie/).count());
  await capture('browser-confirmation');
}
