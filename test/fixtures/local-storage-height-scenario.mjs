export default async function ({ page, capture, assert }) {
  await page.getByRole('heading', { name: '存储项目' }).waitFor();
  await page.evaluate(() => window.__uiFixture.addStorageItems());
  await page.getByRole('button', { name: '开始扫描' }).click();
  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^会话/ }).click();
  await page.getByRole('checkbox', { name: '选择 额外项目 sessions 1', exact: true }).waitFor();

  const pane = page.locator('.settings-tabpane[data-settings-item="localStorage"]');
  const nav = page.locator('.local-storage-layout > .settings-resource-nav');
  const detail = page.locator('.local-storage-detail');
  const actions = page.locator('.local-storage-actions');
  const geometry = () => page.evaluate(() => {
    const pane = document.querySelector('.settings-tabpane[data-settings-item="localStorage"]');
    const body = document.querySelector('.local-storage-body');
    const bar = document.querySelector('.local-storage-bar');
    const layout = document.querySelector('.local-storage-layout');
    const actions = document.querySelector('.local-storage-actions');
    const p = pane.getBoundingClientRect(), b = body.getBoundingClientRect(), barRect = bar.getBoundingClientRect(), l = layout?.getBoundingClientRect(), a = actions?.getBoundingClientRect();
    return { paneTop: p.top, paneBottom: p.bottom, paneScroll: pane.scrollTop, paneClient: pane.clientHeight, paneHeight: pane.scrollHeight, layoutHeight: l?.height ?? 0, actionsTop: a?.top ?? null, actionsBottom: a?.bottom ?? null,
      barInsideBody: body.contains(bar), barBottom: barRect.bottom, barLeft: barRect.left, barRight: barRect.right, bodyTop: b.top, bodyLeft: b.left, bodyRight: b.right };
  });
  const initial = await geometry();
  assert.equal(initial.barInsideBody, false, 'Capacity bar stays outside the framed content');
  assert.ok(initial.barBottom + 8 <= initial.bodyTop, 'Capacity bar has visible separation from the framed content');
  assert.ok(Math.abs(initial.barLeft - initial.bodyLeft) <= 1 && Math.abs(initial.barRight - initial.bodyRight) <= 1, 'Capacity bar aligns with the content frame');
  assert.ok(initial.paneHeight <= initial.paneClient + 1, `Settings page must not overflow vertically: ${JSON.stringify(initial)}`);
  assert.ok(initial.layoutHeight > 100, 'Lists have usable height');
  assert.ok(initial.actionsTop >= initial.paneTop && initial.actionsBottom <= initial.paneBottom, 'Actions stay inside the visible pane');
  assert.ok(await nav.evaluate(el => el.scrollHeight > el.clientHeight), 'Category list can scroll when its content exceeds its viewport');
  assert.ok(await detail.evaluate(el => el.scrollHeight > el.clientHeight), 'Item detail can scroll when its content exceeds its viewport');
  await capture('fixed-page');

  await nav.evaluate(el => { el.scrollTop = 0; });
  await nav.hover();
  assert.equal(await nav.evaluate(el => getComputedStyle(el).scrollbarWidth), 'none', 'Category scrollbar stays hidden on hover');
  assert.equal(await nav.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar').display), 'none', 'Category scrollbar is hidden in WebKit');
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('.local-storage-layout > .settings-resource-nav').scrollTop > 0);
  assert.equal(await detail.evaluate(el => el.scrollTop), 0, 'Scrolling categories does not scroll detail');
  assert.equal((await geometry()).paneScroll, 0, 'Scrolling categories does not move the whole settings page');

  await detail.hover();
  assert.equal(await detail.evaluate(el => getComputedStyle(el).scrollbarWidth), 'none', 'Detail scrollbar stays hidden on hover');
  assert.equal(await detail.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar').display), 'none', 'Detail scrollbar is hidden in WebKit');
  const navBefore = await nav.evaluate(el => el.scrollTop);
  await page.mouse.wheel(0, 320);
  await page.waitForFunction(() => document.querySelector('.local-storage-detail').scrollTop > 0);
  assert.equal(await nav.evaluate(el => el.scrollTop), navBefore, 'Scrolling details does not scroll categories');
  const afterWheel = await geometry();
  assert.equal(afterWheel.paneScroll, 0, 'Scrolling details does not move the whole settings page');
  assert.ok(Math.abs(initial.actionsTop - afterWheel.actionsTop) <= 1, 'Actions remain fixed while scrolling');
  await capture('detail-scrolled');

  await detail.evaluate(el => { el.scrollTop = 0; });
  await detail.locator('.local-storage-row-button').first().focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.querySelector('.local-storage-detail').scrollTop > 0);
  assert.equal((await geometry()).paneScroll, 0, 'Keyboard scrolling details does not move the whole settings page');

  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^聊天附件/ }).click();
  assert.equal(await detail.evaluate(el => el.scrollTop), 0, 'Changing category resets the detail scroll position');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await detail.evaluate(el => el.scrollTop), 0, 'Layout after the switch must not restore the previous scroll position');
  await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^会话/ }).click();
  await page.getByRole('checkbox', { name: '选择 代码审查与改进' }).check();
  for (let i = 1; i <= 6; i++) await page.getByRole('checkbox', { name: `选择 额外项目 sessions ${i}`, exact: true }).check();
  await page.evaluate(() => window.__uiFixture.delayStorageCleanup());
  await page.getByRole('button', { name: '检查清理影响' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认清理' }).click();
  await page.getByText('正在处理 0 / 7 项…').waitFor();
  const duringProgress = await geometry();
  assert.ok(Math.abs(initial.actionsTop - duringProgress.actionsTop) <= 1, 'Actions stay at the bottom while cleanup is in progress');
  assert.ok(duringProgress.paneHeight <= duringProgress.paneClient + 1, 'Progress does not expand the entire page');
  await capture('cleanup-progress');
  const results = page.locator('.local-storage-results');
  await results.waitFor();
  assert.equal(await results.locator('p').count(), 0, 'Successful results remain a compact summary');
  const afterResults = await geometry();
  assert.ok(afterResults.paneHeight <= afterResults.paneClient + 1, 'Results do not expand the entire page');
  assert.ok(afterResults.actionsBottom <= afterResults.paneBottom, 'Actions remain visible after cleanup');
  assert.equal(await page.getByRole('navigation', { name: '存储类别' }).count(), 1, 'Remaining items stay available');
  assert.equal(await page.evaluate(() => window.__uiFixture.calls.filter(call => call.path === 'localStorage.scan').length), 1, 'Cleanup does not start another scan');
  await capture('cleanup-results');
}
