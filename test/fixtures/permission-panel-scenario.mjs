export default async function ({ page, capture, assert }) {
  const core = page.getByRole('button', { name: '权限模式', exact: true });
  await core.waitFor();
  assert.equal(await page.getByRole('switch').count(), 0);
  await core.click();
  await capture('core-off');
  await page.getByRole('switch').click();
  await page.getByRole('menuitemradio', { name: '标准', exact: true }).waitFor();
  await capture('core-on');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__setNativeFixture(true));
  const native = page.getByRole('button', { name: '引擎设置', exact: true });
  await native.click();
  await page.getByRole('switch').click();
  await page.getByRole('combobox', { name: '权限模式', exact: true }).waitFor();
  await capture('native-on');
  await page.getByRole('switch').click();
  await page.evaluate(() => { window.__uiFixture.reject = true; });
  await page.getByRole('switch').click();
  await page.locator('.app-tip').waitFor();
  assert.equal(await page.locator('.agent-composer .app-tip').count(), 0);
  await capture('transient-tip');
  await page.locator('.app-tip').waitFor({ state: 'detached', timeout: 6000 });
  await capture('tip-dismissed');
  assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'false');
}
