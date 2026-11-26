export default async function ({ page, capture, assert }) {
  const toolbar = page.locator('.agent-composer-toolbar');
  await toolbar.waitFor();
  await capture('empty');
  const sizes = await toolbar.evaluate(el => {
    const selectors = ['.composer-icon-btn', '.agent-mode-chip', '.agent-ctx-ring', '.agent-composer-model-trigger', '.composer-draft-action', '.send-btn-icon'];
    return selectors.map(selector => {
      const item = el.querySelector(selector);
      if (!item) return { selector, missing: true };
      const rect = item.getBoundingClientRect();
      const svg = item.querySelector('svg');
      return { selector, height: rect.height, width: rect.width, bottom: rect.bottom,
        font: getComputedStyle(item).fontSize, icon: svg?.getBoundingClientRect().width };
    });
  });
  for (const item of sizes) {
    assert.ok(!item.missing, `${item.selector} must be rendered`);
    const primary = item.selector === '.send-btn-icon';
    assert.equal(item.height, primary ? 32 : 24, `${item.selector} height`);
    assert.ok(Math.abs(item.bottom - sizes[0].bottom) < 1, `${item.selector} bottom alignment`);
    if (item.icon) assert.equal(item.icon, primary ? 18 : 14, `${item.selector} icon size`);
  }
  assert.equal(sizes[1].font, sizes[3].font, 'permission and model use the same font size');
  assert.ok(sizes[5].width > sizes[4].width, 'send remains larger than the secondary queue action');
  const bounds = await toolbar.evaluate(el => {
    const buttons = [...el.querySelectorAll('button')].filter(b => b.getClientRects().length);
    const rect = el.getBoundingClientRect();
    return buttons.every(b => { const r = b.getBoundingClientRect(); return r.left >= rect.left && r.right <= rect.right; });
  });
  assert.ok(bounds, 'toolbar controls stay inside their container');
  const editor = page.getByRole('textbox');
  await editor.fill('先统一输入框控件尺寸');
  await capture('editing');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.sent), ['先统一输入框控件尺寸']);
}
