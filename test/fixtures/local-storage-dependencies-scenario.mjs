/** Review a shared worktree and exercise optional cleanup in the production settings pane. */
export default async function ({ page, capture, assert }) {
  await page.evaluate(() => window.__uiFixture.enableStorageDependencies());
  await page.getByRole('button', { name: '开始扫描' }).click();
  const tree = page.getByRole('checkbox', { name: '选择 任务界面调整' });
  const review = page.getByRole('button', { name: '检查清理影响' });
  const dialog = page.getByRole('dialog', { name: '确认清理所选项目？' });
  await tree.check();
  await review.click();
  await dialog.waitFor();
  const detail = await dialog.locator('.confirm-detail').innerText();
  assert.match(detail, /必须一并清理/);
  assert.match(detail, /代码审查与改进/);
  assert.match(detail, /项目状态梳理/);
  assert.equal(await dialog.getByRole('button', { name: '取消' }).evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#root').evaluate(el => el.inert), true);
  assert.equal(await dialog.getByRole('checkbox', { name: /丢弃 任务界面调整/ }).isChecked(), false);
  await capture('required-sessions');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await review.evaluate(el => el === document.activeElement), true);
  await tree.uncheck();
  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^会话/ }).click();
  await page.getByRole('checkbox', { name: '选择 代码审查与改进' }).check();
  await review.click();
  assert.equal(await dialog.getByText('建议一并清理').count(), 0);
  await dialog.getByRole('button', { name: '取消' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('checkbox', { name: '选择 项目状态梳理' }).check();
  await review.click();
  const recommendation = dialog.getByRole('checkbox', { name: /同时清理 任务界面调整/ });
  assert.equal(await recommendation.isChecked(), false);
  await capture('suggested-worktree');
  await recommendation.check();
  assert.equal(await dialog.getByRole('checkbox', { name: /丢弃 任务界面调整/ }).isChecked(), false);
}
