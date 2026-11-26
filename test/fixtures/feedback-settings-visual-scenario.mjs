export default async function ({ page, capture, assert }) {
  const openProject = page.getByRole('button', { name: '打开反馈项目' });
  await openProject.waitFor();
  assert.equal(await page.getByLabel('反馈令牌').count(), 0);
  await openProject.click();
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.calls), ['https://github.com/zhanghexie/muster-console/issues']);
  await capture('feedback-settings');
  await page.getByRole('button', { name: '反馈审核' }).click();
  await page.getByRole('dialog', { name: '反馈审核' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '手动添加反馈' }).isEnabled(), true);
}
