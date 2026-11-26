import { execFileSync } from 'node:child_process';
const video = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=2', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'], { windowsHide: true });
export default async function ({ page, capture, assert }) {
  await page.route('**/media/ext/**', route => route.fulfill({ status: 200, contentType: 'video/webm', body: video }));
  await page.getByRole('button', { name: '加载附件' }).click();
  const player = page.locator('video');
  await player.evaluate(async el => { await el.play(); });
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.15);
  await player.evaluate(el => el.pause());
  assert.ok(await player.evaluate(el => el.videoWidth === 320 && el.paused));
  const box = await player.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width, 'video stays inside the viewport');
  await page.getByRole('button', { name: '项目报告.pdf' }).click();
  assert.equal(await page.getByTestId('opened').innerText(), '已请求打开文件');
  await capture('video-and-file');
}
