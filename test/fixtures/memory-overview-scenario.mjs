export default async function ({ page, capture, assert, width }) {
  const svg = page.locator('.memory-overview-svg');
  await svg.waitFor();
  const checkFit = async () => {
    await page.waitForFunction(() => {
      const svg = document.querySelector('.memory-overview-svg').getBoundingClientRect();
      const card = document.querySelector('.memory-overview-card').getBoundingClientRect();
      return svg.width < card.width && svg.height < card.height;
    });
    const geometry = await svg.evaluate(el => {
      const s = el.getBoundingClientRect(), c = el.closest('.memory-overview-card').getBoundingClientRect();
      return { dx: Math.abs((s.left + s.right - c.left - c.right) / 2), dy: Math.abs((s.top + s.bottom - c.top - c.bottom) / 2) };
    });
    assert.ok(geometry.dx < 2 && geometry.dy < 2, JSON.stringify(geometry));
  };
  await checkFit();
  if (width < 1100) {
    await page.getByRole('button', { name: '展开最近动态' }).waitFor();
    await page.locator('.mflow-feed').waitFor({ state: 'detached' });
    await checkFit();
  }
  await capture('fit');
  const initialCardSize = await page.locator('.memory-overview-card').boundingBox();
  // Check actual curved routes, card/title/badge bounds and every visible label in Chromium.
  const overlaps = await svg.evaluate(el => {
    const cards = [...el.querySelectorAll('foreignObject')].map(card => ({ id: card.querySelector('[data-testid]').dataset.testid, box: card.getBBox() }));
    const errors = [];
    const brain = el.querySelector('.mflow-brain');
    const toBrain = brain.getCTM().inverse().multiply(el.getCTM());
    const inBrain = (x, y) => brain.isPointInFill(new DOMPoint(x, y).matrixTransform(toBrain));
    for (const { id, box: b } of cards) {
      // Memory operations belong in the brain, with breathing room; conversation is external input.
      if (id === 'overview-node-n-session') {
        for (let x = b.x; x <= b.x + b.width; x += 8) for (let y = b.y; y <= b.y + b.height; y += 8) {
          if (inBrain(x, y)) errors.push('Conversation belongs outside the brain');
        }
      } else {
        for (let x = b.x - 12; x <= b.x + b.width + 12; x += 4) for (let y = b.y - 12; y <= b.y + b.height + 12; y += 4) {
          if (!inBrain(x, y)) errors.push(`${id} extends beyond brain padding`);
        }
      }
    }
    for (const path of el.querySelectorAll('.mflow-edge')) {
      for (let d = 2; d < path.getTotalLength() - 2; d += 2) {
        const p = path.getPointAtLength(d);
        if (!['e-note', 'e-inject', 'e-inject-ustub', 'e-fire'].includes(path.id) && !inBrain(p.x, p.y)) errors.push(`${path.id} leaves brain`);
        for (const { id, box: b } of cards) {
          if (p.x > b.x + 1 && p.x < b.x + b.width - 1 && p.y > b.y + 1 && p.y < b.y + b.height - 1) {
            errors.push(`${path.id} crosses ${id}`); break;
          }
        }
      }
    }
    const labels = [...el.querySelectorAll('.mflow-elabel, .mflow-chip')];
    const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    for (const [index, label] of labels.entries()) {
      const r = label.getBoundingClientRect();
      for (const card of el.querySelectorAll('foreignObject')) if (intersects(r, card.getBoundingClientRect())) errors.push(`Label ${label.textContent} crosses card`);
      for (const other of labels.slice(index + 1)) if (intersects(r, other.getBoundingClientRect())) errors.push(`Labels overlap: ${label.textContent} / ${other.textContent}`);
    }
    for (const node of el.querySelectorAll('.mflow-node')) {
      for (const child of node.querySelectorAll('.mflow-title, .mflow-badge, .mflow-sub')) {
        const r = child.getBoundingClientRect(), b = node.getBoundingClientRect();
        if (r.bottom > b.bottom + 1 || r.right > b.right + 1 || child.scrollWidth > child.clientWidth + 1) errors.push(`Clipped: ${child.textContent}`);
      }
    }
    return [...new Set(errors)];
  });
  assert.deepEqual(overlaps, []);
  await page.getByTestId('overview-node-n-consolidation').hover();
  await page.locator('.mflow-tip').waitFor();
  await capture('memory-agent-hover');
  await page.mouse.move(1, 1);
  await page.getByTestId('overview-node-n-curated').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('html').getAttribute('data-selected-memory-tab'), 'entries');
  const help = page.getByRole('button', { name: '操作说明' });
  await help.click();
  await page.getByRole('note').waitFor();
  assert.ok((await page.getByRole('note').textContent()).includes('双击空白自适应'));
  await capture('help-open');
  await page.keyboard.press('Escape');
  assert.equal(await help.getAttribute('aria-expanded'), 'false');
  await page.getByRole('note').waitFor({ state: 'hidden' });
  await page.waitForFunction(expected => Math.abs(document.querySelector('.memory-overview-card').getBoundingClientRect().width - expected) < 1, initialCardSize.width);

  const card = page.locator('.memory-overview-card');
  const viewport = await card.boundingBox();
  const initial = await svg.boundingBox();
  const x1 = viewport.x + viewport.width * 0.12, y1 = viewport.y + viewport.height * 0.12;
  const x2 = viewport.x + viewport.width * 0.65, y2 = viewport.y + viewport.height * 0.65;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.getByTestId('overview-selection').waitFor();
  await capture('selection');
  await page.mouse.up();
  assert.ok((await svg.boundingBox()).width > initial.width);
  assert.equal(await page.getByTestId('overview-selection').count(), 0);
  await capture('selection-zoom');
  const panBefore = await card.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
  const panX = viewport.x + viewport.width / 2, panY = viewport.y + viewport.height / 2;
  await page.mouse.move(panX, panY);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(panX - 40, panY - 30, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  const panAfter = await card.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
  assert.ok(panAfter.x > panBefore.x || panAfter.y > panBefore.y, JSON.stringify({ panBefore, panAfter }));
  assert.equal(await card.evaluate(el => el.classList.contains('is-panning')), false);
  await capture('panned');
  const blank = await card.evaluate(el => {
    const r = el.getBoundingClientRect();
    for (let y = r.top + 16; y < r.bottom - 16; y += 24) {
      for (let x = r.left + 16; x < r.right - 16; x += 24) {
        const target = document.elementFromPoint(x, y);
        if (target && el.contains(target) && !target.closest('.mflow-node, .mflow-hit, .mflow-gate-hit, .mflow-tip')) return { x, y };
      }
    }
    throw new Error('No blank canvas point');
  });
  await page.mouse.dblclick(blank.x, blank.y);
  await checkFit();
  await capture('double-click-fit');
  const before = await svg.evaluate(el => el.getBoundingClientRect().width);
  await page.getByRole('button', { name: '缩小总览图' }).click();
  assert.ok(await svg.evaluate(el => el.getBoundingClientRect().width) < before);
  await checkFit();
  await capture('zoom-out');
  await page.getByRole('button', { name: '适应画布' }).click();
  if (width < 1100) {
    await page.getByRole('button', { name: '展开最近动态' }).click();
    await page.locator('.mflow-feed[data-mp-stage="in"]').waitFor();
    await checkFit();
    await capture('feed-expanded');
    await page.getByRole('button', { name: '收起最近动态' }).click();
    await page.locator('.mflow-feed').waitFor({ state: 'detached' });
    await checkFit();
  }
  // Actual button actions reach a fully scrollable zoomed canvas.
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: '放大总览图' }).click();
  await page.locator('.memory-overview-card').evaluate(el => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; });
  await capture('zoom-in-scrolled');
  await page.getByRole('button', { name: '适应画布' }).click();
  await checkFit();
  await page.setViewportSize({ width, height: 450 });
  if (width >= 1100) await page.getByRole('button', { name: '展开最近动态' }).waitFor();
  await page.locator('.mflow-feed').waitFor({ state: 'detached' });
  await checkFit();
  await capture('short-panel');
}
