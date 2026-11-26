import { fileURLToPath } from 'node:url';

export default async function ({ page, capture, assert, width }) {
  await page.route('**/assets/harness-brands/claude.svg', route => route.fulfill({
    path: fileURLToPath(new URL('../../src/renderer/src/assets/harness-brands/claude.svg', import.meta.url))
  }));
  await page.evaluate(() => window.__mountNativeConfigLaunch());
  const harness = page.getByRole('button', { name: '选择 Harness 和模型', exact: true });
  const permission = page.getByRole('combobox', { name: '权限模式', exact: true });
  await permission.waitFor();
  const refresh = page.getByRole('button', { name: '刷新引擎设置', exact: true });
  assert.equal(await refresh.innerText(), '');
  assert.equal(await refresh.getAttribute('title'), '刷新引擎设置');
  assert.equal(await page.locator('.native-config-field-heading').first().getByRole('button', { name: '刷新引擎设置' }).count(), 1);
  assert.equal(await page.locator('.native-config-fields > button').count(), 0);
  const checkGeometry = async () => {
    const harnessBox = await harness.boundingBox();
    for (const field of await page.locator('.native-config-field').all()) {
      const box = await field.boundingBox();
      assert.ok(Math.abs(box.width - harnessBox.width) < 1, `native field ${box.width}px must match Harness ${harnessBox.width}px`);
      assert.ok(box.x >= 0 && box.x + box.width <= width);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  };
  await checkGeometry();
  await capture('single-setting');
  await permission.click();
  await page.getByRole('option', { name: 'Accept Edits', exact: true }).click();
  assert.match(await permission.locator('.c-select-button').innerText(), /Accept Edits/);
  await permission.click();
  await page.getByRole('option', { name: 'Always Ask', exact: true }).waitFor();
  assert.equal(await page.locator('.c-select-option-description').count(), 0);
  await capture('native-options');
  await page.keyboard.press('Escape');
  await harness.click();
  const picker = page.getByRole('dialog', { name: '选择 Harness 和模型' });
  await picker.getByRole('tab', { name: /CodeBuddy Code/ }).click();
  await picker.getByRole('button', { name: '确认配置' }).click();
  await page.getByRole('combobox', { name: '多任务', exact: true }).waitFor();
  await page.getByRole('combobox', { name: '沙箱', exact: true }).waitFor();
  await checkGeometry();
  await capture('multiple-settings');
}
