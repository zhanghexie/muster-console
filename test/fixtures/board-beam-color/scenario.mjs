import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'playwright-core/lib/utilsBundle';

function countColors(actual, plain, threshold = 24) {
  let changed = 0, colored = 0, neutral = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    const rgb = [actual.data[i], actual.data[i + 1], actual.data[i + 2]];
    const delta = rgb.reduce((sum, value, channel) => sum + Math.abs(value - plain.data[i + channel]), 0);
    if (delta < threshold) continue;
    changed++;
    const chroma = Math.max(...rgb) - Math.min(...rgb);
    if (chroma >= 30) colored++;
    else if (chroma < 18) neutral++;
  }
  return { changed, colored, neutral };
}

export default async function ({ page, theme, width, capture, assert }) {
  const out = path.resolve('.tmp/ui-captures/board-beam-color');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('[data-ready="true"]').waitFor();
  await page.locator('#notify').click(); await page.mouse.move(0, 100);
  const beam = page.locator('.g-board-peek-beam[data-board-beam-active]'); await beam.waitFor();
  const bounds = await beam.evaluate(el => {
    const beam = el.getBoundingClientRect(), sheet = el.closest('.g-board-sheet').getBoundingClientRect();
    return { height: beam.height, sheetHeight: sheet.height, top: beam.top, sheetTop: sheet.top, hasContent: !!el.querySelector('.board-utility-panel') };
  });
  assert.equal(bounds.height, bounds.sheetHeight - 2, 'effect must cover the full panel height, not a footer strip');
  assert.equal(bounds.top, bounds.sheetTop + 1, 'effect follows the panel top boundary');
  assert.ok(bounds.hasContent, 'Beam wraps real board content');
  await page.waitForTimeout(700);
  const snapshots = [];
  let coveredPixels = 0;
  for (const phase of [.35, .5, .65]) {
    await page.locator('.g-board-sheet').evaluate((sheet, phase) => {
      for (const animation of sheet.getAnimations({ subtree: true })) {
        animation.pause();
        const duration = Number(animation.effect.getTiming().duration);
        animation.currentTime = animation.animationName?.includes('fade-in') ? duration
          : animation.animationName === 'g-board-peek-bob' ? duration / 2
            : duration * phase;
      }
    }, phase);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const rect = await page.locator('.g-board-sheet').boundingBox();
    const clip = { x: Math.ceil(rect.x + 160), y: Math.floor(rect.y + rect.height - 15), width: Math.floor(rect.width - 184), height: 15 };
    const actualBuffer = await page.screenshot({ clip, animations: 'allow' });
    await beam.evaluate(el => { el.style.setProperty('--beam-strength', '0'); });
    const plain = PNG.sync.read(await page.screenshot({ clip, animations: 'allow' }));
    await beam.evaluate(el => { el.style.setProperty('--beam-strength', '1'); });
    const stats = countColors(PNG.sync.read(actualBuffer), plain);
    fs.writeFileSync(path.join(out, `${theme}-${width}-${phase}-strip.png`), actualBuffer);
    snapshots.push({ phase, ...stats });
    await capture(`color-${Math.round(phase * 100)}`, { animations: 'allow' });
    if (phase === .5) {
      // 真正的纸面遮挡：浮动最高处露出的列卡片不能被底板光效染色。
      // 对比同一帧开关 Beam 的像素，避免仅检查 z-index 配置。
      for (const column of await page.locator('.board-column:visible').all()) {
        const box = await column.boundingBox();
        const y = Math.max(2, Math.ceil(box.y + 12));
        const height = Math.min(8, Math.floor(box.y + box.height - 6 - y));
        if (height <= 0) continue;
        const x = Math.max(0, Math.ceil(box.x + 24));
        const right = Math.min(page.viewportSize().width, Math.floor(box.x + box.width - 24));
        if (right <= x) continue;
        const paperClip = { x, y, width: right - x, height };
        const lit = PNG.sync.read(await page.screenshot({ clip: paperClip, animations: 'allow' }));
        await beam.evaluate(el => { el.style.setProperty('--beam-strength', '0'); });
        const unlit = PNG.sync.read(await page.screenshot({ clip: paperClip, animations: 'allow' }));
        await beam.evaluate(el => { el.style.setProperty('--beam-strength', '1'); });
        const tinted = countColors(lit, unlit, 1).changed;
        coveredPixels += paperClip.width * paperClip.height;
        assert.equal(tinted, 0, `${theme}: column paper must cover the base beam; ${tinted} tinted pixels`);
      }
      // 负控：改成灰度后必须失去彩色像素，防止测试只检查 colorful 配置。
      await beam.evaluate(el => { el.style.filter = 'grayscale(1)'; });
      const grayBuffer = await page.screenshot({ clip, animations: 'allow' });
      const gray = countColors(PNG.sync.read(grayBuffer), plain);
      await beam.evaluate(el => { el.style.filter = ''; });
      fs.writeFileSync(path.join(out, `${theme}-${width}-gray-control.png`), grayBuffer);
      assert.ok(gray.changed > 100, 'negative control must still contain a visible beam');
      assert.equal(gray.colored, 0, 'grayscale beam must not satisfy the color detector');
    }
  }
  assert.ok(coveredPixels > 100, 'occlusion must sample visible paper, not an empty region');
  const layers = await beam.evaluate(el => Object.fromEntries(['::before', '::after', 'bloom'].map(layer => {
    const css = layer === 'bloom' ? getComputedStyle(el.querySelector('[data-beam-bloom]')) : getComputedStyle(el, layer);
    return [layer, { background: css.backgroundImage, filter: css.filter, opacity: css.opacity }];
  })));
  const totals = snapshots.reduce((sum, item) => ({ changed: sum.changed + item.changed, colored: sum.colored + item.colored, neutral: sum.neutral + item.neutral }), { changed: 0, colored: 0, neutral: 0 });
  const result = { theme, snapshots, totals, colorRatio: totals.colored / Math.max(1, totals.changed), layers };
  fs.writeFileSync(path.join(out, `${theme}-${width}-pixels.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ theme, ...totals, colorRatio: result.colorRatio }));
  assert.ok(totals.colored > 100, `${theme}: visible colored pixels required, got ${totals.colored}`);
  assert.ok(result.colorRatio >= .35, `${theme}: colorful effect washed out; ratio ${result.colorRatio.toFixed(3)}`);
  assert.notEqual(layers['::before'].background, 'none', 'colored inner layer must paint');
  assert.notEqual(layers['::after'].background, 'none', 'colored border layer must paint');
  const radii = await beam.evaluate(el => {
    const sheet = getComputedStyle(el.closest('.g-board-sheet'));
    return {
      token: sheet.getPropertyValue('--radius-modal').trim(), sheet: sheet.borderTopLeftRadius,
      beam: getComputedStyle(el).borderTopLeftRadius,
      before: getComputedStyle(el, '::before').borderTopLeftRadius,
      after: getComputedStyle(el, '::after').borderTopLeftRadius,
      bloom: getComputedStyle(el.querySelector('[data-beam-bloom]')).borderTopLeftRadius
    };
  });
  assert.equal(radii.sheet, radii.token, 'sheet uses the current shared modal radius token');
  for (const layer of ['beam', 'before', 'after', 'bloom']) assert.equal(radii[layer], radii.sheet, `${layer} inherits the real sheet radius rather than the library numeric fallback`);

  const container = await beam.elementHandle();
  await page.mouse.click((await page.locator('.g-board-sheet').boundingBox()).x + 200, 15);
  await page.locator('.g-board-sheet.is-open').waitFor();
  assert.ok(await container.evaluate(el => el.isConnected), 'opening must preserve the full-panel Beam container');
  assert.equal(await container.evaluate(el => getComputedStyle(el).animationName), 'none', 'open board stops decorative loops');
  assert.equal(await container.evaluate(el => getComputedStyle(el, '::after').display), 'none', 'open board hides decoration only');
  assert.ok(await page.locator('.board-toolbar').isVisible(), 'real board content remains visible');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#toggle').click(); await beam.waitFor();
  assert.equal(await beam.evaluate(el => getComputedStyle(el, '::after').display), 'none');
  const box = await page.locator('.g-board-sheet').boundingBox();
  await page.mouse.click(box.x + 200, 15);
  await page.locator('.g-board-sheet.is-open').waitFor();
  assert.ok(await page.locator('.board-toolbar').isVisible(), 'reduced-motion must never hide the real panel content');
  await capture('open-reduced-motion');

  // Real Chromium/library regression: keep @property/style identity while the business
  // subtree still follows complete presence unmount. This does not measure latency.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const beam = document.querySelector('.g-board-peek-beam');
    const style = beam.previousElementSibling;
    if (style?.tagName !== 'STYLE' || !style.textContent.includes('@property --beam-x-')) throw new Error('Real Beam stylesheet missing');
    const state = { beam, style, css: style.textContent, business: beam.querySelector('.board-utility-panel'), mutations: 0 };
    state.observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target === style || style.contains(record.target)
          || [...record.addedNodes, ...record.removedNodes].includes(style)) state.mutations++;
      }
    });
    state.observer.observe(style.parentElement, { childList: true, subtree: true, characterData: true });
    window.__beamRetention = state;
  });
  // Close through the exempt toggle before clearing the reminder. At narrow widths
  // the peek trigger covers the header: combining pointerdown outside-dismiss with
  // a header button click can move the hit target before mouseup and cancel click.
  await page.locator('#toggle').click();
  await page.locator('.g-board-sheet.is-peek').waitFor();
  await page.locator('.g-board-peek-trigger').waitFor();
  await page.locator('#clear-notify').click();
  await page.locator('.g-board-overlay[hidden]').waitFor({ state: 'attached' });
  const hidden = await page.evaluate(() => {
    const state = window.__beamRetention, root = state.beam.closest('.g-board-overlay');
    return {
      display: getComputedStyle(root).display, inert: root.inert, ariaHidden: root.getAttribute('aria-hidden'),
      focused: root.contains(document.activeElement), businessConnected: state.business.isConnected,
      actionable: root.querySelectorAll('button,input,textarea,[tabindex]').length,
      active: state.beam.hasAttribute('data-board-beam-active'), strength: state.beam.style.getPropertyValue('--beam-strength'),
      runningAnimations: root.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
      sameShell: document.querySelector('.g-board-peek-beam') === state.beam,
      sameStyle: state.beam.previousElementSibling === state.style && state.style.isConnected,
      sameCss: state.style.textContent === state.css, stylesheetMutations: state.mutations
    };
  });
  assert.deepEqual(hidden, {
    display: 'none', inert: true, ariaHidden: 'true', focused: false, businessConnected: false,
    actionable: 0, active: false, strength: '0', runningAnimations: 0,
    sameShell: true, sameStyle: true, sameCss: true, stylesheetMutations: 0
  }, 'fully closed Beam keeps only a hidden inactive style shell, with no business subtree or stylesheet mutation');
  await page.locator('#toggle').click();
  await page.locator('.board-toolbar').waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reopened = await page.evaluate(() => {
    const state = window.__beamRetention;
    state.observer.disconnect();
    return {
      sameShell: document.querySelector('.g-board-peek-beam') === state.beam,
      sameStyle: state.beam.previousElementSibling === state.style && state.style.isConnected,
      sameCss: state.style.textContent === state.css, stylesheetMutations: state.mutations,
      newBusiness: state.beam.querySelector('.board-utility-panel') !== state.business
    };
  });
  assert.deepEqual(reopened, { sameShell: true, sameStyle: true, sameCss: true, stylesheetMutations: 0, newBusiness: true }, 'reopen preserves registered styles and creates fresh board business state');
}
