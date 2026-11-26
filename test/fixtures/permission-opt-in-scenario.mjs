import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function ({ page, capture, assert, width }) {
  const assets = fileURLToPath(new URL('../../src/renderer/src/assets/harness-brands/', import.meta.url));
  await page.route('**/assets/harness-brands/*', route => route.fulfill({ path: path.join(assets, path.basename(new URL(route.request().url()).pathname)) }));
  await page.evaluate(() => window.__mountPermissionFixture());
  await page.getByRole('button', { name: '权限模式' }).click();
  const panel = page.getByRole('dialog', { name: '权限模式' });
  const toggle = panel.getByRole('switch', { name: '配置权限' });
  await toggle.waitFor();
  await page.waitForFunction(() => !document.querySelector('.permission-config-switch')?.disabled);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await page.getByRole('combobox', { name: '权限模式' }).count(), 0);
  assert.equal(await page.evaluate(() => window.__uiFixture.calls.filter(name => name === 'agentSession.describeNativeConfig').length), 0);
  await capture('default-full-access');
  await toggle.focus();
  await page.keyboard.press('Space');
  const permission = page.getByRole('combobox', { name: '权限模式' });
  await permission.waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await permission.click();
  await page.getByRole('option', { name: 'Always Ask', exact: true }).click();
  assert.match(await permission.locator('.c-select-button').innerText(), /Always Ask/);
  await page.waitForFunction(() => {
    const select = document.querySelector('select.native-config-select-menu');
    return select && getComputedStyle(select, '::picker(select)').display === 'none';
  });
  await capture('configured-permissions');
  const popup = await panel.boundingBox();
  for (const field of await page.locator('.native-config-field').all()) {
    const box = await field.boundingBox();
    assert.ok(box.width > 0 && box.x >= popup.x && box.x + box.width <= popup.x + popup.width + 1);
    assert.ok(box.x >= 0 && box.x + box.width <= width);
  }
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '权限模式' }).click();
  await permission.waitFor();
  await page.waitForFunction(() => document.querySelector('.native-config-fields')?.getAttribute('aria-busy') === 'false');
  assert.match(await permission.locator('.c-select-button').innerText(), /Always Ask/);
  await toggle.focus();
  await page.keyboard.press('Space');
  await permission.waitFor({ state: 'hidden' });
  await capture('disabled-again');
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  await page.waitForFunction(() => window.__uiFixture.starts.length === 1);
  const advanced = await page.evaluate(() => window.__uiFixture.starts[0].advanced);
  assert.equal(advanced.configurePermissions, false);
  assert.equal(advanced.nativeConfig, undefined);
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.unmocked), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
}
