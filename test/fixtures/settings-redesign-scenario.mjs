export default async function({ page, capture, assert, theme, width }) {
  const nav = page.getByRole('navigation', { name: '设置分组' });
  const current = () => page.locator('.settings-tabpane.is-shown');
  async function navigate(label) {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('heading', { name: label, exact: true, level: 1 }).waitFor();
    assert.equal(await current().locator('.settings-col').evaluate(el => getComputedStyle(el).maxWidth), '1120px', `${label}: shared width`);
  }
  async function snapshot(label) {
    assert.ok(await current().evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${label}: no pane overflow`);
    await capture(label);
  }
  await nav.waitFor({ state: 'visible' });
  await navigate('模型与输入');
  await current().getByLabel('供应商名称').waitFor();
  if (width <= 820) assert.equal(await current().locator('.llm-provider-body').evaluate(el => getComputedStyle(el).paddingLeft), '0px', 'Narrow detail aligns with its heading');
  await snapshot('models-providers');
  await current().getByRole('heading', { name: '文件与输入', exact: true, level: 2 }).scrollIntoViewIfNeeded();
  await current().getByRole('heading', { name: '文件限制' }).waitFor();
  assert.ok(await current().locator('.s-row:has(.is-num)').evaluateAll(rows => rows.every(row => getComputedStyle(row).flexDirection === 'row')), 'Short numbers stay in setting rows');
  await snapshot('models-input');
  await current().evaluate(el => { el.scrollTop = el.scrollHeight; });
  await snapshot('models-tools');
  await navigate('能力管理');
  await current().getByRole('group', { name: '作用范围' }).getByRole('button', { name: '全局', exact: true }).click();
  await current().getByRole('button', { name: '查看 code-review' }).click();
  await current().getByLabel('技能目录', { exact: true }).waitFor();
  await snapshot('capability-skills');
  if (width <= 820) await page.keyboard.press('Escape');
  await current().getByRole('button', { name: 'MCP', exact: true }).click();
  await current().getByRole('button', { name: '查看 docs-reader' }).click();
  await snapshot('capability-mcp');
  if (width <= 820) await page.keyboard.press('Escape');
  if ((theme === 'dark' && width > 820) || (theme === 'light' && width <= 820)) {
    await current().getByRole('button', { name: '应用能力', exact: true }).click();
    await current().getByRole('button', { name: '查看 browser.run' }).click();
    await snapshot('capability-catalog');
    if (width <= 820) await page.keyboard.press('Escape');
    await current().getByRole('button', { name: /^宿主接入/ }).click();
    await current().getByTestId('inbound-mcp-status').waitFor();
    await snapshot('capability-host');
  }
  // Cover every remaining page, distributing light/dark and wide/narrow captures.
  if ((theme === 'dark' && width > 820) || (theme === 'light' && width <= 820)) {
    for (const [label, name] of [['外观','appearance'], ['调度 Agent','scheduler'], ['记忆','memory'], ['文本工具','text-tools'], ['通知','notifications'], ['远程访问','remote-access'], ['快捷键','shortcuts'], ['关于','about']]) {
      await navigate(label);
      await current().locator('h2').first().waitFor();
      await snapshot(name);
      if (['appearance', 'text-tools', 'remote-access'].includes(name)) {
        await current().evaluate(el => { el.scrollTop = el.scrollHeight; });
        await snapshot(`${name}-bottom`);
      }
    }
  }
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.unmocked), [], 'All IPC is mocked');
}
