import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

export default async function ({ page, capture, assert, width }) {
  for (const name of readdirSync(new URL('../../src/renderer/src/assets/harness-brands/', import.meta.url)).filter(name => /\.(svg|png)$/.test(name))) {
    await page.route(`**/assets/harness-brands/${name}`, route => route.fulfill({ path: fileURLToPath(new URL(`../../src/renderer/src/assets/harness-brands/${name}`, import.meta.url)) }));
  }
  if (width < 500) await page.locator('.left-panel').evaluate(el => { el.parentElement.style.width = '200px'; });
  await page.evaluate(() => window.__setHarnesses());
  const row = page.locator('[data-session-row="b"]');
  const icon = row.locator('.session-harness-icon');
  await row.waitFor();
  await page.mouse.move(2, 2);
  assert.equal(await icon.isVisible(), false, 'The idle row does not display its harness mark');
  const idle = await row.evaluate(el => ({ row: el.getBoundingClientRect().right,
    time: el.querySelector('.session-row-tools').getBoundingClientRect().right,
    state: getComputedStyle(el.querySelector('.session-state')).visibility }));
  assert.ok(Math.abs(idle.row - idle.time - 10) < 1, 'The idle time slot retains the right edge');
  assert.equal(idle.state, 'visible', 'The original state mark is visible while idle');
  await capture('idle');
  await row.hover();
  await icon.waitFor({ state: 'visible' });
  assert.equal(await icon.getAttribute('aria-label'), 'Codex');
  const hover = await row.evaluate(el => {
    const slot = el.querySelector('.session-state-slot');
    const icon = el.querySelector('.session-harness-icon');
    const a = slot.getBoundingClientRect(), b = icon.getBoundingClientRect();
    return { inside: slot.contains(icon), slotCenter: a.x + a.width / 2, iconCenter: b.x + b.width / 2,
      state: getComputedStyle(el.querySelector('.session-state')).visibility,
      time: el.querySelector('.session-row-tools').getBoundingClientRect().right };
  });
  assert.equal(hover.inside, true, 'The harness replaces the left status mark');
  assert.ok(Math.abs(hover.slotCenter - hover.iconCenter) < 1, 'The two marks share a center');
  assert.equal(hover.state, 'hidden', 'The status mark is hidden while the harness is visible');
  assert.equal(hover.time, idle.time, 'Showing the icon does not move the time/archive slot');
  assert.equal(await row.locator('.session-archive-btn').isVisible(), true);
  await capture('hover');
  const details = page.getByRole('dialog', { name: '会话详情' });
  await details.waitFor();
  assert.equal(await details.locator('.session-details-runtime').innerText(), 'Codex');
  assert.equal(await details.locator('.session-details-harness-icon').count(), 1);
  await capture('details');
  await page.mouse.move(2, 2);
  await row.focus();
  assert.equal(await icon.isVisible(), true, 'Keyboard focus also reveals the mark');
  await row.evaluate(el => el.blur());
  assert.equal(await icon.isVisible(), false, 'The mark hides again after leaving focus');
  await row.hover();
  const twisty = row.locator('.session-tree-twisty');
  assert.equal(await twisty.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  await row.locator('.session-state-slot').hover();
  assert.equal(await twisty.evaluate(el => getComputedStyle(el).pointerEvents), 'auto');
  await twisty.click();
  assert.equal(await page.locator('[data-session-row="c"]').count(), 0, 'The tree control still collapses child sessions');
  await row.locator('.session-archive-btn').click();
  assert.deepEqual(await page.evaluate(() => window.__sidebarArchiveCalls), [['b', true, { activeId: 'b', nextId: 'a' }]]);
}
