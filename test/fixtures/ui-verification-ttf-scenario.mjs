export default async function ({ page, assert }) {
  assert.equal(await page.evaluate(() => document.fonts.check('400 14px "Fixture TTF"', 'TrueType fixture')), true);
  assert.match(await page.locator('.ttf-fixture').getAttribute('data-raw'), /Raw fixture source must never execute/);
}
