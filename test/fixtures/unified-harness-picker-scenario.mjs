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
  await editor.getByRole('button', { name: /Deep Model · 高/ }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiFixture.calls.findLast(call =>
    call.path === 'workerRouting.reference')?.args[0].config.model?.providerId), 'fixture-team');
  assert.equal(await page.evaluate(() => window.__uiFixture.sent.length), 0);

  await page.getByRole('button', { name: '打开任务表单' }).click();
  const original = page.locator('.new-task-dialog:has(.new-task-environment)');
  await original.getByRole('textbox', { name: '任务' }).fill('Keep the original task');
  // Playwright's trial click waits for the original dialog's opening transform to settle.
  await original.getByRole('button', { name: '选择 Harness 和模型' }).click({ trial: true });
  const formBounds = await original.boundingBox();
  await original.getByRole('button', { name: '选择 Harness 和模型' }).click();
  const launch = page.getByRole('dialog', { name: '选择 Harness 和模型' });
  await launch.getByRole('tab', { name: 'Muster Core' }).waitFor();
  await launch.getByRole('searchbox').press('ArrowDown');
  await currentColumn('harness');
  await key('ArrowRight');
  await currentColumn('models');
  const modelList = launch.getByRole('listbox', { name: '模型' });
  await modelList.getByRole('group', { name: '团队服务' }).waitFor();
  await page.mouse.move(1, 1);
  await capture('new-task-models');
  const footerRule = await launch.locator('.harness-picker-actions').evaluate(node => {
    const { borderBlockStartStyle, borderBlockStartWidth, borderBlockStartColor } = getComputedStyle(node);
    return { width: parseFloat(borderBlockStartWidth), style: borderBlockStartStyle, color: borderBlockStartColor };
  });
  const dividerColor = await launch.evaluate(node => {
    const sample = document.createElement('span');
    sample.style.color = 'color-mix(in srgb, var(--divider-rest) 80%, transparent)';
    node.append(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  });
  assert.equal(footerRule.color, dividerColor, 'picker separators should use the resting divider color at reduced opacity');
  for (const [provider, initial, model] of [['账户 A', '账', 'Swift Model'], ['团队服务', '团', 'Deep Model']]) {
    const group = modelList.getByRole('group', { name: provider });
    const mark = group.locator('.model-catalog-group-initial');
    assert.equal(await mark.textContent(), initial);
    const markBounds = await mark.boundingBox();
    const nameBounds = await group.getByText(provider, { exact: true }).boundingBox();
    assert.ok(markBounds.x + markBounds.width <= nameBounds.x, `${provider} should follow its initial`);
    const heading = await group.locator('.model-catalog-group-heading').evaluate(node => {
      const { right } = node.getBoundingClientRect();
      const { backgroundColor, borderBlockEndWidth } = getComputedStyle(node);
      const line = getComputedStyle(node, '::after');
      return { right, backgroundColor, borderBlockEndWidth, lineLength: parseFloat(line.width),
        rule: { width: parseFloat(line.borderBlockStartWidth), style: line.borderBlockStartStyle, color: line.borderBlockStartColor } };
    });
    const option = await group.getByRole('option', { name: model }).evaluate(node => {
      const text = document.createRange();
      text.selectNodeContents(node);
      return { textStart: text.getBoundingClientRect().left, backgroundColor: getComputedStyle(node).backgroundColor };
    });
    assert.ok(Math.abs(markBounds.x - option.textStart) <= 1, `${provider} icon should align with the model column`);
    assert.equal(heading.backgroundColor, option.backgroundColor, `${provider} should sit on the list surface`);
    assert.deepEqual(heading.rule, footerRule, `${provider} divider should match the picker separators`);
    assert.equal(heading.borderBlockEndWidth, '0px');
    assert.ok(heading.lineLength >= 12 && heading.right - heading.lineLength >= nameBounds.x + nameBounds.width - 1,
      `${provider} divider should extend to the right of its name`);
  }
  await chooseTeamModel();
  await capture('new-task');
  assert.equal(await original.locator('.harness-picker').count(), 0);
  assert.deepEqual(await original.boundingBox(), formBounds);
  assert.equal(await launch.isVisible(), true);
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
