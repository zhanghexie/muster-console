export default async function ({ page, capture, assert }) {
  await page.getByRole('button', { name: '开始扫描' }).click();
  const row = page.getByRole('button', { name: /^实验·斜面与轨道机械能/ });
  await row.waitFor();
  assert.match(await row.innerText(), /目录不存在/);
  const select = page.getByRole('checkbox', { name: '选择 实验·斜面与轨道机械能' });
  assert.equal(await select.isEnabled(), true, 'An archived missing worktree can be reviewed');
  await row.click();
  const details = page.locator('.local-storage-inspection');
  assert.equal(await details.locator('input[readonly]').inputValue(), 'C:/MetaAgent/worktrees/previous-task');
  assert.ok(await details.getByText('目录不存在').count());
  assert.equal(await details.getByRole('button', { name: '打开位置' }).count(), 0, 'A known missing directory does not offer a failing open action');
  await page.waitForFunction(() => {
    const view = document.querySelector('.local-storage-detail').getBoundingClientRect();
    const heading = document.querySelector('.local-storage-inspection h4').getBoundingClientRect();
    return heading.top >= view.top && heading.bottom <= view.bottom;
  });
  const visibility = await page.evaluate(() => {
    const view = document.querySelector('.local-storage-detail').getBoundingClientRect();
    const heading = document.querySelector('.local-storage-inspection h4').getBoundingClientRect();
    return { viewTop: view.top, viewBottom: view.bottom, headingTop: heading.top, headingBottom: heading.bottom };
  });
  assert.ok(visibility.headingTop >= visibility.viewTop && visibility.headingBottom <= visibility.viewBottom, 'The selected item details are brought into view');
  await capture('missing-detail');
  await select.check();
  await page.getByRole('button', { name: '检查清理影响' }).click();
  const dialog = page.getByRole('dialog', { name: '确认清理所选项目？' });
  assert.ok(await dialog.getByText(/重新检查 Git 登记和任务分支/).count());
  await capture('missing-review');
  await dialog.getByRole('button', { name: '取消' }).click();
  await dialog.waitFor({ state: 'hidden' });

  const active = page.getByRole('button', { name: /^性能排查/ });
  assert.match(await active.innerText(), /正在使用或尚未归档/);
  assert.equal(await page.getByRole('checkbox', { name: '选择 性能排查' }).isDisabled(), true);
  await page.getByRole('button', { name: /^任务界面调整/ }).click();
  await page.evaluate(() => window.__uiFixture.setRevealError('permission denied'));
  await details.getByRole('button', { name: '打开位置' }).click();
  assert.match(await page.locator('.app-tip-region').innerText(), /permission denied/);
  await details.scrollIntoViewIfNeeded();
  await capture('open-error');

  await page.evaluate(() => window.__setStorageLocale('en'));
  await row.click();
  assert.match(await row.innerText(), /Directory does not exist/);
  assert.ok(await details.getByText('Directory does not exist').count());
  assert.ok(await details.getByText(/rechecks Git worktree registrations/).count());
  await details.scrollIntoViewIfNeeded();
  await capture('missing-english');
}
