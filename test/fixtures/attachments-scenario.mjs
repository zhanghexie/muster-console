export default async function ({ page, capture, assert }) {
  await page.locator('input[type=file]').setInputFiles([
    { name: '项目说明与本地转换验证.txt', mimeType: 'text/plain', buffer: Buffer.from('text') },
    { name: '研究报告.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') }
  ]);
  await page.getByText('研究报告.pdf', { exact: true }).waitFor();
  await page.getByLabel('原生音频输入').check();
  assert.equal(await page.getByLabel('原生音频输入').isChecked(), true);
  await capture('files-and-policy');
}
