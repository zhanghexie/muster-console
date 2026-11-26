import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function ({ page, capture, assert, width }) {
  const assets = fileURLToPath(new URL('../../src/renderer/src/assets/harness-brands/', import.meta.url));
  await page.route('**/assets/harness-brands/*', route =>
    route.fulfill({ path: path.join(assets, path.basename(new URL(route.request().url()).pathname)) }));
  const currentColumn = column => page.waitForFunction(value =>
    document.activeElement?.closest('[data-picker-column]')?.getAttribute('data-picker-column') === value, column);
  const key = name => page.keyboard.press(name);
  const chooseTeamModel = async () => {
    await currentColumn('models');
    await key('End');
    await key('ArrowRight');
    await currentColumn('parameters');
    await key('End');
    if (width <= 390) {
      const summary = page.locator('.harness-picker-narrow-summary:visible');
      assert.match(await summary.innerText(), /Muster Core · 团队服务 · Deep Model/);
    }
  };

  const editor = page.locator('.composer-editable');
  await editor.click();
  await page.keyboard.type('Use /harness');
  await page.getByRole('option', { name: /\/harness/ }).waitFor();
  await key('Enter');
  const reference = page.getByRole('dialog', { name: '插入模型引用' });
  await currentColumn('harness');
  assert.equal(await reference.getByRole('tab', { name: 'Gemini CLI' }).count(), 0);
  await key('ArrowRight');
  await chooseTeamModel();
  await capture('reference');
  await key('Enter');
  await editor.getByRole('button', { name: /团队服务 · Deep Model · 高/ }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiFixture.sent.length), 0);

  await page.getByRole('button', { name: '打开任务表单' }).click();
  const original = page.locator('.new-task-dialog:has(.new-task-environment)');
  await original.getByRole('textbox', { name: '任务' }).fill('Keep the original task');
  // Playwright's trial click waits for the original dialog's opening transform to settle.
  await original.getByRole('button', { name: '选择 Harness 和模型' }).click({ trial: true });
  const formBounds = await original.boundingBox();
  await original.getByRole('button', { name: '选择 Harness 和模型' }).click();
  await currentColumn('harness');
  await key('ArrowRight');
  await chooseTeamModel();
  await capture('new-task');
  assert.equal(await original.locator('.harness-picker').count(), 0);
  assert.deepEqual(await original.boundingBox(), formBounds);
  assert.equal(await page.getByRole('dialog', { name: '选择 Harness 和模型' }).isVisible(), true);
  await key('Enter');
  await original.getByRole('textbox', { name: '任务' }).waitFor();
  assert.equal(await original.getByRole('textbox', { name: '任务' }).innerText(), 'Keep the original task');
  assert.equal(await page.evaluate(() => window.__uiFixture.taskStarts), 0);
  await original.getByRole('button', { name: '关闭新建任务' }).click();
  await original.waitFor({ state: 'hidden' });

  const trigger = page.getByRole('button', { name: '模型与参数' });
  await page.locator('.agent-composer').evaluate(composer => { composer.style.marginTop = 'max(12px, calc(100vh - 235px))'; });
  await trigger.click();
  const session = page.getByRole('dialog', { name: '模型与参数' });
  assert.equal(await session.getByRole('tablist', { name: 'Harness' }).count(), 0);
  await chooseTeamModel();
  await capture('current-session');
  const bounds = await session.boundingBox();
  const size = page.viewportSize();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width + 1 && bounds.y + bounds.height <= size.height + 1);
  assert.equal(await page.evaluate(() => window.__uiFixture.modelChanges.length), 0);
  await key('Enter');
  await session.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.modelChanges), [{ expected: 'fixture:1',
    model: { providerId: 'fixture-team', modelId: 'deep-model' }, parameters: { reasoning: 'high' } }]);
  assert.equal(await trigger.evaluate(button => button === document.activeElement), true);
}
