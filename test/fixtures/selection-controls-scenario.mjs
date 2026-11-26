export default async function ({ page, assert, capture }) {
  const drag = async locator => {
    const box = await locator.boundingBox();
    assert.ok(box, 'target must be visible');
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    return page.evaluate(() => getSelection().toString());
  };
  await page.getByText('当前会话乙').first().waitFor();
  for (const selector of ['.utility-navigation-title span', '.session-name-text', '.agent-ws-stack-label', '.agent-ws-stack .agent-notify-text', '[data-test-control] span', '[data-test-tab]', '[data-test-menuitem]', '[data-test-check]']) {
    const target = page.locator(selector).first();
    await target.waitFor({ state: 'visible' });
    assert.equal(await drag(target), '', `${selector} should not select text`);
  }
  assert.notEqual(await drag(page.locator('[data-test-content]')), '', 'body content remains selectable');
  await page.getByText('当前会话乙').first().click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: '重命名' }).click({ timeout: 5000 });
  const rename = page.locator('.session-rename-input');
  await rename.waitFor({ state: 'visible' });
  await rename.focus();
  await rename.press('ControlOrMeta+A');
  assert.equal(await rename.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), '当前会话乙');
  await rename.press('Escape');
  await page.locator('.left-panel .panel-header.sub').first().hover();
  await page.getByRole('button', { name: '搜索工作会话' }).click({ timeout: 5000 });
  const input = page.getByRole('searchbox', { name: '搜索工作会话' });
  await input.fill('可选择的搜索文字');
  await input.focus();
  await input.press('ControlOrMeta+A');
  assert.equal(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), '可选择的搜索文字');
  await capture('sidebar');
}
