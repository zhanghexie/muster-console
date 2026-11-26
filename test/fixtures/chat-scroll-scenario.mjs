/** Run with ui-verification/capture-component.mjs and the production CSS. */
export default async function ({ page, capture, assert }) {
  const list = page.locator('.chat-list');
  const jump = page.getByRole('button', { name: '滚动到底部' });
  const geometry = () => list.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
  const settle = () => page.waitForTimeout(350);
  await list.waitFor(); await settle();
  assert.ok((await geometry()).gap <= 1, '首开贴底');
  await list.hover(); await page.mouse.wheel(0, -20); await settle();
  const reading = await geometry();
  assert.ok(reading.gap > 0 && reading.gap < 60, '外层小步上翻进入底部容差带');
  await page.evaluate(() => window.appendScrollFixture()); await settle();
  const grown = await geometry();
  assert.ok(grown.gap > 1000, '用户主动上翻后保持阅读位置');
  assert.ok(Math.abs(grown.top - reading.top) <= 1, '不强行拉底');
  assert.equal(await jump.count(), 1, '内容长高无 scroll 事件也出现回底按钮');
  await capture('reading-button');
  await jump.click(); await settle();
  assert.ok((await geometry()).gap <= 1, '回底按钮恢复贴底');
  await capture('button-recovery');

  await page.evaluate(() => window.nestedScrollFixture()); await settle();
  const thinking = page.locator('.thinking-body').last();
  assert.ok((await geometry()).gap <= 1);
  const outer = await geometry();
  const innerTop = await thinking.evaluate(el => el.scrollTop);
  assert.ok(innerTop > 60, '思考区存在真实内部滚动范围');
  await thinking.hover(); await page.mouse.wheel(0, -60); await settle();
  assert.ok(await thinking.evaluate(el => el.scrollTop) < innerTop, '真实滚轮移动内部思考区');
  assert.equal((await geometry()).top, outer.top, '内部滚动不移动外层');
  await page.evaluate(() => window.appendScrollFixture()); await settle();
  assert.ok((await geometry()).gap <= 1, '内部上翻不误关外层跟随');
  assert.equal(await jump.count(), 0);
  await capture('nested-follow');

  await page.evaluate(() => window.nestedScrollFixture()); await settle();
  await thinking.evaluate(el => { el.scrollTop = 0; }); await settle();
  const beforeChain = await geometry();
  await thinking.hover(); await page.mouse.wheel(0, -160); await settle();
  assert.ok((await geometry()).top < beforeChain.top - 60, '内部到顶后滚动链仍可上翻会话');
  await page.evaluate(() => window.appendScrollFixture()); await settle();
  assert.ok((await geometry()).gap > 1000, '外层主动上翻解除跟随');
  assert.equal(await jump.count(), 1);
  await capture('nested-chain');
}
