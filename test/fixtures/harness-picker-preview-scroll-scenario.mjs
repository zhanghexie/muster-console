import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function ({ page, capture, assert, width }) {
  const assets = fileURLToPath(new URL('../../src/renderer/src/assets/harness-brands/', import.meta.url));
  await page.route('**/assets/harness-brands/*', route =>
    route.fulfill({ path: path.join(assets, path.basename(new URL(route.request().url()).pathname)) }));
  await page.evaluate(() => { window.__uiFixture.delayedCodexPreview = true; });
  const editor = page.locator('.composer-editable');
  await editor.pressSequentially('Use /harness');
  await page.getByRole('option', { name: /\/harness/ }).waitFor();
  await editor.press('Enter');
  const dialog = page.getByRole('dialog', { name: '插入模型引用' });
  const modelColumn = dialog.locator('[data-picker-column="models"]');
  await dialog.getByRole('tab', { name: 'Codex', exact: true }).click();
  await dialog.locator('[data-picker-choice="reasoning:value:high"]').waitFor({ state: 'attached' });
  if (!await modelColumn.isVisible()) await page.keyboard.press('ArrowRight');
  await modelColumn.waitFor();
  const selectedRow = () => modelColumn.locator('[aria-selected="true"]').innerText();
  const beforeWheel = await selectedRow();
  const bounds = await modelColumn.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 460);
  await page.waitForFunction(() => document.querySelector('[data-picker-column="models"]').scrollTop > 100);
  assert.equal(await selectedRow(), beforeWheel);
  await page.mouse.wheel(0, -800);
  await page.waitForFunction(() => document.querySelector('[data-picker-column="models"]').scrollTop === 0);
  await page.mouse.move(1, 1);

  await modelColumn.getByRole('option', { name: '跟随引擎默认' }).focus();
  await capture('settled-before');
  await page.evaluate(() => {
    const dialog = document.querySelector('.worker-target-dialog');
    const model = dialog.querySelector('[data-picker-column="models"]');
    const params = dialog.querySelector('[data-picker-column="parameters"]');
    const rect = node => node ? Array.from(['x', 'y', 'width', 'height'], key => Math.round(node.getBoundingClientRect()[key] * 100) / 100) : null;
    const state = { frames: [], running: true };
    const sample = () => {
      const parameter = dialog.querySelector('[data-picker-column="parameters"]');
      const focused = document.activeElement;
      const focusedRect = focused.getBoundingClientRect();
      const columnRect = model.getBoundingClientRect();
      state.frames.push({ dialog: rect(dialog), model: rect(model), parameters: rect(parameter), sameDialog: dialog.isConnected,
        sameParameters: parameter === params, activeModel: model.contains(focused), selected: focused.getAttribute('aria-selected'),
        focusVisible: focusedRect.top >= columnRect.top - 1 && focusedRect.bottom <= columnRect.bottom + 1,
        scroll: model.scrollTop, canConfirm: !dialog.querySelector('.harness-picker-actions .primary').disabled });
      if (state.running) requestAnimationFrame(sample);
    };
    sample();
    window.__pickerProbe = state;
  });
  for (let index = 0; index < 13; index++) await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => window.__pickerProbe.frames.some(frame => !frame.canConfirm));
  await capture('preview-in-flight', { animations: 'allow' });
  for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => window.__pickerProbe.frames.at(-1)?.canConfirm);
  const frames = await page.evaluate(() => {
    window.__pickerProbe.running = false;
    return window.__pickerProbe.frames;
  });
  await capture('settled-after');
  const boundsFor = part => [...new Set(frames.map(frame => JSON.stringify(frame[part])))].map(JSON.parse);
  const summary = { frames: frames.length, pendingFrames: frames.filter(frame => !frame.canConfirm).length,
    dialog: boundsFor('dialog'), model: boundsFor('model'), parameters: boundsFor('parameters'),
    modelScroll: [Math.min(...frames.map(frame => frame.scroll)), Math.max(...frames.map(frame => frame.scroll))],
    invisibleFocusFrames: frames.filter(frame => !frame.focusVisible).length };
  console.log('Picker frame geometry', JSON.stringify(summary));
  assert.ok(summary.pendingFrames > 0, JSON.stringify(summary));
  assert.ok(summary.modelScroll[1] > 0, JSON.stringify(summary));
  assert.equal(summary.dialog.length, 1, JSON.stringify(summary));
  assert.equal(summary.model.length, 1, JSON.stringify(summary));
  assert.equal(summary.parameters.length, 1, JSON.stringify(summary));
  assert.ok(frames.every(frame => frame.sameDialog && frame.sameParameters && frame.activeModel && frame.focusVisible), JSON.stringify(summary));
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'radio');
  await page.keyboard.press('End');
  if (width <= 390) await capture('parameter-ready');
  await page.keyboard.press('Enter');
  await editor.getByRole('button', { name: /Codex · GUI · Codex model 8 · 高/ }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiFixture.sent.length), 0);
}
