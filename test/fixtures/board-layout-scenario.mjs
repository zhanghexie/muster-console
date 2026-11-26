export default async function ({ page, width, capture, assert }) {
  const grid = page.locator('.board-grid');
  await grid.locator('.board-card').first().waitFor();
  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector('.board-toolbar').getBoundingClientRect(), tab = document.querySelector('.board-view-switch').getBoundingClientRect();
    const effectiveFill = el => { for (let node = el; node; node = node.parentElement) { const color = getComputedStyle(node).backgroundColor; if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color; } return ''; };
    return { center: tab.x + tab.width / 2 - toolbar.x - toolbar.width / 2,
      columns: [...document.querySelectorAll('.board-grid .board-column')].map(c => { const list = c.querySelector('.board-column-body'), card = c.querySelector('.board-card'); return { width: card.getBoundingClientRect().width, gutter: list.offsetWidth - list.clientWidth, fill: effectiveFill(list), cardFill: effectiveFill(card) }; }),
      panelFill: getComputedStyle(document.querySelector('.g-board-sheet')).backgroundColor,
      heads: [...document.querySelectorAll('.board-grid .board-card')].every(c => c.querySelector('.board-card-head .board-card-time') && c.querySelector('.board-card-head .session-row-content .session-state-slot')) };
  });
  assert.ok(Math.abs(geometry.center) < 1, '标题同行切换器几何居中');
  assert.ok(geometry.heads, '所有卡片头像和时间位于首行');
  const toolbarLayout = await page.evaluate(() => {
    const head = document.querySelector('.board-toolbar'), title = head.querySelector('h1').getBoundingClientRect();
    return { subtitle: !!head.querySelector('div:first-child > span'),
      centers: [...head.querySelectorAll('.board-management > button')].map(b => { const r = b.getBoundingClientRect(); return r.y + r.height / 2; }), titleCenter: title.y + title.height / 2 };
  });
  assert.equal(toolbarLayout.subtitle, false, '标题下不再重复显示工作区范围');
  if (width >= 1000) assert.ok(toolbarLayout.centers.every(y => Math.abs(y - toolbarLayout.titleCenter) < 2), '宽屏下标题与全部操作同行');
  assert.ok(geometry.columns.every(c => c.gutter === 0), '原生滚动条不占内容宽度');
  assert.ok(Math.max(...geometry.columns.map(c => c.width)) - Math.min(...geometry.columns.map(c => c.width)) < 1, '长短列卡片同宽');
  assert.ok(geometry.columns.every(c => c.fill !== geometry.panelFill), '深浅主题列容器与面板可区分');
  const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  assert.ok(geometry.columns.every(c => { const a = luminance(c.fill), b = luminance(c.cardFill); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 1.2; }), '实际绘制的卡片与列底保留可见明暗差');
  await capture('board');
  const column = grid.locator('[data-zone="working"]');
  const list = column.locator('.board-column-body');
  assert.equal(await column.getByRole('scrollbar').count(), 0, '不渲染浮动滑块');
  assert.equal(await list.getAttribute('tabindex'), '0', '列内容可聚焦');
  const before = await column.locator('.board-card').first().boundingBox();
  await list.focus(); await list.press('End');
  await page.waitForFunction(() => { const el = document.querySelector('[data-zone="working"] .board-column-body'); return el.scrollTop >= el.scrollHeight - el.clientHeight - 1; });
  await list.press('Home');
  await page.waitForFunction(() => document.querySelector('[data-zone="working"] .board-column-body').scrollTop === 0);
  const point = await list.boundingBox(); await page.mouse.move(point.x + 60, point.y + 80); await page.mouse.wheel(0, 280);
  await page.waitForFunction(() => document.querySelector('[data-zone="working"] .board-column-body').scrollTop > 0);
  const after = await column.locator('.board-card').first().boundingBox();
  assert.ok(Math.abs(after.width - before.width) < 0.1, '滚动不改变卡片宽度');
  await list.focus(); await list.press('Home'); await page.mouse.move(0, 0);
  const archive = page.getByRole('button', { name: /归档 ·/ });
  await archive.click(); await grid.locator('[data-zone="archived"]').waitFor();
  assert.equal(await grid.locator('.board-column').count(), 4);
  await page.getByRole('button', { name: '收起归档', exact: true }).click();
  await page.getByRole('tab', { name: '自由', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.board-view-tab[aria-selected="true"]').textContent === '自由');
  await page.getByRole('tab', { name: '状态', exact: true }).click();
  if (width >= 1000) { await page.mouse.move(0, 0); await capture('restored'); }
}
