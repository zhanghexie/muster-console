export default async function ({ page, capture, assert, width }) {
  const action = page.getByRole('button', { name: '开发' }); await action.waitFor();
  await action.click(); await page.getByRole('menuitem', { name: /启动开发环境/ }).waitFor();
  await capture('menu');
  await page.getByRole('menuitem', { name: /启动开发环境/ }).click();
  const more = page.getByTitle('还有 1 个扩展动作'); await more.click();
  await page.getByRole('button', { name: /发布/ }).waitFor();
  const box = await page.getByRole('menu').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `overflow menu stays in the viewport at ${width}px`);
  await capture('overflow');
  await page.getByRole('button', { name: /发布/ }).click();
  const submenu = page.getByRole('menuitem', { name: /发布项目/ }); await submenu.waitFor();
  const subBox = await submenu.locator('..').boundingBox();
  assert.ok(subBox && subBox.x >= 0 && subBox.x + subBox.width <= width + 1, `overflow submenu stays in the viewport at ${width}px`);
  await capture('overflow-submenu');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, `no horizontal overflow at ${width}px`);
}
