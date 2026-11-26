/** Production components + CSS. Sidebar rows are CSS-only scaffolds, not app navigation coverage. */
export default async function ({ page, capture, assert }) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.interaction-motion-fixture').waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  const settle = () => page.waitForTimeout(220);
  const box = locator => locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const sameBox = (before, after, label) => {
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - after[key]) <= 0.6, `${label}: ${key} changed`);
  };
  const indicator = (locator, pseudo) => locator.evaluate((element, pseudo) => {
    const css = getComputedStyle(element, pseudo);
    const activeSelector = pseudo === '::before'
      ? '.ext-nav-row.is-pane-focused:not([data-drop])'
      : '.left-panel .session-item.is-pane-focused, .left-panel .utility-feature-item.is-pane-focused';
    return { width: parseFloat(css.width), height: parseFloat(css.height),
      opacity: Number(css.opacity), scale: css.transform === 'none' ? 1 : new DOMMatrixReadOnly(css.transform).d,
      rawDuration: css.transitionDuration, rawDelay: css.transitionDelay,
      property: css.transitionProperty, activeSelectorMatches: element.matches(activeSelector),
      transitions: element.getAnimations().filter(animation => 'transitionProperty' in animation).map(animation => ({
        property: animation.transitionProperty, playState: animation.playState, currentTime: animation.currentTime,
        progress: animation.effect?.getComputedTiming().progress ?? null, pseudo: animation.effect?.pseudoElement ?? null
      })),
      selected: element.getAttribute('aria-pressed'), className: element.className,
      drop: element.getAttribute('data-drop'), motion: document.documentElement.dataset.uiMotion,
      duration: Math.max(...css.transitionDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000))) };
  }, pseudo);
  const clear = page.locator('#clear-focus');
  await settle();

  for (const [name, pseudo] of [['session', '::after'], ['utility', '::after'], ['extension', '::before']]) {
    const row = page.locator(`[data-row="${name}"]`);
    await clear.click(); await settle();
    const original = await box(row), off = await indicator(row, pseudo);
    assert.equal(off.width, 2); assert.equal(off.height, 12); assert.ok(off.opacity < .01);
    await row.click();
    // Observe the real CSS transition before a screenshot (screenshots keep animations enabled).
    let middle;
    for (let attempt = 0; attempt < 8; attempt++) {
      middle = await indicator(row, pseudo);
      if (middle.scale > .26 && middle.scale < .999 && middle.opacity > .01 && middle.opacity < .999) break;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    assert.ok(middle.scale > .26 && middle.scale < .999 && middle.opacity > .01 && middle.opacity < .999,
      `${name}: missing a real intermediate scale/opacity`);
    sameBox(original, await box(row), `${name} intermediate row geometry`);
    if (name === 'session') await capture('focus-entering', { animations: 'allow', caret: 'initial' });
    await settle();
    const on = await indicator(row, pseudo);
    assert.equal(on.width, 2); assert.equal(on.height, 12); assert.ok(on.scale > .999 && on.opacity > .999);
    await clear.click(); await page.waitForTimeout(25); await row.click(); await page.waitForTimeout(25);
    await clear.click(); await page.waitForTimeout(25); await row.click(); await settle();
    const reversed = await indicator(row, pseudo);
    assert.ok(reversed.scale > .999 && reversed.opacity > .999, `${name}: fast reversal ends selected`);
    sameBox(original, await box(row), `${name} reversed row geometry`);
  }
  const nav = page.locator('[data-row="extension"]');
  for (const placement of ['before', 'after']) {
    await page.getByLabel('拖放 CSS 标记').selectOption(placement);
    const marker = await indicator(nav, placement === 'before' ? '::before' : '::after');
    assert.equal(marker.height, 2); assert.ok(marker.width > 50); assert.equal(marker.scale, 1);
    assert.equal(marker.opacity, 1); assert.equal(marker.duration, 0);
  }
  await page.getByLabel('拖放 CSS 标记').selectOption(''); await settle();

  // Keep actual selected-button/plate colors from the first painted frames. This catches the
  // old per-button fill fading underneath a simultaneously visible translucent selection plate.
  const startFillProbe = () => page.evaluate(() => {
    window.__segmentFillProbe = { frames: [], done: false };
    const probe = window.__segmentFillProbe;
    let first;
    const alpha = color => {
      if (color === 'transparent') return 0;
      // Chromium may retain color-mix results as color(srgb ... / a), not rgba().
      const slash = color.match(/\/\s*([\d.e+-]+)(%)?\s*\)$/i);
      if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
      const match = color.match(/^rgba?\(([^)]+)\)$/);
      if (!match) return /^(?:color|oklab|oklch|lab|lch|hsl|hwb)\(/.test(color) ? 1 : null;
      const values = match[1].replaceAll('/', ' ').split(/[\s,]+/).filter(Boolean).map(Number);
      return values.length > 3 ? values[3] : 1;
    };
    const frame = now => {
      const group = document.querySelector('.s-seg[data-seg-ready]');
      const selected = group?.querySelector('button[aria-pressed="true"]');
      const plate = group?.querySelector('.s-seg-selection');
      if (selected && plate && group.getBoundingClientRect().width > 0) {
        first ??= now;
        probe.frames.push({ time: now - first, buttonAlpha: alpha(getComputedStyle(selected).backgroundColor),
          plateAlpha: alpha(getComputedStyle(plate).backgroundColor), plateOpacity: Number(getComputedStyle(plate).opacity) });
      }
      if (first !== undefined && now - first >= 180) probe.done = true;
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const checkFill = async label => {
    await page.waitForFunction(() => window.__segmentFillProbe?.done);
    const frames = await page.evaluate(() => window.__segmentFillProbe.frames);
    assert.ok(frames.length >= 3, `${label}: no painted fill samples`);
    assert.ok(frames.every(frame => frame.buttonAlpha !== null && frame.plateAlpha !== null), `${label}: unsupported computed color format`);
    const stacked = frames.filter(frame => frame.plateOpacity > .9 && frame.plateAlpha > .005 && frame.buttonAlpha > .005);
    assert.equal(stacked.length, 0, `${label}: selected button and plate must not paint a double background`);
  };
  await startFillProbe(); await page.locator('#mount-segment').click();
  await capture('segmented-first-show', { animations: 'allow', caret: 'initial' });
  await checkFill('first mount');
  const group = page.getByRole('group', { name: '不同宽标签' });
  const labels = group.getByRole('button');
  const originalLabels = await labels.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  await group.locator('.s-seg-selection').evaluate(element => { window.__stableSegmentPlate = element; });
  for (const label of ['较长标签', '末项', '短', '较长标签']) {
    await group.getByRole('button', { name: label, exact: true }).click();
    await settle();
    const geometry = await group.evaluate(element => {
      const selected = element.querySelector('button[aria-pressed="true"]'), plate = element.querySelector('.s-seg-selection');
      const a = selected.getBoundingClientRect(), b = plate.getBoundingClientRect();
      return { aligned: Math.abs(a.x - b.x) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.height - b.height) <= 1,
        stable: plate === window.__stableSegmentPlate,
        buttons: [...element.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect(); return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, transform: getComputedStyle(button).transform };
        }) };
    });
    assert.ok(geometry.aligned && geometry.stable, 'same plate aligns with actual selected button');
    geometry.buttons.forEach((button, index) => {
      sameBox(originalLabels[index], button.rect, 'segmented label layout'); assert.equal(button.transform, 'none');
    });
  }
  await group.getByRole('button', { name: '短', exact: true }).focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  assert.equal(await group.getByRole('button', { name: '较长标签', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.locator('#toggle-segment').click();
  assert.equal(await group.isVisible(), false);
  await startFillProbe(); await page.locator('#toggle-segment').click();
  await capture('segmented-reshown', { animations: 'allow', caret: 'initial' });
  await checkFill('hidden reveal');
  assert.ok(await group.locator('.s-seg-selection').evaluate(element => element === window.__stableSegmentPlate));

  for (const [kind, label] of [['chat', '复制内容'], ['code', '复制代码']]) {
    const host = page.locator(`[data-copy="${kind}"]`), button = host.getByRole('button', { name: label, exact: true });
    await host.hover(); await button.focus(); await settle();
    const original = await box(button);
    await button.evaluate(element => { window.__stableCopySlot = element.querySelector('.copy-feedback'); });
    await button.click();
    const copied = host.getByRole('button', { name: '已复制', exact: true });
    await copied.waitFor(); sameBox(original, await box(copied), `${kind} successful copy`);
    assert.ok(await copied.evaluate(element => element.querySelector('.copy-feedback') === window.__stableCopySlot));
    assert.equal(await copied.locator('svg').count(), 1);
    assert.equal(await copied.textContent(), '');
    if (kind === 'chat') await capture('copy-success', { animations: 'allow', caret: 'initial' });
  }
  assert.deepEqual(await page.evaluate(() => window.__interactionMotion.clipboardWrites), [
    '复制这段说明，确认成功反馈不改变旁边时间与按钮位置。', 'const ready = true;\nconsole.log(ready);\n'
  ]);
  await page.getByLabel('模拟剪贴板失败').check();
  const code = page.locator('[data-copy="code"]'); await code.hover();
  await code.getByRole('button').click();
  assert.equal(await code.getByRole('button').getAttribute('aria-label'), '复制代码');
  assert.equal(await code.getByRole('button').getAttribute('title'), '复制失败');
  await page.getByLabel('模拟剪贴板失败').uncheck();

  await page.locator('[data-motion="reduced"]').click(); await settle();
  assert.equal(await page.locator('html').getAttribute('data-ui-motion'), 'reduced');
  // Reduced static markers must have no transition at all. A short declared
  // duration is not enough: r3 retained opacity=0/scale=.25 even on the next rAF.
  // These reads deliberately have no timeout/rAF grace period; removing the
  // production no-transition rule must turn this browser regression red.
  for (const [name, pseudo] of [['session', '::after'], ['utility', '::after'], ['extension', '::before']]) {
    const row = page.locator(`[data-row="${name}"]`);
    await clear.click();
    const off = await indicator(row, pseudo);
    assert.equal(off.property, 'none', `reduced ${name} must remove the transition: ${JSON.stringify(off)}`);
    assert.ok(off.duration <= .02 && off.opacity < .001 && Math.abs(off.scale - .25) < .001,
      `reduced ${name} must synchronously reach the unselected target: ${JSON.stringify(off)}`);
    await row.click();
    const on = await indicator(row, pseudo);
    assert.equal(on.selected, 'true', `reduced ${name} target was not activated: ${JSON.stringify(on)}`);
    assert.ok(on.activeSelectorMatches, `reduced ${name} focused selector must match: ${JSON.stringify(on)}`);
    assert.equal(on.property, 'none', `reduced ${name} must not recreate a transition: ${JSON.stringify(on)}`);
    assert.ok(on.duration <= .02 && on.scale > .999 && on.opacity > .999,
      `reduced ${name} must synchronously reach the selected target: ${JSON.stringify(on)}`);
  }
  const plateDuration = await group.locator('.s-seg-selection').evaluate(element => Math.max(...getComputedStyle(element).transitionDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000))));
  assert.ok(plateDuration <= .02, 'shared plate respects reduced motion');
  await capture('reduced-stable', { animations: 'allow' });
  await page.locator('[data-motion="subtle"]').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.uiMotion === 'reduced');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.documentElement.dataset.uiMotion === 'subtle');
  await page.locator('[data-motion="system"]').click(); await settle();
  await page.locator('.interaction-motion-fixture').evaluate(element => { element.scrollTop = 0; });
  await page.locator('h1').click(); await page.mouse.move(1, 1);
  await capture('stable-overview');
}
