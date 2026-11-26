export default async function({ page, capture, assert }) {
  await page.getByRole('heading', { name: '语言与文字' }).waitFor();
  assert.equal(await page.locator('.settings-col').evaluate(el => getComputedStyle(el).maxWidth), '1120px', 'General and Agent use the same content width');
  const sections = await page.locator('.settings-content > .s-sec').evaluateAll(els => els.map(el => ({
    border: getComputedStyle(el).borderTopWidth,
    underline: getComputedStyle(el.querySelector('.s-sec-h')).borderBottomWidth,
    gap: el.previousElementSibling ? el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom : 0,
    title: el.querySelector('h2')?.textContent
  })));
  assert.equal(sections.length, 5);
  assert.equal(sections[4].title, '命令行环境', 'Global shell settings live in General');
  assert.ok(sections.every(section => section.border === '0px'), 'Major groups have no block dividers');
  assert.ok(sections.every(section => section.underline === '0px'), 'Section headings have no underline');
  assert.ok(sections.slice(1).every(section => Math.abs(section.gap - 48) <= 1), 'Major groups have 48px of spacing');
  const cards = await page.locator('.settings-content .s-rows').evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
  assert.ok(cards.every(color => color === 'rgba(0, 0, 0, 0)'), 'No background group cards');
  const frames = await page.locator('.settings-content > .s-sec > .settings-group-body').evaluateAll(els => els.map(el => ({ border: getComputedStyle(el).borderTopWidth, radius: getComputedStyle(el).borderTopLeftRadius })));
  assert.ok(frames.length === sections.length && frames.every(frame => frame.border === '1px' && parseFloat(frame.radius) > 0), 'Each section has a rounded content frame');
  await capture('general-top');
  const pane = page.locator('.settings-tabpane[data-settings-item="general"]');
  await pane.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await capture('general-bottom');
  await page.getByRole('button', { name: '查看全部提示', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全部功能提示' });
  await dialog.getByText('搜索历史消息', { exact: true }).waitFor();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, 'Dialog fits the viewport, including narrow layouts');
  assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Dialog has no horizontal content overflow');
  await capture('tips-dialog');
  await dialog.getByRole('searchbox').fill('搜索历史');
  assert.equal(await dialog.locator('li').count(), 1);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '查看全部提示');
  assert.ok(await page.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'No horizontal content overflow');
}
