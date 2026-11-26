export default async function ({ page, capture, assert }) {
  const states = () => page.locator('.brand-loader').evaluate(root =>
    [...root.querySelectorAll('.brand-loader-core, .brand-loader-orbit')].map(node => getComputedStyle(node).animationPlayState));
  assert.deepEqual(await states(), ['paused', 'paused']);
  await page.getByRole('button', { name: '切换外层', exact: true }).click();
  assert.deepEqual(await states(), ['running', 'running']);
  const before = await page.locator('.brand-loader-orbit').evaluate(node => node.getAnimations()[0].currentTime);
  await page.waitForFunction(time => document.querySelector('.brand-loader-orbit').getAnimations()[0].currentTime > time, before);
  await capture('visible-loader', { animations: 'allow' });
  await page.getByRole('button', { name: '切换内层', exact: true }).click();
  assert.deepEqual(await states(), ['paused', 'paused']);
  await page.getByRole('button', { name: '切换外层', exact: true }).click();
  await page.getByRole('button', { name: '切换内层', exact: true }).click();
  assert.deepEqual(await states(), ['paused', 'paused'], 'a selected inner view cannot restart a hidden outer view');
  for (let dock = 0; dock < 2; dock++) {
    await page.locator('[data-testid="far-focus"]').evaluate(node => { node.focus(); node.scrollIntoView(); });
    assert.deepEqual(await page.locator('.main-view, .work-area').evaluateAll(nodes => nodes.map(node => node.scrollLeft)), [0, 0], 'focus/scrollIntoView cannot scroll the clipped ancestors');
    await page.getByRole('button', { name: '切换虚拟屏', exact: true }).click();
  }
  await page.evaluate(() => document.documentElement.dataset.uiMotion = 'reduced');
  assert.equal(await page.locator('.brand-loader-orbit').evaluate(node => getComputedStyle(node).animationName), 'none');
}
