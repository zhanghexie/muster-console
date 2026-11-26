export default async function ({ page, capture, assert }) {
  await page.locator('.left-panel').evaluate(el => { el.parentElement.style.width = 'min(480px, 100%)'; });
  await page.getByText('当前会话乙', { exact: true }).waitFor();
  const libraryRow = page.getByRole('treeitem', { name: '示例工具' });
  await libraryRow.waitFor();
  const shortcuts = page.getByRole('group', { name: '常用工具' });
  const tool = name => shortcuts.locator('button').filter({ hasText: name });
  const favorite = shortcuts.getByRole('button', { name: '示例工具', exact: true });
  const foldTools = page.getByRole('button', { name: '折叠实用工具', exact: true });
  const unfoldTools = page.getByRole('button', { name: '展开实用工具', exact: true });
  const measureTiles = () => shortcuts.evaluate(group => {
    const { x, y } = group.getBoundingClientRect();
    return [...group.querySelectorAll('.utility-feature-item')].map((tile, index) => {
      const rect = tile.getBoundingClientRect();
      const item = tile.closest('.rail-stack-item') ?? tile;
      return {
        index, x: rect.x - x, y: rect.y - y, width: rect.width, height: rect.height,
        available: !tile.closest('[inert]'), opacity: Number(getComputedStyle(item).opacity)
      };
    });
  });
  const positions = tiles => tiles.map(({ index, x, y, width, height }) => ({ index, x, y, width, height }));
  await page.evaluate(async () => {
    await Promise.all([400, 500].map(weight => document.fonts.load(`${weight} 12px "OPPO Sans"`, '定时任务使用统计记忆整理扩展管理示例工具当前会话乙终端甲')));
    await document.fonts.ready;
  });
  await page.waitForTimeout(350);
  await tool('定时任务').click();
  await page.mouse.move(0, 0);
  const stacks = page.locator('.left-section-scroll > .rail-stack');
  assert.equal(await stacks.count(), 2);
  await capture('expanded', { animations: 'allow' });
  const expandedTiles = await measureTiles();
  const firstRow = expandedTiles.filter(tile => tile.y === expandedTiles[0].y);
  const firstRowPositions = positions(firstRow);
  const before = await stacks.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
  await foldTools.click();
  for (const label of ['工作会话', '终端']) await page.getByRole('button', { name: `折叠${label}`, exact: true }).click();
  await page.waitForTimeout(70);
  const mid = await stacks.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
  assert.ok(mid.some((height, i) => height > 45 && height < before[i] - 1), '真实轨道正在连续收拢');
  await capture('folding', { animations: 'allow' });
  await page.waitForTimeout(320);
  for (const stack of await stacks.all()) {
    const visible = await stack.locator('.rail-stack-item').evaluateAll(items => items.filter(item => Number(getComputedStyle(item).opacity) > 0.9));
    assert.equal(visible.length, 1);
    const preview = stack.locator('.is-preview');
    const bounds = await preview.boundingBox(), viewport = await stack.boundingBox();
    // 中间项前移时，行尾间距折到预览轨道的上缘。
    const rowSpacing = await stack.evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue('--sidebar-row-spacing')));
    assert.ok(bounds.y >= viewport.y - rowSpacing && bounds.y + bounds.height <= viewport.y + viewport.height + 1,
      `保留项位于折叠轨道内 ${JSON.stringify({ bounds, viewport })}`);
    assert.ok(bounds.x >= viewport.x - 1 && bounds.x + bounds.width <= viewport.x + viewport.width + 1, '窄栏保留项没有横向裁切');
  }
  assert.ok((await stacks.first().locator('.is-preview').textContent()).includes('当前会话乙'), '会话保留当前项');
  const collapsedTiles = await measureTiles();
  assert.deepEqual(positions(collapsedTiles.filter(tile => tile.available)), firstRowPositions,
    '实用工具收起后保留展开首行的入口、位置与尺寸');
  assert.ok(collapsedTiles.every(tile => tile.opacity === Number(tile.available)), '后续行完全淡出');
  const gridWidth = (await shortcuts.boundingBox()).width;
  assert.ok(firstRow.every(tile => tile.x >= 0 && tile.x + tile.width <= gridWidth), '首行入口没有横向裁切');
  assert.equal(await libraryRow.count(), 0, '收起时扩展树退出交互');
  await capture('collapsed', { animations: 'allow' });
  await tool('使用统计').click();
  assert.equal(await tool('使用统计').getAttribute('aria-pressed'), 'true', '可直接在收起态切换工具');
  if (firstRow.length < 5) {
    const lastTool = ['定时任务', '使用统计', '记忆整理', '扩展管理'][firstRow.length - 1];
    await tool(lastTool).focus();
    await page.keyboard.press('Tab');
    assert.equal(await shortcuts.evaluate(el => el.contains(document.activeElement)), false, 'Tab 跳过收起的后续行');
  }
  if (firstRow.length > 4) {
    const viewport = page.viewportSize();
    const waitForFirstRow = count => page.waitForFunction(expected =>
      document.querySelectorAll('.rail-stack-first-row .rail-stack-item.is-preview').length === expected, count);
    await page.setViewportSize({ ...viewport, width: 228 });
    await waitForFirstRow(3);
    await page.setViewportSize(viewport);
    await waitForFirstRow(firstRow.length);
    assert.deepEqual(positions((await measureTiles()).filter(tile => tile.available)), firstRowPositions);
  }
  const expandLibrary = shortcuts.getByRole('button', { name: '展开更多工具', exact: true });
  if (await favorite.count()) {
    await favorite.press('Enter');
    assert.equal(await favorite.getAttribute('aria-pressed'), 'true');
    await favorite.press('Shift+F10');
    await page.getByRole('menuitem', { name: '在列表中显示' }).click();
    await foldTools.waitFor();
  } else if (await expandLibrary.count()) {
    await expandLibrary.click();
  } else {
    await unfoldTools.click();
  }
  await libraryRow.waitFor();
  // 退场中重开：立即反向，不等待退场计时器。
  await page.getByRole('button', { name: '展开工作会话', exact: true }).click();
  await page.waitForTimeout(40);
  await page.getByRole('button', { name: '折叠工作会话', exact: true }).click();
  await page.waitForTimeout(40);
  await page.getByRole('button', { name: '展开工作会话', exact: true }).click();
  await page.getByRole('button', { name: '展开终端', exact: true }).click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.rail-stack.is-collapsed').count(), 0);
  assert.equal(await page.locator('.rail-stack-item[inert]').count(), 0);
  assert.deepEqual(positions(await measureTiles()), positions(expandedTiles), '展开恢复原布局');
  await capture('restored', { animations: 'allow' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '折叠工作会话', exact: true }).click();
  await page.waitForTimeout(30);
  const duration = await stacks.first().evaluate(el => Number.parseFloat(getComputedStyle(el).transitionDuration));
  assert.ok(duration < 0.001, '减弱动态时近乎瞬时完成');
}
