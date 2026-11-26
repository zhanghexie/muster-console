export default async function ({ page, capture, assert }) {
  const gui = new URL(page.url()).searchParams.get('surface') === 'gui';
  const toggle = page.locator(gui ? '[data-open-gui]' : '.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-notify-chat').first();
  await toggle.waitFor();
  // Record the actual production scroller each rendered frame, including entry.
  await page.evaluate(() => {
    window.openFrames = [];
    const sample = () => {
      const panel = document.querySelector('.agent-float-panel, .agent-chat-view');
      const list = panel?.querySelector('.chat-list');
      const row = list?.querySelector('[data-mid="m11"]');
      if (list && row && getComputedStyle(list).visibility === 'visible') window.openFrames.push({ stage: panel.dataset.mpStage, top: list.scrollTop,
        gap: list.scrollHeight - list.clientHeight - list.scrollTop, height: list.scrollHeight,
        overlay: list.closest('.chat-surface-view').style.getPropertyValue('--composer-overlay-h'), padding: getComputedStyle(list).paddingBottom,
        rowTop: (row.getBoundingClientRect().top - list.getBoundingClientRect().top) / (list.getBoundingClientRect().height / list.clientHeight) });
      window.openSample = requestAnimationFrame(sample);
    };
    window.openSample = requestAnimationFrame(sample);
  });
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.openFrames.splice(0));
    await toggle.click();
    await capture(`opening-${i}`, { animations: 'allow' });
    await page.waitForTimeout(new URL(page.url()).searchParams.has('review') ? 1300 : 650);
    await capture(`open-${i}`, { animations: 'allow' });
    if (new URL(page.url()).searchParams.get('suggestions') === '1') {
      assert.ok(await page.getByRole('group', { name: '建议回复' }).isVisible(), '样本必须实际显示建议回复');
    }
    if (new URL(page.url()).searchParams.has('review')) assert.ok(await page.locator('.turn-changes-card').isVisible());
    const frames = await page.evaluate(() => window.openFrames.splice(0));
    const offsets = frames.map(frame => frame.rowTop);
    const drift = Math.max(...offsets) - Math.min(...offsets);
    console.log('OPEN_DRIFT', i, drift.toFixed(2));
    assert.ok(frames.length > 5);
    assert.ok(frames.at(-1).gap <= 1, '面板打开后位于底部');
    assert.ok(drift <= 0.001, `开场可见回复不得随高度结算跳动（实际 ${drift.toFixed(2)}px）`);
    assert.ok(frames.every(frame => Math.abs(frame.gap) <= 0.001), '每一帧都已按真实输入条高度贴底');
    assert.equal(await page.locator('.chat-positioning-row').count(), 0, '初始布局准备已释放');
    if (i === 0) { await toggle.click(); await page.waitForTimeout(350); }
  }
  // A close interrupted by reopening keeps the existing transcript in place.
  if (!gui) {
    await toggle.click();
    await page.locator('.agent-float-panel.is-exiting').waitFor();
    await toggle.click();
    await page.waitForTimeout(350);
    assert.ok(await page.locator('.agent-float-panel.is-open').count());
    await capture('reversed');
  }
  await page.evaluate(() => cancelAnimationFrame(window.openSample));
}
