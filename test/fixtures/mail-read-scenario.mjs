export default async function ({ page, capture, assert }) {
  await page.locator('[data-mail-read]').first().waitFor();
  assert.equal(await page.locator('[data-mail-read]').count(), 2);
  assert.equal(await page.locator('[data-mail-read] img').count(), 2);
  const bubble = await page.locator('[data-mail-read] .chat-text').first().evaluate(el => {
    const css = getComputedStyle(el);
    return { padding: parseFloat(css.paddingLeft), radius: parseFloat(css.borderTopLeftRadius), background: css.backgroundColor };
  });
  assert.ok(bubble.padding > 0, 'quiet parent must not remove incoming mail padding');
  assert.ok(bubble.radius > 0, 'quiet parent must not flatten incoming mail corners');
  assert.notEqual(bubble.background, 'rgba(0, 0, 0, 0)');
  const corners = await page.locator('.read-mail-letter').first().evaluate(el => {
    const css = getComputedStyle(el);
    return [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius];
  });
  assert.equal(corners[0], corners[1]);
  assert.equal(corners[0], corners[3]);
  assert.ok(parseFloat(corners[0]) > 4, 'incoming mail uses the shared large chat corners');
  assert.equal(corners[2], corners[0]);
  const userCorners = await page.locator('.chat-msg.user .chat-text').first().evaluate(el => {
    const css = getComputedStyle(el);
    return [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius];
  });
  assert.deepEqual(userCorners, corners, 'user and mail bubbles share all four large corners');
  assert.equal(await page.locator('.read-mail-letter .read-mail-letter-heading').count(), 2);
  assert.match(await page.locator('[data-mail-read]').first().innerText(), /普通信件/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await capture('read-mail-collapsed');
  const toggle = page.locator('button.turn-fold').first();
  await toggle.click();
  await page.locator('[data-mail-read]').first().waitFor();
  await page.locator('.turn-fold-body .tool-call-block').first().waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('.turn-fold-body');
    return element && element.getAnimations().every(animation => animation.playState === 'finished');
  });
  assert.equal(await page.locator('[data-mail-read]').count(), 2, 'expanding must not duplicate letters');
  await capture('read-mail-expanded');
  await toggle.click();
  assert.equal(await page.locator('[data-mail-read]').count(), 2, 'letters remain visible while closing');
  await toggle.click();
  assert.equal(await page.locator('[data-mail-read]').count(), 2, 'reversing mid-transition must not duplicate letters');
  await capture('read-mail-reversed', { animations: 'allow' });
  await toggle.click();
  assert.equal(await page.locator('[data-mail-read]').count(), 2, 'letters remain visible after refolding');
}
