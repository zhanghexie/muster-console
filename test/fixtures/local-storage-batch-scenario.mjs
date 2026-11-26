export default async function ({ page, capture, assert }) {
  await page.getByRole('heading', { name: '存储项目' }).waitFor();
  await page.evaluate(() => window.__uiFixture.addStorageItems());
  await page.getByRole('button', { name: '开始扫描' }).click();
  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^会话/ }).click();

  const pane = page.locator('.settings-tabpane[data-settings-item="localStorage"]');
  const detail = page.locator('.local-storage-detail');
  const controls = page.locator('.local-storage-list-tools');
  assert.ok(await controls.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Batch controls fit the content width');
  assert.ok(await pane.evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'The settings pane remains fixed height');
  await capture('list-controls');
  const firstItem = page.getByRole('button', { name: /^代码审查与改进/ });
  await firstItem.click();
  assert.equal(await firstItem.getAttribute('aria-expanded'), 'true');
  await page.locator('.local-storage-inspection').waitFor();
  await capture('detail');
  await firstItem.click();
  assert.equal(await firstItem.getAttribute('aria-expanded'), 'false');
  await page.locator('.local-storage-inspection').waitFor({ state: 'hidden' });

  await page.getByRole('combobox', { name: '筛选存储项目' }).click();
  await page.getByRole('option', { name: '仅可清理' }).click();
  assert.equal(await page.getByRole('checkbox', { name: '选择 项目状态梳理' }).count(), 0, 'Unavailable items are filtered out');
  await page.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }).check();
  await page.getByText(/已选择 19 项/).waitFor();
  await capture('selected');

  const search = page.getByRole('searchbox', { name: '搜索存储项目' });
  await search.fill('额外项目 sessions 1');
  assert.equal(await detail.locator('.local-storage-row').count(), 10, 'Search includes all matching names');
  await page.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }).uncheck();
  await page.getByText(/已选择 9 项/).waitFor();
  await search.fill('');
  const sort = page.getByRole('combobox', { name: '排序存储项目' });
  await sort.focus();
  await page.keyboard.press('ArrowDown');
  await page.locator('select:open').waitFor();
  await capture('sort-menu');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.match(await detail.locator('.local-storage-row-button').first().innerText(), /额外项目 sessions 1/, 'Smallest items sort first');

  await page.getByRole('button', { name: '检查清理影响' }).click();
  const dialog = page.getByRole('dialog', { name: '确认清理所选项目？' });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /额外项目 sessions 2/);
  assert.doesNotMatch(await dialog.innerText(), /额外项目 sessions 10/);
  await capture('review');
  await dialog.getByRole('button', { name: '确认清理' }).click();
  await page.locator('.local-storage-results').waitFor();
  assert.match(await page.locator('.local-storage-results').innerText(), /已完成 8 项/);
  assert.match(await page.locator('.local-storage-results').innerText(), /已发起 1 项/);
  assert.equal(await page.locator('.local-storage-results p').count(), 0, 'Successful items are summarized in one line');
  assert.ok(await page.getByRole('navigation', { name: '存储类别' }).count(), 'Cleanup keeps the inventory visible');
  assert.equal(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.path === 'localStorage.scan').length), 1, 'Batch cleanup does not rescan automatically');
  await capture('results');

  await page.getByRole('combobox', { name: '选择存储范围' }).click();
  await page.getByRole('option', { name: 'MetaAgent' }).click();
  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^手机应用/ }).click();
  await page.getByRole('combobox', { name: '筛选存储项目' }).click();
  await page.getByRole('option', { name: '全部项目' }).click();
  assert.match(await page.getByRole('button', { name: /^示例应用/ }).innerText(), /共享存储/);
  assert.match(await page.getByRole('button', { name: /^应用数据库/ }).innerText(), /GB/);
  assert.match(await page.locator('.local-storage-detail-heading strong').innerText(), /GB/);
  await capture('workspace-app-storage');
  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^扩展/ }).click();
  assert.match(await page.getByRole('button', { name: /^辅助扩展/ }).innerText(), /共享存储/);
  assert.match(await page.locator('.local-storage-detail-heading strong').innerText(), /KB/);
  await capture('workspace-extension-storage');

  await page.evaluate(() => window.__setStorageLocale('en'));
  if (page.viewportSize().width >= 700) assert.ok(await page.getByText('Models & input', { exact: true }).count(), 'The surrounding settings navigation is translated');
  await page.getByRole('button', { name: 'Rescan' }).click();
  await page.getByRole('navigation', { name: 'Storage categories' }).getByRole('button', { name: /^Session/ }).click();
  await page.getByRole('checkbox', { name: 'Select all cleanable items in these results' }).check();
  await page.getByText(/19 selected/).waitFor();
  assert.ok(await page.locator('.local-storage-actions').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'English actions fit the content width');
  assert.ok(await page.locator('.local-storage-actions > span').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'English selected count is fully visible');
  assert.ok(await page.getByRole('combobox', { name: 'Filter storage items' }).locator('.c-select-value').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'English filter label is fully visible');
  assert.equal(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.path === 'localStorage.scan').length), 2, 'English rescan is user initiated');
  await capture('english');
}
