export default async function ({ page, capture, assert }) {
  const field = page.getByLabel('思考文本');
  const update = page.getByRole('button', { name: '更新思考' });
  const view = page.locator('.thinking-live-text');
  const content = page.locator('.thinking-live-content');
  const apply = async text => { await field.fill(text); await update.click(); };
  const settle = () => page.locator('.thinking-live-exit').waitFor({ state: 'detached' });
  const rects = () => content.evaluate(el => {
    const node = el.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const first = range.getBoundingClientRect();
    range.setStart(node, node.textContent.length - 1);
    range.setEnd(node, node.textContent.length);
    const last = range.getBoundingClientRect();
    const viewport = el.parentElement.getBoundingClientRect();
    const following = document.querySelector('[data-testid="following-content"]').getBoundingClientRect();
    return { first: { x: first.x, y: first.y }, last: { y: last.y, bottom: last.bottom },
      viewport: { x: viewport.x, y: viewport.y, height: viewport.height }, followingY: following.y };
  });

  await apply('先确认需求，');
  await content.waitFor();
  const first = await rects();
  assert.equal(first.viewport.height, 24);
  assert.ok(Math.abs(first.first.x - first.viewport.x) < 1);
  await apply('先确认需求，再整理步骤。');
  const appended = await rects();
  assert.ok(Math.abs(appended.first.x - first.first.x) < 1);
  assert.ok(Math.abs(appended.first.y - first.first.y) < 1);
  assert.equal(appended.followingY, first.followingY);
  await capture('typing', { animations: 'allow' });

  const longText = '先确认需求，再整理步骤。' + '根据当前上下文逐项分析，确保关键条件清晰。'.repeat(24) + '最新内容';
  await page.evaluate(() => {
    window.thinkingExitFrames = [];
    const observer = new MutationObserver(() => {
      const exiting = document.querySelector('.thinking-live-exit');
      if (!exiting || window.thinkingExitObserved) return;
      window.thinkingExitObserved = true;
      const sample = () => {
        if (!exiting.isConnected) return;
        const css = getComputedStyle(exiting);
        window.thinkingExitFrames.push({ x: new DOMMatrixReadOnly(css.transform).m41, opacity: Number(css.opacity) });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    observer.observe(document.querySelector('.thinking-live-text'), { childList: true });
  });
  await apply(longText);
  await settle();
  const exitFrames = await page.evaluate(() => window.thinkingExitFrames);
  assert.ok(exitFrames.some(frame => frame.x < -1 && frame.opacity < 0.95), '上一行向左移动并淡出');
  assert.equal(await content.textContent(), longText);
  const wrapped = await rects();
  assert.equal(wrapped.viewport.height, 24);
  assert.equal(wrapped.followingY, first.followingY);
  assert.ok(wrapped.first.y < wrapped.viewport.y);
  assert.ok(wrapped.last.y >= wrapped.viewport.y && wrapped.last.bottom <= wrapped.viewport.y + 24);
  assert.equal(await view.evaluate(el => getComputedStyle(el).overflow), 'hidden');
  await capture('wrapped', { animations: 'allow' });

  // A character appended within an already-wrapped line must not move the
  // characters that were visible before it (the old RTL ellipsis did so).
  const anchor = () => content.evaluate((el, index) => {
    const range = document.createRange();
    range.setStart(el.firstChild, index);
    range.setEnd(el.firstChild, index + 1);
    const box = range.getBoundingClientRect();
    return { x: box.x, y: box.y };
  }, longText.length - 1);
  const beforeAppend = await anchor();
  await apply(longText + '好');
  await settle();
  const afterAppend = await anchor();
  assert.ok(Math.abs(afterAppend.x - beforeAppend.x) < 1);
  assert.ok(Math.abs(afterAppend.y - beforeAppend.y) < 1);

  await page.getByRole('button', { name: '切换宽度' }).click();
  await page.waitForFunction(() => {
    const viewport = document.querySelector('.thinking-live-text');
    const text = document.querySelector('.thinking-live-content');
    if (!viewport || !text) return false;
    const expected = Math.max(0, text.offsetHeight - viewport.clientHeight);
    const actual = new DOMMatrixReadOnly(getComputedStyle(text).transform).m42;
    return Math.abs(actual + expected) < 1;
  });
  const resized = await rects();
  assert.equal(resized.followingY, first.followingY);
  assert.ok(resized.last.y >= resized.viewport.y && resized.last.bottom <= resized.viewport.y + 24);
  await capture('resized');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await apply(longText + '好' + '新增思考内容'.repeat(20));
  assert.equal(await page.locator('.thinking-live-exit').count(), 0, '减少动态时不创建退场动画');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { document.documentElement.dataset.uiMotion = 'reduced'; });
  assert.equal(await page.locator('.thinking-live-exit').count(), 0);
  await page.evaluate(() => { delete document.documentElement.dataset.uiMotion; });

  await page.getByRole('button', { name: '结束思考' }).click();
  assert.equal(await page.locator('.thinking-live').count(), 0);
  assert.equal(await page.getByText('回复已开始。').count(), 1);

  await page.getByRole('button', { name: '切换宽度' }).click();
  const advance = page.getByRole('button', { name: '推进工具链' });
  const summary = page.locator('.tool-call-group-details > summary');
  const following = page.getByTestId('following-content');
  const nextY = async () => (await following.boundingBox()).y;
  await advance.click();
  const toolY = await nextY();
  await capture('tool-chain-idle');
  await advance.click();
  assert.equal(await view.count(), 1);
  assert.equal((await summary.boundingBox()).height, 24);
  assert.equal(await nextY(), toolY, '思考复用原摘要行，下方内容不移动');
  await capture('tool-chain-thinking');
  await advance.click();
  assert.equal(await view.count(), 0);
  assert.equal(await nextY(), toolY, '恢复工具摘要时下方内容不移动');
  assert.equal(await summary.locator('.tool-lite-detail').textContent(), 'npm test');
  await summary.press('Space');
  const entries = await page.locator('.tool-call-group-list > *').allTextContents();
  assert.equal(entries.length, 3);
  assert.ok(entries[0].includes('git status'));
  assert.equal(entries[1], '进行了一段思考');
  assert.ok(entries[2].includes('npm test'));
  await capture('tool-chain-open');
}
