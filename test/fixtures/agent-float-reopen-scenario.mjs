export default async function ({ page, capture, assert }) {
  const toggle = page.locator('[data-open-gui]');
  await toggle.click();
  await page.waitForSelector('.chat-list [data-mid="m11"]');
  await page.waitForTimeout(400);
  await toggle.click();
  await page.locator('[data-grow-composer]').click();
  await page.evaluate(() => {
    window.reopenFrames = [];
    const sample = () => {
      const list = document.querySelector('.chat-list');
      const row = list?.querySelector('[data-mid="m11"]');
      if (list?.clientHeight && row) window.reopenFrames.push({
        rowTop: row.getBoundingClientRect().top - list.getBoundingClientRect().top,
        rowBottom: row.getBoundingClientRect().bottom - list.getBoundingClientRect().top,
        viewportHeight: list.clientHeight,
        gap: list.scrollHeight - list.clientHeight - list.scrollTop,
        height: document.querySelector('.agent-chat-composer-wrap').getBoundingClientRect().height
      });
      window.reopenSample = requestAnimationFrame(sample);
    };
    window.reopenSample = requestAnimationFrame(sample);
  });
  await toggle.click();
  await page.waitForTimeout(500);
  const frames = await page.evaluate(() => { cancelAnimationFrame(window.reopenSample); return window.reopenFrames; });
  assert.ok(frames.length > 5);
  assert.ok(frames.every(frame => frame.rowBottom > 0 && frame.rowTop < frame.viewportHeight && Math.abs(frame.gap) < 1), '必须观察贴底视口中的可见消息');
  assert.ok(frames.every(frame => Math.abs(frame.height - frames.at(-1).height) < 0.01), '重开时输入区高度不得渐变');
  const rows = frames.map(frame => frame.rowTop);
  assert.ok(Math.max(...rows) - Math.min(...rows) < 0.01, '重开时可见消息位置不得漂移');
  await capture('reopen-resized');
}
