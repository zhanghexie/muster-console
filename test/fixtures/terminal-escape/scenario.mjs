export default async function({ page, capture, assert }) {
  const a = page.locator('[data-terminal="a"] .xterm-screen');
  const b = page.locator('[data-terminal="b"] .xterm-screen');
  await page.waitForFunction(() => window.__uiFixture.calls.filter(c => c.path === 'pty.resize').length >= 2);
  await page.waitForTimeout(600);
  const box = await a.boundingBox();
  await page.mouse.dblclick(box.x + 30, box.y + 8);
  await page.waitForFunction(() => window.__terminalSelection()?.owner === 'a');
  await capture('selected-output');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => window.__uiFixture.calls.some(c => c.path === 'pty.input' && c.args[0] === 'a' && c.args[1] === '\x1b')));
  await page.waitForFunction(() => window.__terminalSelection() == null);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__uiFixture.calls.filter(c => c.path === 'pty.input' && c.args[0] === 'a' && c.args[1] === '\x1b').length), 2);
  await page.mouse.dblclick(box.x + 30, box.y + 8);
  await page.waitForFunction(() => window.__terminalSelection()?.owner === 'a');
  const other = await b.boundingBox();
  await page.mouse.click(other.x + 30, other.y + 8);
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => document.activeElement?.closest('[data-terminal="b"]') != null), 'background selection must not steal focus');
  await page.keyboard.press('x');
  assert(await page.evaluate(() => window.__uiFixture.calls.some(c => c.path === 'pty.input' && c.args[0] === 'b' && c.args[1] === 'x')));
  await capture('escape-delivered-focus-retained');
}
