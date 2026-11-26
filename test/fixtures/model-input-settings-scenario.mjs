export default async function ({ page, capture, assert }) {
  await page.getByRole('heading', { name: '模型服务商', exact: true, level: 2 }).waitFor();
  await capture('providers');
  await page.getByLabel('FFmpeg 路径').scrollIntoViewIfNeeded();
  assert.ok(await page.getByLabel('FFmpeg 路径').isVisible());
  await capture('global-input');
}
