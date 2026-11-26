export default async function ({ page, capture, assert }) {
  await page.locator('.waiting-tip-text').waitFor();
  assert.equal(await page.locator('.waiting-activity-dot').count(), 3);
  assert.equal(await page.locator('.thinking-orbit.is-active path').count(), 2);
  assert.equal(await page.locator('.terminal-activity.is-active path').count(), 2);
  assert.equal(await page.locator('.wrench-activity.tool-activity-icon').count(), 1);
  assert.equal(await page.locator('.write-activity.is-active .write-activity-pencil').count(), 1);
  assert.equal(await page.locator('.compaction-activity span').count(), 3);
  assert.equal(await page.locator('.tool-card .typing-dots').count(), 0);
  const terminal = page.locator('summary:has(.terminal-activity.is-active)');
  assert.equal(await terminal.locator('.tool-lite-detail').textContent(), 'npm test');
  const separatorGaps = await terminal.locator('.tool-lite-label').evaluate(label => {
    const separator = [...label.querySelectorAll('.tool-lite-sep')].at(-1);
    const text = separator.firstChild;
    const index = text.textContent.indexOf('·');
    const range = document.createRange();
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    const dot = range.getBoundingClientRect();
    return {
      before: dot.left - label.querySelector('.tool-lite-verb').getBoundingClientRect().right,
      after: label.querySelector('.tool-lite-detail').getBoundingClientRect().left - dot.right
    };
  });
  assert.ok(separatorGaps.before >= 2 && separatorGaps.after >= 2);
  const measurement = await page.locator('.waiting-tip').evaluate(el => ({
    height: el.getBoundingClientRect().height,
    overflow: document.documentElement.scrollWidth > innerWidth
  }));
  assert.equal(measurement.height, 24);
  assert.equal(measurement.overflow, false);

  const selector = '.waiting-activity-dot, .thinking-orbit.is-active .thinking-spark-main, .thinking-orbit.is-active .thinking-spark-small, .terminal-activity-command, .terminal-activity-cursor, .tool-activity-icon, .write-activity-pencil, .compaction-activity-top';
  const animationNames = () => page.locator(selector).evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName));
  const activeNames = await animationNames();
  assert.equal(activeNames.length, 10);
  assert.ok(activeNames.every(name => name !== 'none'));
  const frames = await page.locator('.terminal-activity-command, .terminal-activity-cursor, .tool-activity-icon, .write-activity-pencil')
    .evaluateAll(nodes => nodes.map(node => {
      const animation = node.getAnimations()[0];
      const duration = animation.effect.getComputedTiming().duration;
      animation.pause();
      animation.currentTime = 0;
      const start = getComputedStyle(node).transform;
      animation.currentTime = duration * .35;
      const middle = getComputedStyle(node).transform;
      animation.play();
      return { start, middle };
    }));
  assert.ok(frames.every(frame => frame.start !== frame.middle));
  const dotFrames = await page.locator('.waiting-activity-dot').first().evaluate(node => {
    const animation = node.getAnimations()[0];
    const duration = animation.effect.getComputedTiming().duration;
    animation.pause();
    animation.currentTime = 0;
    const start = getComputedStyle(node).opacity;
    animation.currentTime = duration * .35;
    const middle = getComputedStyle(node).opacity;
    animation.play();
    return { start, middle };
  });
  assert.notEqual(dotFrames.start, dotFrames.middle);
  await capture('running', { animations: 'allow' });

  await page.locator('main > div').evaluate(el => el.classList.add('xfade'));
  const hiddenStates = await page.locator(selector).evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationPlayState));
  assert.equal(hiddenStates.length, 10);
  assert.ok(hiddenStates.every(state => state === 'paused'));
  await page.locator('main > div').evaluate(el => el.classList.remove('xfade'));

  // Protect every scene from selector specificity overriding reduced motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok((await animationNames()).every(name => name === 'none'));
  await capture('reduced');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.__setActivityMotionPreference('reduced'));
  assert.ok((await animationNames()).every(name => name === 'none'));
  await page.evaluate(() => window.__setActivityMotionPreference('system'));

  await page.getByRole('button', { name: '切换完成状态' }).click();
  await page.getByText('上下文已压缩').waitFor();
  assert.equal(await page.locator('.waiting-tip, .thinking-orbit.is-active').count(), 0);
  assert.equal(await page.locator('.terminal-activity.is-active, .wrench-activity.tool-activity-icon, .write-activity.is-active').count(), 0);
  const groups = await page.locator('.tool-call-group-details').filter({ hasText: '调用了工具' }).all();
  assert.ok(groups.length >= 3, 'completed tools are grouped in the transcript');
  for (const group of groups) await group.locator(':scope > summary').click();
  const completed = await page.locator('.tool-card :is(.terminal-activity-glyph path, .wrench-activity, .write-activity-pencil)')
    .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName));
  assert.equal(completed.length, 4);
  assert.ok(completed.every(name => name === 'none'));
  await capture('complete');
}
