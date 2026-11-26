import { test, expect } from './fixtures/electron';

test('HTML thumbnail captures script-rendered content without a host bridge or network', async ({ appCtx }) => {
  const { win, app } = appCtx;
  const more = win.getByRole('button', { name: '展开更多工具' });
  if (await more.isVisible()) await more.click();
  await win.getByRole('treeitem', { name: '媒体创作台' }).click();
  const trust = win.getByRole('button', { name: '信任开发目录' });
  if (await trust.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) await trust.click();
  const panel = win.frameLocator('iframe.ext-panel-frame').locator('.md-root');
  await expect(panel).toBeVisible({ timeout: 30000 });
  const thumbnail = await panel.evaluate(async () => {
    const ma = (window as unknown as { ma: { exports: { thumbnailHtml(html: string): Promise<{ dataUrl: string }> } } }).ma;
    return ma.exports.thumbnailHtml(`<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:red}</style><body>
      <script>
      if (!window.api && !window.ma && !window.__maUiHost && typeof require === 'undefined' && typeof process === 'undefined') {
        fetch('http://127.0.0.1:1/private').catch(() => document.body.style.background = 'rgb(12, 200, 80)');
      }
      </script>`);
  });
  expect(thumbnail.dataUrl).toMatch(/^data:image\/png;base64,/);
  const pixels = await app.evaluate(({ nativeImage }, dataUrl) => {
    const image = nativeImage.createFromDataURL(dataUrl);
    const size = image.getSize();
    const pixel = image.toBitmap().subarray((150 * size.width + 240) * 4, (150 * size.width + 240) * 4 + 4);
    return { size, bgra: Array.from(pixel) };
  }, thumbnail.dataUrl);
  expect(pixels.size).toEqual({ width: 480, height: 300 });
  expect(pixels.bgra).toEqual([80, 200, 12, 255]);
});
