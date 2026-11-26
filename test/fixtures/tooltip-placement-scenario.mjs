export default async function ({ page, capture, assert, width }) {
  await page.addStyleTag({ content: 'button { padding:4px 8px; border:0; border-radius:var(--radius-control); background:var(--surface-raised); color:var(--fg-primary); font:inherit; }' });
  async function show(selector) {
    await page.mouse.move(width / 2, 230);
    await page.locator(selector).hover();
    await page.waitForFunction(() => {
      const el = document.querySelector('.app-tooltip');
      return el && el.style.visibility !== 'hidden' && el.dataset.mpStage === 'in';
    });
    await page.waitForFunction(() => {
      const el = document.querySelector('.app-tooltip');
      return el && Number(getComputedStyle(el).opacity) === 1;
    });
    return { anchor: await page.locator(selector).boundingBox(), tip: await page.locator('.app-tooltip').boundingBox() };
  }
  const toolbar = await show('#history');
  assert(toolbar.tip.y + toolbar.tip.height <= toolbar.anchor.y - 5, '工具栏提示放到上方');
  const neighbor = await page.locator('#neighbor').boundingBox();
  assert(toolbar.tip.y + toolbar.tip.height <= neighbor.y, '不盖相邻按钮');
  await capture('toolbar-above');
  const top = await show('#top');
  assert(top.tip.y >= top.anchor.y + top.anchor.height + 5, '顶边翻到下方');
  const bottom = await show('#bottom');
  assert(bottom.tip.y + bottom.tip.height <= bottom.anchor.y - 5, '底边保持上方');
  const edge = await show('#edge');
  assert(edge.tip.x >= 7 && edge.tip.x + edge.tip.width <= width - 7, '长提示完整留在视口内');
  assert(edge.tip.y + edge.tip.height <= edge.anchor.y - 5, '窄窗换行后按实测高度定位');
  await capture('long-edge');
}
