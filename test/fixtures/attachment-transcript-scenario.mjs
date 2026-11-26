export default async function ({ page, capture, assert }) {
  await page.getByText('项目研究报告与会议记录.pdf', { exact: true }).waitFor();
  assert.ok(await page.getByText('帮我总结这份报告', { exact: true }).count());
  assert.doesNotMatch((await page.locator('.chat-body').allInnerTexts()).join('\n'), /Attachment metadata|MODEL ONLY|sourcePath/);
  const image = page.getByAltText('image.png');
  await image.waitFor({ state: 'visible' });
  assert.ok(await image.evaluate(el => el.complete && el.naturalWidth > 0));
  await capture('attachment-card');
}
