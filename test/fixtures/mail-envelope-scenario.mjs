export default async function ({ page, capture, assert }) {
  await page.bringToFront();
  const phase = name => page.waitForFunction(name => document.querySelector('.mail-envelope-scene')?.dataset.phase === name, name);
  const reset = async () => {
    await page.evaluate(() => window.mailFixture.reset());
    await page.waitForFunction(() => !document.querySelector('.mail-envelope-scene'));
  };
  const pose = async progress => {
    await page.waitForFunction(progress => {
      const el = document.querySelector('.mail-envelope-scene');
      if (!el || el.dataset.phase !== 'motion') return false;
      const value = Number(el.dataset.progress);
      return el.dataset.direction === 'send' ? value >= progress : value <= progress;
    }, progress);
    await page.evaluate(() => window.mailFixture.freeze());
    return page.evaluate(() => {
      const matrix = selector => {
        const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(selector)).transform);
        return { x: m.m41, y: m.m42, tilt: m.m23, a: m.m11, b: m.m12 };
      };
      return { top: matrix('.es-top'), bottom: matrix('.es-bottom'), flight: matrix('.es-flight'),
        font: getComputedStyle(document.querySelector('.mail-letter')).fontSize,
        overflow: document.documentElement.scrollWidth > innerWidth, layer: document.querySelector('.mail-envelope-scene').dataset.paperLayer };
    });
  };
  await page.getByRole('button', { name: '寄三封信' }).click(); await phase('preview');
  await page.waitForTimeout(330);
  const slices = await page.locator('.mail-letter').evaluateAll(nodes => nodes.map(el => {
    const rect = el.getBoundingClientRect(); return { width: rect.width, height: rect.height };
  }));
  assert.ok(slices.every(rect => Math.abs(rect.width - slices[0].width) < .01 && Math.abs(rect.height - slices[0].height) < .01),
    'all three paper slices retain identical content geometry, including thin paper edges');
  assert.equal(await page.locator('.es-flight').count(), 3);
  const stationery = await page.locator('.mail-letter-route').first().evaluate(el => ({
    rule: getComputedStyle(el).borderBottomStyle,
    seam: getComputedStyle(document.querySelector('.es-pocket-surface'), '::before').backgroundImage,
    decoration: getComputedStyle(document.querySelector('.es-pocket-surface'), '::after').content,
  }));
  assert.equal(stationery.rule, 'solid');
  assert.ok(stationery.seam.includes('svg'), 'envelope fold seams remain part of the paper surface');
  assert.equal(stationery.decoration, 'none', 'the envelope front shows fold seams without a seal');
  assert.equal(await page.locator('.mail-envelope-scene').getAttribute('data-count'), '3');
  assert.equal(await page.locator('.mail-envelope-viewport input,.mail-envelope-viewport button').count(), 0);
  await capture('send-three-pages', { animations: 'allow' });
  const sent = await pose(.14);
  assert.ok(Math.abs(Math.abs(sent.top.tilt) - Math.abs(sent.bottom.tilt)) < .01, 'both folds use the same native clock/curve');
  assert.equal(sent.flight.x, 0); assert.equal(sent.flight.b, 0); assert.equal(sent.flight.a, 1);
  assert.equal(sent.font, '13px'); assert.equal(sent.overflow, false); assert.equal(sent.layer, 'front');
  await capture('send-folding', { animations: 'allow' });
  await reset();
  await page.evaluate(() => window.mailFixture.hold());
  await page.getByRole('button', { name: '寄三封信' }).click();
  await page.waitForFunction(() => window.mailFixture.waiting());
  assert.equal(await page.locator('.es-flight').first().evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42), 0,
    'the native flight track stays at zero until the write is acknowledged');
  await capture('send-awaiting-commit', { animations: 'allow' });
  await page.evaluate(() => window.mailFixture.release());
  await page.waitForFunction(() => {
    const el = document.querySelector('.es-flight');
    return el && new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 < -1;
  });
  await reset();
  await page.getByRole('button', { name: '查看收件方' }).click();
  await page.getByRole('button', { name: '寄三封信' }).click();
  const arrival = await pose(.52);
  assert.ok(arrival.flight.y < 0); assert.equal(arrival.flight.x, 0); assert.equal(arrival.layer, 'inside');
  await capture('receive-envelope-arriving', { animations: 'allow' });
  await reset();
  await page.getByRole('button', { name: '寄三封信' }).click();
  const unfold = await pose(.14);
  assert.equal(unfold.layer, 'front'); assert.ok(Math.abs(unfold.top.tilt) > .05);
  await capture('receive-unfolding', { animations: 'allow' });
  await reset();
  await page.getByRole('button', { name: '寄三封信' }).click(); await phase('preview');
  await capture('receive-readable-pages', { animations: 'allow' });
  await page.waitForTimeout(1200); assert.equal(await page.locator('.mail-envelope-scene').getAttribute('data-phase'), 'preview');
  await page.waitForFunction(() => !document.querySelector('.mail-envelope-scene'));
  await page.getByRole('button', { name: '切换前台' }).click(); await page.getByRole('button', { name: '寄三封信' }).click();
  await page.getByRole('button', { name: '切换前台' }).click(); assert.equal(await page.locator('.mail-envelope-scene').count(), 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '查看发送方' }).click(); await page.getByRole('button', { name: '寄三封信' }).click();
  await phase('preview'); await capture('reduced-motion-static', { animations: 'allow' });
  await page.waitForFunction(() => !document.querySelector('.mail-envelope-scene'));
}
