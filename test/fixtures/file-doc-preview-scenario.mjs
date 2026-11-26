import assert from 'node:assert/strict';

export default async function ({ page, width, capture }) {
  const tabs = page.getByRole('tablist', { name: 'report.xlsx' });
  const first = tabs.getByRole('tab', { name: /Quarterly overview/ });
  const last = tabs.getByRole('tab', { name: /Extra details/ });
  const table = page.getByRole('tabpanel', { name: /Quarterly overview/ });
  await table.getByText('3.5%').waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await first.evaluate(el => el === document.activeElement), true);
  const rowPositions = await tabs.getByRole('tab').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top));
  assert.equal(new Set(rowPositions).size, 1);
  await capture('workbook');

  await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.getByRole('tab', { name: /Annual budget/ }).evaluate(el => el === document.activeElement), true);
  assert.equal(await first.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await last.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await last.getAttribute('aria-selected'), 'true');
  const tabStrip = await tabs.boundingBox();
  const activatedTab = await last.boundingBox();
  assert.ok(activatedTab.x >= tabStrip.x - 1 && activatedTab.x + activatedTab.width <= tabStrip.x + tabStrip.width + 1,
    'activation reveals the complete tab even when it was partly visible');
  await page.getByRole('tabpanel', { name: /Extra details/ }).getByText('25,000').waitFor();
  await capture('last-sheet');

  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  assert.equal(await table.evaluate(el => el === document.activeElement), true);
  if (width < 500) {
    assert.equal(await table.evaluate(el => el.scrollWidth > el.clientWidth), true);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
    await capture('table-scroll');
  }
  const markdown = page.locator('.md-body').getByRole('region', { name: '表格' });
  await page.keyboard.press('Tab');
  assert.equal(await markdown.evaluate(el => el === document.activeElement), true);
  assert.equal(await markdown.getByRole('columnheader', { name: '最后一列' }).getAttribute('scope'), 'col');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), true);
  if (width < 500) {
    assert.equal(await markdown.evaluate(el => el.scrollWidth > el.clientWidth), true);
    assert.ok((await markdown.getByRole('columnheader', { name: '项目' }).boundingBox()).width > 40,
      'CJK headers should keep words together while the table scrolls');
    for (let i = 0; i < 16; i++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => {
      const scroller = document.activeElement;
      return scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
    });
  }
  await capture('markdown-table');
}
