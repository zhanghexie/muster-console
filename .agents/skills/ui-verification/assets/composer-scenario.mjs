/** Actual keyboard actions against the production editor, before and after send. */
export default async function ({ page, capture, assert }) {
  const editor = page.getByRole('textbox');
  await editor.waitFor();
  await capture('empty');
  await editor.click();
  await editor.pressSequentially('# 输入区标题');
  await editor.press('Shift+Enter');
  await editor.press('Shift+Enter');
  await editor.pressSequentially('1. 第一项');
  await editor.press('Shift+Enter');
  assert.equal(await editor.locator('[data-md="ordered"]').last().getAttribute('data-marker'), '2.');
  await editor.pressSequentially('第二项');
  await capture('editing');
  await editor.press('Shift+Enter');
  await editor.press('Shift+Enter'); // empty item exits the ordered list
  assert.equal(await editor.locator('[data-md="ordered"]').count(), 2);
  await editor.press('Shift+Enter');
  await editor.pressSequentially('- 无序项');
  await capture('lists');
  await editor.press('Enter');
  await page.waitForFunction(() => window.__uiFixture.sent.length === 1);
  assert.equal(await page.evaluate(() => window.__uiFixture.sent[0]), '# 输入区标题\n\n1. 第一项\n2. 第二项\n\n- 无序项');
  assert.equal(await page.locator('.chat-msg.user h1').textContent(), '输入区标题');
  assert.equal(await page.locator('.chat-msg.user ol li').count(), 2);
  assert.equal(await page.locator('.chat-msg.user ul li').count(), 1);
  await capture('sent');
}
