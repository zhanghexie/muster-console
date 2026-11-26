import { fileURLToPath } from 'node:url';
import path from 'node:path';

export default async function ({ page, capture, assert, theme, width }) {
  const assetDirectory = fileURLToPath(new URL('../../src/renderer/src/assets/harness-brands/', import.meta.url));
  await page.route('**/assets/harness-brands/*', route =>
    route.fulfill({ path: path.join(assetDirectory, path.basename(new URL(route.request().url()).pathname)) }));
  const editor = page.locator('.composer-editable');
  await editor.click();
  await page.keyboard.type('Use /harness');
  await page.getByRole('option', { name: /\/harness/ }).waitFor();
  await capture('harness-command');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '插入模型引用' });
  await dialog.waitFor();
  await dialog.getByRole('tab', { name: 'Muster Core' }).focus();
  await page.keyboard.press('ArrowRight');
  const model = dialog.getByRole('option', { name: '团队服务 · Deep Model' });
  await model.click();
  await page.keyboard.press('ArrowRight');
  const high = dialog.getByRole('radio', { name: '高', exact: true });
  await high.waitFor();
  await high.click();
  await capture('picker');
  await dialog.getByRole('button', { name: '插入引用' }).click();
  const chip = editor.getByRole('button', { name: /团队服务 · Deep Model · 高/ });
  await chip.waitFor();
  await capture('harness-reference');
  await page.keyboard.press('Control+z');
  assert.equal(await editor.innerText(), 'Use /harness');
  await dialog.waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+y');
  await chip.waitFor();
  await page.keyboard.type('for the next task');
  await page.keyboard.press('Control+z');
  assert.match(await editor.innerText(), /团队服务 · Deep Model/);
  await page.keyboard.press('Control+y');
  assert.match(await editor.innerText(), /for the next task/);
  await page.evaluate(() => { window.__uiFixture.expire = true; });
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: '已失效' }).waitFor();
  await capture('expired');
  assert.equal(await page.evaluate(() => window.__uiFixture.sent.length), 0);
  await chip.focus();
  await page.keyboard.press('Enter');
  const edit = page.getByRole('dialog', { name: '编辑模型引用' });
  await edit.getByRole('searchbox').waitFor();
  await edit.getByText('查看调用方法').click();
  assert.match(await edit.locator('code').innerText(), /host\.sessions\.create/);
  await page.keyboard.press('Escape');
  await edit.waitFor({ state: 'hidden' });
  assert.equal(await editor.evaluate(node => node === document.activeElement), true);
  await page.evaluate(() => { window.__uiFixture.expire = false; });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__uiFixture.sent.length === 1);
  const sent = await page.evaluate(() => window.__uiFixture.sent[0]);
  assert.match(sent, /Use \[@model:wr1\.[\w-]{32}:"Muster Core · GUI · 团队服务 · Deep Model · 高"\] for the next task/);

  await page.getByRole('button', { name: '自动派活设置' }).click();
  const light = page.getByRole('group', { name: '低' });
  await light.getByRole('button', { name: '清除冷却' }).waitFor();
  await capture('settings');
  await light.getByRole('button', { name: '清除冷却' }).click();
  await light.getByRole('button', { name: '清除冷却' }).waitFor({ state: 'hidden' });
  await light.getByRole('button', { name: '下移' }).first().focus();
  await page.keyboard.press('Enter');
  const saveButton = page.locator('.settings-savebar button.btn.primary');
  if ((theme === 'dark' && width === 390) || (theme === 'light' && width === 780)) {
    await saveButton.scrollIntoViewIfNeeded();
    await capture('settings-actions');
  }
  await saveButton.click();
  await page.getByRole('status').filter({ hasText: '派活配置已保存' }).waitFor();
  const save = await page.evaluate(() => window.__uiFixture.calls.find(call => call.path === 'workerRouting.save'));
  assert.deepEqual(save.args[0].config.tiers[0].members.map(item => item.id), ['second', 'first']);
  if (theme === 'dark' && width === 390) {
    await page.getByRole('group', { name: '高' }).getByText('已停用').scrollIntoViewIfNeeded();
    await capture('disabled-candidate');
    await light.getByRole('button', { name: '为低添加候选' }).click();
    const add = page.getByRole('dialog', { name: '添加候选配置' });
    await add.getByRole('tab', { name: 'Codex' }).click();
    await add.getByRole('button', { name: '模型', exact: true }).click();
    await add.getByText('尚无模型目录快照，请手动刷新。').waitFor();
    await capture('catalog-empty');
    await page.keyboard.press('Escape');
    await add.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '仅当前工作区' }).click();
    await page.getByText('当前工作区跟随全局默认').waitFor();
    await light.getByRole('checkbox', { name: /启用/ }).first().click();
    await page.getByText('跨 Harness 权限', { exact: true }).click();
    const consent = page.getByRole('checkbox', { name: '允许运行中跨 Harness，使用此候选选定的原生权限' });
    const profile = page.getByRole('combobox', { name: 'Permission Profile' });
    await profile.waitFor();
    await profile.click();
    await page.locator('select:open').waitFor();
    assert.equal(await page.getByRole('option', { name: 'Custom profile' }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await profile.evaluate(node => document.activeElement === node), true);
    assert.equal(await consent.isDisabled(), true);
    for (const [label, option] of [['Permission Profile', ':workspace'], ['Approval Policy', 'on-request'], ['Approvals Reviewer', 'user']]) {
      await page.getByRole('button', { name: label }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    }
    assert.equal(await consent.isChecked(), false);
    await consent.check();
    await consent.scrollIntoViewIfNeeded();
    const captionFits = await consent.evaluate(node => {
      const row = node.closest('label');
      const caption = row.querySelector('span').getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      return caption.width > 100 && caption.right <= bounds.right + 1;
    });
    assert.equal(captionFits, true);
    await capture('cross-harness-consent');
  }
}
