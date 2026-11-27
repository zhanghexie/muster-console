import { PNG } from 'playwright-core/lib/utilsBundle';

export default async function ({ page, capture, assert }) {
  const row = page.getByRole('button').filter({ hasText: 'Update the feature' });
  const dots = page.locator('.git-hist-svg circle');
  await row.waitFor();

  async function readGraphPixels() {
    const [mergeDot, featureDot] = await Promise.all([
      dots.nth(0).boundingBox(),
      dots.nth(1).boundingBox()
    ]);
    const y = Math.floor(featureDot.y + featureDot.height / 2);
    const lineX = Math.floor(mergeDot.x + mergeDot.width / 2);
    const dotX = Math.floor(featureDot.x + featureDot.width / 2);
    const png = PNG.sync.read(await page.screenshot());
    const pixel = x => {
      const offset = (y * png.width + x) * 4;
      return [...png.data.subarray(offset, offset + 3)];
    };
    return { dot: pixel(dotX), line: pixel(lineX), background: pixel(lineX + 4), lineX, y };
  }

  const assertVisible = (pixels, state) => {
    assert.notDeepEqual(pixels.dot, pixels.background, `Commit node is visible ${state}`);
    assert.notDeepEqual(pixels.line, pixels.background, `Passing branch line is visible ${state}`);
  };

  const idle = await readGraphPixels();
  assertVisible(idle, 'at rest');

  // The branch SVG overlays this part of the row. Hover and click through it.
  await page.mouse.move(idle.lineX, idle.y);
  assert.equal(await row.evaluate(element => element.matches(':hover')), true);
  await capture('hover');
  const hovered = await readGraphPixels();
  assert.notDeepEqual(hovered.background, idle.background, 'Hover still highlights the full row');
  assertVisible(hovered, 'on hover');
  assert.deepEqual(hovered.dot, idle.dot, 'Hover preserves the commit node color');

  await page.mouse.click(hovered.lineX, hovered.y);
  await page.locator('.git-hist-row.is-selected').filter({ hasText: 'Update the feature' }).waitFor();
  await page.mouse.move(0, 0);
  assertVisible(await readGraphPixels(), 'when selected');
  await row.hover();
  await capture('selected-hover');
  assertVisible(await readGraphPixels(), 'when selected and hovered');
}
