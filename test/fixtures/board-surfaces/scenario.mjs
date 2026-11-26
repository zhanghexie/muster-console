export default async function ({ page, width, capture, assert }) {
  await page.locator('[data-ready="true"]').waitFor();
  await page.locator('.board-card').first().waitFor();
  const assertTwoLines = async preview => {
    await preview.waitFor();
    const lineCount = await preview.evaluate(element => {
      const css = getComputedStyle(element);
      const lineHeight = parseFloat(css.lineHeight);
      const visible = element.offsetHeight / lineHeight;
      const clamp = css.webkitLineClamp;
      element.style.webkitLineClamp = 'none';
      const total = element.offsetHeight / lineHeight;
      element.style.removeProperty('-webkit-line-clamp');
      return { visible, total, clamp };
    });
    assert.ok(lineCount.total > 2, 'the fixture must overflow two lines at this width');
    assert.ok(lineCount.visible > 1.9 && lineCount.visible < 2.1, 'only two lines fit in the card');
    assert.equal(lineCount.clamp, '2');
  };
  const longReply = page.locator('.board-card-output').filter({ hasText: '这是一段足够长的看板卡片正文' });
  await assertTwoLines(longReply);
  const replyWidth = await longReply.evaluate(element => element.offsetWidth);
  assert.equal(replyWidth > 220, width >= 1920, 'the wide viewport must also widen the cards');
  await assertTwoLines(page.locator('.board-status-body .board-todo-preview'));
  assert.equal(await page.locator('.board-card-output').filter({ hasText: '玩得开心！ 🏁' }).textContent(), '玩得开心！ 🏁');
  const colors = [];
  for (const [label, custom, accent] of [['neutral', false, false], ['workspace', false, true], ['custom', true, false], ['restored', false, false]]) {
    await page.evaluate(({ custom, accent }) => window.__boardPalette(custom, accent), { custom, accent });
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().iterations)).map(a => a.finished.catch(() => {})));
    });
    const result = await page.evaluate(() => {
      const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
      const card = document.querySelector('.board-card');
      return {
        sheet: color('.g-board-sheet'), column: color('.board-column'), card: color('.board-card'),
        rim: getComputedStyle(document.querySelector('.board-column'), '::after').content,
        padding: getComputedStyle(card).padding,
        gap: getComputedStyle(document.querySelector('.board-grid')).columnGap,
        sessionCanvas: getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim(),
        border: getComputedStyle(document.querySelector('.g-board-sheet')).borderTopColor
      };
    });
    assert.equal(result.sheet, result.column, 'columns blend into one board work surface');
    const sessionSurface = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--surface-canvas)'; probe.style.border = '1px solid var(--surface-edge)';
      document.body.append(probe);
      const css = getComputedStyle(probe);
      const result = { background: css.backgroundColor, border: css.borderTopColor };
      probe.remove(); return result;
    });
    assert.equal(result.sheet, sessionSurface.background, 'panel background matches the session area');
    assert.equal(result.border, sessionSurface.border, 'panel outline uses the session perimeter colour');
    assert.notEqual(result.card, result.sheet, 'cards remain distinct');
    assert.equal(result.rim, 'none', 'columns have no nested outline');
    assert.equal(result.padding, '10px 11px');
    assert.equal(result.gap, '20px');
    colors.push(result);
    if (label !== 'restored') await capture(label);
    if (label === 'neutral') {
      await page.getByRole('tab', { name: '自由', exact: true }).click();
      await page.locator('.board-free-body.is-shown .fc-viewport').waitFor();
      await assertTwoLines(page.locator('.board-free-body .board-todo-preview'));
      const canvas = await page.locator('.fc-viewport').evaluate(el => {
        const css = getComputedStyle(el);
        return { background: css.backgroundColor, radius: css.borderRadius,
          outline: getComputedStyle(el, '::after').content, shadow: css.boxShadow };
      });
      assert.equal(canvas.background, result.sheet, 'free canvas shares the board work surface');
      assert.equal(canvas.outline, 'none', 'free view has no nested canvas outline');
      assert.equal(canvas.radius, '0px', 'free view has no inset rounded canvas');
      assert.equal(canvas.shadow, 'none');
      const assertFullWidth = async () => {
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().iterations)).map(a => a.finished.catch(() => {})));
        });
        const edges = await page.locator('.fc-viewport').evaluate(el => {
          const viewport = el.getBoundingClientRect();
          const panel = el.closest('.board-panel').getBoundingClientRect();
          return { left: viewport.left - panel.left, right: panel.right - viewport.right };
        });
        assert.ok(Math.abs(edges.left) < 1 && Math.abs(edges.right) < 1, 'free canvas clips flush to both panel edges, including when zoomed');
      };
      await assertFullWidth();
      await capture('free-neutral');
      const node = await page.locator('.fc-node').first().boundingBox();
      assert.ok(node, 'zoom around a real node, not empty canvas');
      await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
      for (let index = 0; index < 4; index++) await page.mouse.wheel(0, -400);
      await assertFullWidth();
      const visible = await page.locator('.fc-node').first().evaluate(el => {
        const card = el.getBoundingClientRect(), viewport = el.closest('.fc-viewport').getBoundingClientRect();
        return card.right > viewport.left && card.left < viewport.right && card.bottom > viewport.top && card.top < viewport.bottom;
      });
      assert.ok(visible, 'zoomed capture contains actual content');
      await capture('free-zoomed');
      await page.getByRole('tab', { name: '状态', exact: true }).click();
    }
  }
  assert.notEqual(colors[0].sheet, colors[1].sheet, 'workspace tint reaches the board');
  assert.notEqual(colors[0].card, colors[2].card, 'custom themes recolour cards');
  assert.deepEqual(colors[0], colors[3], 'switching back restores the original theme');
}
