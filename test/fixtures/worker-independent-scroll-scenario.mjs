import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

export default async function({ page, capture, assert, width }) {
  for (const name of readdirSync(new URL('../../src/renderer/src/assets/harness-brands/', import.meta.url)).filter(name => /\.(svg|png)$/.test(name))) {
    await page.route(`**/assets/harness-brands/${name}`, route => route.fulfill({ path: fileURLToPath(new URL(`../../src/renderer/src/assets/harness-brands/${name}`, import.meta.url)) }));
  }
  await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: 'Harness 接入', exact: true }).click();
  const pane = page.locator('.settings-tabpane.is-shown');
  const list = pane.locator('.worker-list-scroll');
  const detail = pane.locator('.worker-detail');
  const footer = pane.locator('.worker-list-footer');
  await pane.getByRole('button', { name: '全部支持', exact: true }).click();
  await pane.getByRole('button', { name: '配置 Muster Core', exact: true }).waitFor();
  async function settled() {
    await pane.evaluate(async el => {
      for (let node = el; node; node = node.parentElement) await Promise.allSettled(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished));
      await new Promise(requestAnimationFrame);
    });
  }
  const top = locator => locator.evaluate(el => el.scrollTop);
  async function wheel(locator, amount) {
    const box = await locator.boundingBox();
    assert.ok(box && box.height > 40, 'The scroll viewport is usable');
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(80, box.height / 2));
    await page.mouse.wheel(0, amount);
  }
  await settled();
  const layout = await pane.evaluate(el => {
    const grid = el.querySelector('.worker-pane'), list = el.querySelector('.worker-list-scroll');
    return { outer: getComputedStyle(el).overflowY, bounded: grid.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1, listOverflow: list.scrollHeight - list.clientHeight };
  });
  assert.equal(layout.outer, 'hidden', 'The Agent page delegates scrolling to its columns');
  assert.ok(layout.bounded, 'The Agent columns stay within the settings viewport');
  assert.ok(layout.listOverflow > 100, 'The complete Agent inventory overflows its own viewport');
  const outerTop = await top(pane), rightBefore = await top(detail);
  const footerBefore = await footer.boundingBox();
  await wheel(list, 360);
  await page.waitForFunction(() => document.querySelector('.settings-tabpane.is-shown .worker-list-scroll').scrollTop > 100);
  assert.equal(await top(detail), rightBefore, 'Scrolling the Agent list never moves the detail');
  assert.equal(await top(pane), outerTop, 'Scrolling the list never moves the whole page');
  assert.ok(Math.abs((await footer.boundingBox()).y - footerBefore.y) < 1, 'Footer actions remain visible below the scrolling inventory');
  await capture('agent-list-scrolled');
  await wheel(list, 10000);
  await page.waitForFunction(() => { const el = document.querySelector('.settings-tabpane.is-shown .worker-list-scroll'); return el.scrollTop >= el.scrollHeight - el.clientHeight - 1; });
  await wheel(list, 360);
  await list.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  assert.equal(await top(pane), outerTop, 'Reaching the list boundary does not scroll the parent');
  assert.equal(await top(detail), rightBefore, 'Reaching the list boundary never moves the detail');
  await pane.getByRole('button', { name: '配置 Muster Core', exact: true }).click();
  await settled();
  const leftBefore = await top(list);
  assert.ok(await detail.evaluate(el => el.scrollHeight > el.clientHeight + 100), 'The Agent detail has its own scroll viewport');
  await wheel(detail, 360);
  await page.waitForFunction(() => document.querySelector('.settings-tabpane.is-shown .worker-detail').scrollTop > 100);
  assert.equal(await top(list), leftBefore, 'Scrolling details never moves the Agent list');
  assert.equal(await top(pane), outerTop, 'Scrolling details never moves the whole page');
  assert.equal(await pane.locator('.worker-back').evaluate(el => getComputedStyle(el).display), width > 820 ? 'none' : 'flex');
  await capture('agent-detail-scrolled');
  await wheel(detail, 10000);
  await page.waitForFunction(() => { const el = document.querySelector('.settings-tabpane.is-shown .worker-detail'); return el.scrollTop >= el.scrollHeight - el.clientHeight - 1; });
  await wheel(detail, 360);
  await detail.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  assert.equal(await top(pane), outerTop, 'Reaching the detail boundary does not scroll the parent');
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.unmocked), [], 'All IPC stays in the fixture');
}
