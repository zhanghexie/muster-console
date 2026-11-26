export default async function ({ page, capture, assert }) {
  await page.bringToFront();
  await page.getByRole('button', { name: '展示信纸' }).click();
  await page.waitForFunction(() => document.querySelector('.mail-envelope-scene')?.dataset.phase === 'preview');
  await page.locator('.mail-letter').first().waitFor();
  assert.equal(await page.locator('.read-mail-letter-body strong').count(), 3);
  assert.equal(await page.locator('.mail-letter-body strong').count(), 6);
  const geometry = await page.locator('.mail-letter').evaluateAll(els => els.map(el => {
    const slice = el.closest('.es-letter-slice'); const body = el.querySelector('.mail-letter-body');
    return { height: el.offsetHeight, slice: slice.offsetHeight, width: el.offsetWidth, bodyWidth: body.clientWidth, scrollWidth: body.scrollWidth, overflow: getComputedStyle(body).overflow, footer: el.querySelector('.mail-letter-footer').offsetTop, bodyBottom: body.offsetTop + body.offsetHeight };
  }));
  assert.ok(geometry.every(g => g.height === g.slice && g.width === geometry[0].width && g.height === geometry[0].height && g.overflow === 'hidden' && g.bodyBottom <= g.footer), 'Markdown cannot expand or desynchronize fixed paper slices');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(await page.locator('.read-mail-letter').first().evaluate(el => el.getBoundingClientRect().right <= innerWidth), 'mail bubble must stay inside viewport');
  assert.ok(await page.locator('.read-mail-letter-body pre').first().evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === 'auto'), 'long code scrolls within the bubble');
  await capture('markdown-after');
}
