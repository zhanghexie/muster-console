export default async function ({ page, capture, assert }) {
  const row = page.locator('[data-mid="answer"]');
  await row.getByText('编排事件：任务状态已更新。').waitFor();
  for (const selector of ['[data-mid="host"] .chat-msg', '[data-mid="scheduler"] .chat-msg', '[data-mid="agent"] .chat-msg', '[data-mail-read]']) {
    const positions = await page.locator(selector).first().evaluate(node => ({
      avatar: node.querySelector('.chat-msg-avatar').getBoundingClientRect().left,
      text: node.querySelector('.chat-text').getBoundingClientRect().left,
      direction: getComputedStyle(node).flexDirection
    }));
    assert.equal(positions.direction, 'row', `${selector} left aligned`);
    assert.ok(positions.avatar < positions.text, `${selector} avatar on the left`);
  }
  assert.equal(await page.locator('[data-mid="user"] .chat-msg').evaluate(node => getComputedStyle(node).flexDirection), 'row-reverse');
  assert.equal(await row.locator('.tool-card').count(), 0);
  assert.equal(await row.locator('[data-mail-read]').count(), 1);
  await capture('folded');
  await row.locator('.turn-fold').click();
  await page.waitForTimeout(350);
  assert.equal(await row.locator('.tool-card').count(), 2);
  assert.equal(await row.locator('[data-mail-read]').count(), 1);
  await capture('expanded');
}
