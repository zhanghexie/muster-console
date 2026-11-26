const wrapText = '窗口宽度变化时文字需要重新换行。'.repeat(6);
const restoredText = ['程序写入第一行。', '表单隐藏期间发生更新。', '重新显示后完整可读。', '最后一行。'].join('\n');

export default async function ({ page, capture, assert }) {
  const viewport = page.viewportSize();
  const field = page.locator('.feedback-editor > label', { hasText: '使用场景' }).locator('textarea');
  const readField = () => field.evaluate(el => ({
    height: el.clientHeight,
    width: el.clientWidth,
    contentHeight: el.scrollHeight,
    inlineHeight: el.style.height,
    fieldSizing: getComputedStyle(el).getPropertyValue('field-sizing')
  }));

  async function verify(mode) {
    await field.waitFor();
    const initial = await readField();
    assert.equal(initial.fieldSizing, mode === 'native' ? 'content' : 'fixed');
    assert.equal(initial.inlineHeight === '', mode === 'native');

    await field.fill(wrapText);
    await field.scrollIntoViewIfNeeded();
    const wrapped = await readField();
    assert.equal(wrapped.width, initial.width, 'content only changes the block size');
    assert.ok(wrapped.height > initial.height + 10, 'the field grows as text wraps');
    assert.ok(wrapped.contentHeight <= wrapped.height + 1, 'wrapped content fits within the field');

    const startIsNarrow = viewport.width < 650;
    await page.setViewportSize({ ...viewport, width: startIsNarrow ? 780 : 320 });
    const comparison = wrapped.height;
    await page.waitForFunction(({ comparison, startIsNarrow }) => {
      const editor = document.querySelector('.feedback-editor');
      const field = [...editor.querySelectorAll('label')].find(label => label.textContent.includes('使用场景')).querySelector('textarea');
      return startIsNarrow ? field.clientHeight < comparison - 10 : field.clientHeight > comparison + 10;
    }, { comparison, startIsNarrow });
    const resized = await readField();
    assert.ok(resized.contentHeight <= resized.height + 1, 'the new width still fits the original text');
    await page.setViewportSize(viewport);
    await page.waitForFunction(width => [...document.querySelectorAll('.feedback-editor textarea')].every(field => Math.abs(field.clientWidth - width) <= 1), initial.width);
    await field.scrollIntoViewIfNeeded();
    await capture(`${mode}-wrapped`);

    await field.fill('');
    const empty = await readField();
    assert.equal(empty.height, initial.height, 'empty text returns to the one-line minimum');
    await capture(`${mode}-empty`);

    const editor = page.locator('.feedback-editor');
    await editor.evaluate(el => { el.style.display = 'none'; });
    await field.waitFor({ state: 'hidden' });
    // Let Chromium deliver the hidden width to the existing ResizeObserver fallback.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(value => window.__updateFeedbackContext(value), restoredText);
    await page.waitForFunction(text => [...document.querySelectorAll('.feedback-editor textarea')].some(field => field.value === text), restoredText);
    await editor.evaluate(el => { el.style.removeProperty('display'); });
    await field.waitFor();
    await field.scrollIntoViewIfNeeded();
    await page.waitForFunction(text => {
      const field = [...document.querySelectorAll('.feedback-editor textarea')].find(field => field.value === text);
      return field && field.clientHeight > 40 && field.scrollHeight <= field.clientHeight + 1;
    }, restoredText);
    assert.equal(await field.inputValue(), restoredText);
    await capture(`${mode}-restored`);
  }

  assert.equal(await page.evaluate(() => CSS.supports('field-sizing', 'content')), true, 'the Chromium fixture supplies native sizing');
  await verify('native');

  // Measure the existing JS fallback with real Chromium layout and observers.
  const nativeField = await field.elementHandle();
  await page.addStyleTag({ content: '.feedback-editor textarea { field-sizing: fixed !important; }' });
  await page.evaluate(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args) => args[0] === 'field-sizing' ? false : supports(...args);
    window.__remountFeedback();
  });
  await page.waitForFunction(el => !el.isConnected, nativeField);
  await nativeField.dispose();
  await verify('fallback');
}
