export default async function ({ page, capture, assert }) {
  const select = page.getByRole('combobox', { name: '选择工作区' });
  await select.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('select:open'));
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.activeElement?.textContent === '工作区 20');
  await capture('listbox-end');
  await page.keyboard.press('Escape');
  await select.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('select:open'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('select:open'));

  const tooltipTrigger = page.getByRole('button', { name: '工作区状态' });
  await page.keyboard.press('Tab');
  assert.equal(await tooltipTrigger.evaluate(el => el === document.activeElement), true);
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  await capture('tooltip-focus');
  await page.keyboard.press('Escape');
  await tooltip.waitFor({ state: 'hidden' });
  assert.equal(await tooltipTrigger.evaluate(el => el === document.activeElement), true);
  await capture('tooltip-escape');

  const menuTrigger = page.getByRole('button', { name: '工作区菜单' });
  const parentItem = page.locator('.ctx-menu:not(.ctx-flyout) .ctx-item');
  const flyout = page.getByRole('menu', { name: '移动到' });
  await menuTrigger.click();
  await parentItem.hover();
  await flyout.waitFor();
  assert.equal(await menuTrigger.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowRight');
  assert.equal(await flyout.getByRole('menuitem', { name: '归档工作区' }).evaluate(el => el === document.activeElement), true);
  await capture('submenu-keyboard');
  await page.keyboard.press('Escape');
  await flyout.waitFor({ state: 'hidden' });
  assert.equal(await parentItem.evaluate(el => el === document.activeElement), true);
  await capture('submenu-return');
}
