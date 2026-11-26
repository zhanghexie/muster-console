import { PNG } from 'playwright-core/lib/utilsBundle';

export default async function ({ page, theme, capture, assert }) {
  await page.locator('[data-ready="true"]').waitFor();
  await page.locator('#toggle').click();
  await page.locator('.g-board-sheet:not(.is-peek)').waitFor();
  const pixels = [];
  for (const [name, accent, enabled] of [['neutral', '#9276d8', false], ['purple', '#9276d8', true], ['green', '#5fae83', true], ['off', '#5fae83', false]]) {
    await page.evaluate(({ accent, enabled }) => window.__setBoardAccent(accent, enabled), { accent, enabled });
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().iterations)).map(a => a.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    const sheet = page.locator('.g-board-sheet');
    const colors = await sheet.evaluate(el => {
      const css = getComputedStyle(el);
      const probe = document.createElement('div'); el.append(probe); probe.style.color = 'var(--surface-edge)';
      const expected = getComputedStyle(probe).color; probe.remove();
      return { actual: css.borderTopColor, expected };
    });
    assert.equal(colors.actual, colors.expected, `${theme}/${name}: outer border shares the session surface edge`);
    const box = await sheet.boundingBox();
    const png = PNG.sync.read(await page.screenshot());
    const offset = (Math.round(box.y) * png.width + Math.round(box.x + box.width / 2)) * 4;
    pixels.push(Array.from(png.data.subarray(offset, offset + 3)));
    await capture(`edge-${name}`);
  }
  assert.notDeepEqual(pixels[0], pixels[1], 'enabling accent changes rendered perimeter');
  assert.notDeepEqual(pixels[1], pixels[2], 'switching accent changes rendered perimeter');
  assert.deepEqual(pixels[0], pixels[3], 'disabling accent restores neutral perimeter');
}
