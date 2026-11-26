export default async function ({ page, capture, assert }) {
  await page.getByLabel('FFmpeg 路径').fill('C:\\Tools\\ffmpeg.exe');
  await page.getByLabel('LibreOffice 路径').fill('C:\\Tools\\soffice.exe');
  assert.equal(await page.getByLabel('FFmpeg 路径').inputValue(), 'C:\\Tools\\ffmpeg.exe');
  await page.getByLabel('每条消息自动预览页数').fill('2');
  assert.equal(await page.getByLabel('每条消息自动预览页数').inputValue(), '2');
  await capture('global-tools');
  await page.getByLabel('视频采样间隔（秒）').scrollIntoViewIfNeeded();
  await capture('global-processing');
}
