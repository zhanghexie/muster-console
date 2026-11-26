/** Production KnowledgePanel with deterministic fixture data and mocked IPC. */
export default async function ({ page, capture, assert }) {
  await page.waitForFunction(() => window.__memoryUsage?.telemetry.ready);
  await page.getByRole('tab', { name: '知识列表' }).click();
  const search = page.getByRole('textbox', { name: '搜索记忆' });
  await search.fill('订阅');
  await page.getByRole('button', { name: '查看依据与修订' }).click();
  await page.getByRole('button', { name: '修订内容与条件' }).click();
  const draft = page.getByRole('textbox', { name: '记忆结论' });
  await draft.fill('尚未保存的草稿');
  await capture('chinese-overview');
  await draft.scrollIntoViewIfNeeded();
  await capture('chinese-draft');
  const before = await page.evaluate(() => window.__memoryUsage.telemetry.calls.filter(item => item.path === 'knowledge.list').length);
  await page.evaluate(() => window.__memoryUsage.setLocale('en'));
  const translatedSearch = page.getByRole('textbox', { name: 'Search memories' });
  await translatedSearch.waitFor();
  assert.equal(await translatedSearch.inputValue(), '订阅');
  const translatedDraft = page.getByRole('textbox', { name: 'Memory statement' });
  assert.equal(await translatedDraft.inputValue(), '尚未保存的草稿');
  assert.equal(await page.evaluate(() => window.__memoryUsage.telemetry.calls.filter(item => item.path === 'knowledge.list').length), before);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await translatedDraft.scrollIntoViewIfNeeded();
  await capture('english-same-draft');
  await page.evaluate(() => window.__memoryUsage.setLocale('zh-CN'));
  assert.equal(await page.getByRole('textbox', { name: '记忆结论' }).inputValue(), '尚未保存的草稿');
}
