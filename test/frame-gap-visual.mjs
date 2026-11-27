/**
 * Chromium regression for separated virtual-screen cards with production CSS.
 * Minimal fixture: real ancestors/cards/divider; leaf content and App dimensions
 * are fixture data. App's measurement body runs against that real layout.
 * This proves CSS layout/paint, not IPC or native DWM/Mica.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { acquireTestLease } from './helpers/lease.mjs';
import { armProcessDeadline } from './helpers/execute.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captures = path.join(root, '.tmp/ui-captures/virtual-screen-gap');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.tsx'), 'utf8');
const appMeasureBody = app.match(/^    const measure = \(\): void => \{([\s\S]*?)^    \};/m)?.[1];
assert.ok(appMeasureBody, 'App viewport measurement body must be available to the browser fixture');
const releaseLease = acquireTestLease(root);
const disarmDeadline = armProcessDeadline(Date.now() + 55_000, 'Virtual-screen gap visual regression');
let browser;
try {
  fs.mkdirSync(captures, { recursive: true });
  const compile = createSharedCompiler(root, path.join(captures, 'compiled'));
  const { BUILTIN_THEMES } = await import(pathToFileURL(compile('shared/theme.ts')).href);
  const { resolveAppearance } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')).href);
  const chrome = process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
  browser = await chromium.launch({ headless: true, ...(chrome && fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://www.oppo.com/**', route => route.abort());
  const cases = [
    ...['dark', 'light'].flatMap(theme => ['terminal', 'git', 'focus'].map(mode => ({ name: `${theme}-${mode}`, theme, mode }))),
    ...['dark', 'light'].map(theme => ({ name: `${theme}-split-edges`, theme, mode: 'focus', split: true })),
    { name: 'dark-terminal-sidebar', theme: 'dark', mode: 'terminal', gap: 12, sidebar: 240 },
    { name: 'dark-git-sidebar', theme: 'dark', mode: 'git', sidebar: 240 },
    { name: 'dark-vs-off', theme: 'dark', mode: 'off', gap: 12 },
    { name: 'light-vs-off', theme: 'light', mode: 'off' },
    { name: 'dark-vs-off-sidebar', theme: 'dark', mode: 'off', sidebar: 240 },
    { name: 'dark-mac-web', theme: 'dark', mode: 'off', mac: true, web: true },
    { name: 'light-mac-sidebar', theme: 'light', mode: 'off', mac: true, sidebar: 240 },
    { name: 'dark-mac-folded', theme: 'dark', mode: 'off', mac: true },
    { name: 'light-mac-folded-vs', theme: 'light', mode: 'terminal', gap: 6, mac: true },
    { name: 'light-mac-fullscreen', theme: 'light', mode: 'off', mac: true, fullscreen: true },
    { name: 'dark-mica', theme: 'dark', mode: 'focus', mica: true, sidebar: 240 },
    { name: 'dark-mica-git', theme: 'dark', mode: 'git', mica: true },
    { name: 'light-mica', theme: 'light', mode: 'focus', gap: 6, mica: true },
    ...['dark', 'light'].map(theme => ({ name: `${theme}-tinted`, theme, mode: 'focus', accent: '#90a8d8' })),
    { name: 'dark-narrow', theme: 'dark', mode: 'terminal', gap: 12, narrow: true },
    { name: 'light-narrow-focus', theme: 'light', mode: 'focus', gap: 12, mac: true, narrow: true }
  ];
  const readings = [];
  for (const scenario of cases) {
    const width = scenario.narrow ? 780 : 1200;
    await page.setViewportSize({ width, height: 600 });
    await page.mouse.move(8, 8);
    await page.setContent(fixture(scenario, width));
    // Same order as styles.css; left.css supplies the in-flow sidebar geometry.
    const imports = fs.readFileSync(path.join(root, 'src/renderer/src/styles.css'), 'utf8').matchAll(/@import '\.\/(.*?)';/g);
    for (const [, file] of imports) await page.addStyleTag({ path: path.join(root, 'src/renderer/src', file) });
    const theme = BUILTIN_THEMES.find(theme => theme.appearance === scenario.theme);
    const appearance = resolveAppearance(theme, { accent: scenario.accent ?? '#8b7bff', enabled: !!scenario.accent });
    const vibrancy = scenario.mac && !scenario.web;
    await page.evaluate(({ scenario, vibrancy, theme, cssVars }) => {
      const html = document.documentElement;
      html.className = [scenario.narrow && 'is-narrow', scenario.mac && 'is-mac', scenario.fullscreen && 'is-native-fullscreen'].filter(Boolean).join(' ');
      html.dataset.theme = theme.appearance;
      html.dataset.nativeMaterial = scenario.mica ? 'mica' : vibrancy ? 'vibrancy' : 'none';
      html.dataset.workspaceMaterial = scenario.accent ? 'frosted' : 'solid';
      html.style.cssText = '';
      for (const [key, value] of Object.entries(cssVars)) html.style.setProperty(key, value);
      if (scenario.gap !== undefined) html.style.setProperty('--frame-gap', `${scenario.gap}px`);
      html.style.setProperty('--workspace-native-tint', 'transparent');
    }, { scenario, vibrancy, theme, cssVars: appearance.cssVars });
    if (process.argv.includes('--baseline-clipped')) await page.addStyleTag({ content: '.main-view,.work-area,.ws-stage,.workspace-page,.h-page{overflow:hidden!important}' });
    if (process.argv.includes('--baseline-covered-rim')) await page.addStyleTag({ content: '.terminal-page>.center-panel::after,.git-page>.side-tools-panel::after{content:none!important}' });
    if (process.argv.includes('--baseline-two-edge-rim')) await page.addStyleTag({ content: '.terminal-page>.center-panel::after,.git-page>.side-tools-panel::after{box-shadow:inset 0 1px 0 var(--material-rim),inset 0 -1px 0 var(--material-rim)!important}' });
    if (process.argv.includes('--baseline-pane-borders')) await page.addStyleTag({ content: '.center-panel.is-split .center-split-pane::after{content:"";position:absolute;inset:0;border-right:1px solid var(--border-subtle);border-bottom:1px solid var(--border-subtle);pointer-events:none}' });
    await settle(page);
    const actual = await measure(page), label = scenario.name;
    const gap = scenario.gap ?? 4;
    const innerGap = gap;
    const appDimensions = await page.evaluate(appMeasureBody => {
      const el = document.querySelector('.main-view');
      const result = {};
      new Function('el', 'setViewW', 'setViewH', appMeasureBody)(el, width => { result.width = width; }, height => { result.height = height; });
      return { ...result, mainWidth: el.clientWidth, stageHeight: el.querySelector('.ws-stage').clientHeight };
    }, appMeasureBody);
    const png = PNG.sync.read(await page.screenshot({ path: path.join(captures, `${label}.png`), omitBackground: !!scenario.mica }));
    if (scenario.split) {
      for (const y of [120, 300, 500]) assert.deepEqual(pixel(png, actual.center.right - 1, y), pixel(png, actual.side.left, y), `${label}: neighboring sheet rims have identical pixels, with no split border doubling`);
      const seam = await page.locator('.center-split-divider > span').boundingBox();
      const panes = await page.locator('.center-split-pane').first().boundingBox();
      assert.equal(seam.width, 1, `${label}: the split stroke stays thin at rest`);
      assert.equal(seam.x + seam.width / 2, panes.x + panes.width, `${label}: the split stroke is centered on the pane edge`);
      assert.ok([Math.floor(seam.x), Math.ceil(seam.x)].some(x => pixel(png, x, 300).join() !== pixel(png, seam.x - 3, 300).join()), 'internal seam remains visible');
      await page.mouse.move(seam.x + seam.width / 2, 300);
      assert.equal((await page.locator('.center-split-divider > span').boundingBox()).width, 3, `${label}: hovering alone thickens the split stroke`);
      await page.mouse.move(8, 8);
    }
    if (scenario.sidebar) {
      const sidebar = await page.locator('.sessions-column').boundingBox();
      const handle = await page.locator('.left-col-resizer').boundingBox();
      assert.equal(handle.x + handle.width / 2, sidebar.x + sidebar.width, `${label}: the left sidebar hit area straddles the pane edge`);
      const width = await page.locator('.left-col-resizer').evaluate(el => getComputedStyle(el, '::before').width);
      assert.equal(width, '1px', `${label}: the left sidebar stroke stays thin at rest`);
      if (handle.x > 0) {
        await page.mouse.move(handle.x + handle.width / 2, 120);
        const hovered = await page.locator('.left-col-resizer').evaluate(el => getComputedStyle(el, '::before').width);
        assert.equal(hovered, '3px', `${label}: hovering the sidebar seam thickens the stroke`);
        await page.mouse.move(8, 8);
      }
    }
    // Separate exposed frame geometry from paper decoration: shadows may paint
    // into the gap, but opaque content must never fill it.
    const decorationOff = await page.addStyleTag({ content: '.terminal-page>.center-panel,.git-page>.side-tools-panel{box-shadow:none!important}.terminal-page>.center-panel::after,.git-page>.side-tools-panel::after{display:none!important}' });
    const plain = PNG.sync.read(await page.screenshot({ omitBackground: !!scenario.mica }));
    await decorationOff.evaluate(el => el.remove());
    readings.push({ scenario, actual, appDimensions });
    assert.deepEqual(errors, [], `${label}: browser errors`);
    const badge = await page.locator('.chrome-sandbox-badge').boundingBox();
    assert.equal(badge.height, 24, `${label}: sandbox badge must not stretch to the 36px title bar`);
    assert.equal(badge.y, 6, `${label}: sandbox badge stays vertically centered`);
    assert.equal(actual.main.bottom - actual.stage.bottom, gap, `${label}: bottom frame gap follows production default or explicit token`);
    if (!scenario.narrow) {
      assert.equal(actual.main.bottom - actual.center.bottom, gap, `${label}: visible card bottom gap equals frame token`);
      if (['git', 'focus'].includes(scenario.mode)) {
        assert.equal(actual.main.right - actual.side.right, gap, `${label}: visible right gap equals bottom gap`);
      }
      for (const selector of ['.center-panel', '.side-tools-panel']) {
        assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).boxShadow), 'none', `${label}: page shadow stays removed`);
      }
    }
    assert.equal(appDimensions.width, appDimensions.mainWidth, `${label}: App viewW follows the actual main-view width`);
    assert.equal(appDimensions.height, appDimensions.stageHeight, `${label}: App viewH follows actual stage height rather than a fixed inset`);
    const splitW = scenario.mode === 'off' ? 28 : innerGap;
    assert.equal(actual.divider.width, splitW, `${label}: trigger strip matches the visual gap (28px edge strip when VS off)`);
    assert.equal(actual.hit.width, splitW, `${label}: detector matches the trigger strip`);
    assert.equal(actual.hit.height, actual.stage.height, `${label}: detector stops above bottom frame`);
    const [defaultRadius, defaultShape] = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return ['--radius-modal', '--corner-shape'].map(token => css.getPropertyValue(token).trim());
    });
    const pageRadius = vibrancy ? `${Math.max(0, 17 - gap)}px` : scenario.mica ? '8px' : defaultRadius;
    const pageShape = vibrancy ? 'superellipse(1.2)' : defaultShape;
    assert.deepEqual(actual.center.radii, Array(4).fill(pageRadius), `${label}: all session panel corners use the shared page radius`);
    if (scenario.sidebar) {
      for (const [selector, pseudo] of [['.session-item[data-session-row]'], ['.agent-notify-bubble', '::before']]) {
        const row = await page.locator(selector).evaluate((el, pseudo) => {
          const css = getComputedStyle(el, pseudo);
          return [css.borderBottomRightRadius, css.getPropertyValue('corner-bottom-right-shape')];
        }, pseudo);
        assert.equal(row[0], pageRadius, `${label}: ${selector} painted corner matches the page radius`);
        if (row[1]) assert.equal(row[1] === 'superellipse(1)' ? 'round' : row[1], pageShape, `${label}: ${selector} painted corner matches the page shape`);
      }
    }
    if (await page.evaluate(() => CSS.supports('corner-bottom-left-shape', 'superellipse(1.2)'))) {
      const cards = scenario.narrow ? ['.center-panel'] : ['.center-panel', '.side-tools-panel'];
      for (const selector of cards) {
        const corners = await page.locator(selector).evaluate(el => [getComputedStyle(el), getComputedStyle(el, '::after')].map(css =>
          ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map(corner => {
            const shape = css.getPropertyValue(`corner-${corner}-shape`);
            return shape === 'superellipse(1)' ? 'round' : shape;
          })));
        assert.deepEqual(corners, Array.from({ length: 2 }, () => Array(4).fill(pageShape)), `${label}: ${selector} and its rim use the shared corner shape`);
      }
    }
    if (scenario.narrow) {
      assert.equal(await page.locator('.pane-split-v').evaluate(el => getComputedStyle(el).visibility), 'hidden', `${label}: the divider is out of pointer and keyboard navigation`);
      assert.deepEqual(actual.terminal.padding, [0, 8, 8, 8], `${label}: narrow terminal keeps responsive padding`);
      assert.deepEqual(actual.git.padding, [0, 0, 0, 0], `${label}: drawer has no desktop half-gap`);
      assert.deepEqual(actual.side.radii, ['0px', '0px', '0px', '0px'], `${label}: drawer retains square card skin`);
      assert.equal(actual.git.right, width, `${label}: open drawer aligns with viewport`);
      assert.equal(await page.locator('.side-tools-panel').evaluate(el => getComputedStyle(el, '::after').content), 'none', `${label}: narrow drawer does not gain a paper rim`);
      continue;
    }
    assert.deepEqual(actual.side.radii, Array(4).fill(pageRadius), `${label}: side card uses the shared page radius`);
    assert.equal(actual.terminal.padding[3], scenario.sidebar || scenario.mode === 'git' ? 0 : gap, `${label}: active outer left gap`);
    assert.equal(actual.git.padding[1], ['git', 'focus'].includes(scenario.mode) ? gap : 0, `${label}: active outer right gap`);
    const frame = pixel(plain, width / 2, 600 - gap / 2);
    const panel = pixel(png, (Math.max(actual.center.left, 0) + Math.min(actual.center.right, width)) / 2, 120);
    assert.notDeepEqual(frame, panel, `${label}: fixture frame differs from card`);
    assert.equal(panel[3], 255, `${label}: reading card stays opaque`);
    if (scenario.mica) assert.equal(frame[3], 0, `${label}: Mica exposes native background with no opaque frame`);
    for (const card of [actual.center, actual.side]) {
      if (card.width <= 0 || card.left >= width || card.right <= 0) continue;
      const middleY = Math.floor((card.top + card.bottom) / 2);
      for (const edgeX of [card.left, card.right - 1]) {
        if (edgeX < 0 || edgeX >= width) continue;
        assert.notDeepEqual(pixel(png, edgeX, middleY), pixel(plain, edgeX, middleY), `${label}: side rim is continuous with top/bottom`);
      }
      const x = Math.floor((Math.max(card.left, 0) + Math.min(card.right, width)) / 2);
      if (x <= 0 || x >= width || card.left >= width || card.right <= 0) continue;
      for (const [edge, y] of [['top rim over content', card.top], ['bottom rim over content', card.bottom - 1]]) {
        assert.notDeepEqual(pixel(png, x, y), pixel(plain, x, y), `${label}: ${edge} remains visible`);
      }
    }
    if (scenario.mode === 'off') {
      assert.equal(actual.terminal.padding[1], gap, `${label}: VS off exposes a full outer frame gap`);
      assert.equal(actual.git.padding[3], 0, `${label}: hidden Git page has no inner half-gap`);
      assert.equal(actual.center.right, width - gap, `${label}: terminal right inset matches the bottom frame gap`);
      assert.deepEqual(pixel(plain, width - gap / 2, 120), frame, `${label}: right edge exposes frame background`);
      continue;
    }
    assert.equal(actual.side.left - actual.center.right, innerGap, `${label}: inner gap matches outer frame`);
    if (scenario.mica) {
      // Measure the empty pixels between the OUTSIDE edges of intact inset rims.
      // Do not include either rim, or infer the gap from the frame's RGB colour:
      // native Mica can differ across the window and is transparent in CDP PNGs.
      const emptyRuns = [
        Array.from({ length: innerGap }, (_, i) => pixel(png, actual.center.right + i, 300)[3]),
        Array.from({ length: gap }, (_, i) => pixel(png, actual.side.right + i, 300)[3]),
        Array.from({ length: gap }, (_, i) => pixel(png, 900, actual.side.bottom + i)[3]),
      ];
      for (const alpha of emptyRuns) assert.deepEqual(alpha, Array(alpha.length).fill(0), `${label}: inner/right/bottom gaps contain only native frame, with rims intact`);
      for (const [x, y] of [[actual.center.right - 1, 300], [actual.side.left, 300], [actual.side.right - 1, 300], [900, actual.side.bottom - 1]]) {
        assert.equal(pixel(png, x, y)[3], 255, `${label}: rim belongs inside the opaque card`);
      }
    }
    assert.equal(actual.terminal.padding[1], Math.floor(innerGap / 2), `${label}: terminal contributes the rounded-down half`);
    assert.equal(actual.git.padding[3], Math.ceil(innerGap / 2), `${label}: Git contributes the remaining whole pixels`);
    const splitX = actual.divider.left + actual.divider.width / 2;
    assert.equal(splitX, (actual.center.right + actual.side.left) / 2, `${label}: divider stays centered in gap`);
    for (let x = actual.center.right; x < actual.side.left; x++) assert.deepEqual(pixel(plain, x, 120), frame, `${label}: gap pixel ${x} exposes frame under decoration`);
    assert.equal(actual.line.background, 'rgba(0, 0, 0, 0)', `${label}: idle divider adds no line over paper shadows`);
    // Sample the outermost card pixel on both sides, outside the curved edge.
    for (const [x, y] of [[actual.center.right - 1, actual.center.top], [actual.center.right - 1, actual.center.bottom - 1], [actual.side.left, actual.side.top], [actual.side.left, actual.side.bottom - 1]]) {
      assert.deepEqual(pixel(plain, x, y), frame, `${label}: inner rounded corner exposes frame`);
    }
    const halfGap = innerGap / 2;
    const hit = await page.evaluate(({ splitX, halfGap }) => [halfGap - 1, -(halfGap + 1)].map(dx => !!document.elementFromPoint(splitX + dx, 80)?.closest('.pane-split-hit')), { splitX, halfGap });
    assert.deepEqual(hit, [true, false], `${label}: gap interior is hit-testable; detector no longer covers page scrollbars outside the gap`);
    if (label === 'dark-terminal') {
      // React supplies these classes; this verifies CSS feedback, not gestures.
      for (const state of ['hot', 'reshaping']) {
        await page.evaluate(state => {
          const divider = document.querySelector('.pane-split');
          divider.classList.toggle('hot', state === 'hot');
          divider.toggleAttribute('data-resizing', state === 'reshaping');
          document.querySelector('.main-view').classList.toggle('is-reshaping', state === 'reshaping');
        }, state);
        await settle(page);
        const feedback = await measure(page);
        assert.notEqual(feedback.line.background, 'rgba(0, 0, 0, 0)', `${state}: active divider remains visible`);
        assert.equal(feedback.line.width, 3, `${state}: hover and drag use the 3px stroke`);
        assert.equal(feedback.line.left + feedback.line.width / 2, splitX, `${state}: the stroke is centered in the page gap`);
        if (state === 'hot') await page.screenshot({ path: path.join(captures, 'dark-terminal-divider-hover.png') });
      }
      await page.evaluate(() => {
        document.querySelector('.pane-split').classList.remove('hot');
        document.querySelector('.pane-split').removeAttribute('data-resizing');
        document.querySelector('.main-view').classList.remove('is-reshaping');
      });
      await settle(page);
      assert.equal((await measure(page)).line.width, 1, 'leaving the divider restores the thin stroke');
      assert.deepEqual(pixel(PNG.sync.read(await page.screenshot()), splitX, 120), pixel(png, splitX, 120), 'resize release restores paper shadows without divider');
      assert.equal((await measure(page)).terminal.opacity, '1', 'resize release restores card opacity');
      // During the existing workspace slide the next film cell can start right
      // at the stage boundary: its content must not leak into the 6px gutter.
      await page.evaluate(() => {
        document.querySelector('.ws-stage').classList.add('is-sliding');
        const next = document.createElement('div');
        next.id = 'offscreen-film-cell';
        next.style.cssText = 'position:absolute;top:100%;left:0;width:100%;height:8px;background:magenta';
        document.querySelector('.h-strip').append(next);
      });
      const sliding = PNG.sync.read(await page.screenshot());
      assert.deepEqual(pixel(sliding, 300, actual.stage.bottom + 1), frame, 'workspace slide still clips the next cell above the bottom gutter');
      await page.evaluate(() => {
        document.querySelector('#offscreen-film-cell').remove();
        document.querySelector('.ws-stage').classList.remove('is-sliding');
      });
      await page.evaluate(() => { document.querySelector('.work-area').scrollLeft = 10; });
      assert.equal(await page.locator('.work-area').evaluate(el => el.scrollLeft), 0, 'horizontal clipping cannot become a scroll container');
      await page.locator('.center-panel > div').evaluate(el => {
        window.paperContentClicks = 0;
        el.addEventListener('click', () => { window.paperContentClicks++; });
      });
      await page.mouse.click(300, actual.center.top + 1);
      assert.equal(await page.evaluate(() => window.paperContentClicks), 1, 'paper rim lets clicks through to the content at the edge');
    }
  }
  for (const themeName of ['dark', 'light']) {
    await page.setViewportSize({ width: 780, height: 600 });
    await page.setContent(`<div class="board-column" style="position:absolute;left:20px;top:20px;width:350px;height:240px"><div style="position:absolute;inset:0;background:var(--surface-board-column)"></div></div><div class="fc-viewport" style="position:absolute;left:400px;top:20px;width:350px;height:240px"></div><div class="chat-input-shell" style="position:absolute;left:20px;top:300px;width:350px;height:180px">Composer</div><div class="board-card" style="position:absolute;left:400px;top:300px;width:350px;height:180px">Card</div>`);
    for (const [, file] of fs.readFileSync(path.join(root, 'src/renderer/src/styles.css'), 'utf8').matchAll(/@import '\.\/(.*?)';/g)) await page.addStyleTag({ path: path.join(root, 'src/renderer/src', file) });
    await page.locator('.chat-input-shell').evaluate(el => {
      const host = document.createElement('div'); host.className = 'chat-surface-view';
      el.replaceWith(host); host.append(el);
      const input = document.createElement('textarea'); input.setAttribute('aria-label', 'Elevation focus regression'); el.append(input);
    });
    const theme = BUILTIN_THEMES.find(item => item.appearance === themeName);
    const appearance = resolveAppearance(theme);
    await page.evaluate(name => { document.documentElement.className = ''; document.documentElement.dataset.theme = name; document.documentElement.dataset.nativeMaterial = 'none'; document.documentElement.dataset.workspaceMaterial = 'solid'; document.documentElement.style.cssText = ''; }, themeName);
    await page.evaluate(vars => { for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value); }, appearance.cssVars);
    await settle(page);
    for (const selector of ['.board-column', '.fc-viewport']) {
      assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el, '::after').content), 'none', `${selector}: blends into the board without an inner rim`);
    }
    const shadows = await page.locator('.chat-input-shell, .board-card').evaluateAll(els => els.map(el => getComputedStyle(el).boxShadow));
    assert.equal(shadows[0], 'none', 'Composer has no resting shadow');
    assert.equal(shadows[1], 'none', 'Board card has no resting shadow');
    await page.getByRole('textbox', { name: 'Elevation focus regression' }).focus();
    await settle(page);
    assert.equal(await page.locator('.chat-input-shell').evaluate(el => getComputedStyle(el).boxShadow), 'none', 'Composer focus does not restore a shadow');
    await page.getByRole('textbox', { name: 'Elevation focus regression' }).evaluate(el => el.blur());
    await settle(page);
    const borders = await page.locator('.chat-input-shell, .board-card').evaluateAll(els => els.map(el => getComputedStyle(el).borderTopColor));
    assert.notEqual(borders[0], borders[1], 'content cards and editable inputs have independent resting edges');
    await page.screenshot({ path: path.join(captures, `${themeName}-elevation.png`) });
  }
  fs.writeFileSync(path.join(captures, 'geometry.json'), JSON.stringify(readings, null, 2));
  console.log(`frame-gap-visual: OK (${cases.length} production-CSS fixture states; no IPC/native Mica verification)`);
  console.log(`Screenshots: ${captures}`);
} finally {
  if (browser) await browser.close();
  disarmDeadline();
  releaseLease();
}

function fixture(scenario, width) {
  const vs = !['off', 'focus'].includes(scenario.mode);
  const workspace = scenario.mode === 'off' ? width : scenario.mode === 'focus' ? width / 2 : 1050;
  const git = scenario.mode === 'off' ? 0 : scenario.mode === 'focus' ? width / 2 : 800;
  const sidebar = scenario.sidebar ?? 0;
  const offset = scenario.mode === 'git' ? -(workspace - (width - git)) : 0;
  const classes = [sidebar ? '' : 'sessions-hidden', scenario.mode === 'git' ? 'h-git' : 'h-terminal', vs ? 'h-vs-on' : 'h-vs-off', scenario.mode === 'focus' ? 'is-focus' : ''].join(' ');
  return `<div id="root"><div class="app-shell">
    <header class="chrome-bar"><span class="chrome-sandbox-badge">沙箱隔离</span></header>
    <main class="main-view ${classes}"><div class="ws-stage"><div class="ws-rail ws-rail-idle"><div class="ws-pane ws-pane-live">
      <div class="work-area" style="width:${width}px"><div class="h-strip${vs ? ' vs-axis' : ''}" style="width:${Math.max(workspace + git, width)}px;transform:translate3d(${offset}px,0,0)">
        <div class="h-page workspace-page" style="width:${workspace}px">
          ${sidebar ? `<div class="sessions-column" style="width:${sidebar}px">
            <div class="session-item active is-pane-open" data-session-row>Session</div>
            <div class="left-ws-slot"><div class="agent-ws-stack"><div class="agent-ws-stack-item is-active"><button class="agent-notify-bubble">Workspace</button></div></div></div>
          </div><div class="left-col-resizer resize-divider" style="left:${sidebar}px"></div>` : ''}
          <div class="terminal-page" style="width:${workspace - sidebar}px"><div class="center-panel${scenario.split ? ' is-split' : ''}"><div style="position:absolute;inset:0;background:var(--surface-canvas)"></div>${scenario.split ? '<div class="center-split-root"><div class="center-split-pane" style="left:0;top:0;width:50%;height:100%"></div><div class="center-split-pane" style="left:50%;top:0;width:50%;height:100%"></div><div class="center-split-divider" aria-orientation="vertical" style="left:calc(50% - 4px);top:0;width:8px;height:100%"><span class="resize-divider-line"></span></div></div>' : ''}</div></div>
        </div>
        <div class="h-page git-page${scenario.narrow ? ' is-drawer-open' : ''}" style="width:${git}px"><div class="side-tools-panel right-workspace"><div style="position:absolute;inset:0;background:var(--surface-canvas)"></div></div></div>
        <div class="pane-split pane-split-v" style="left:${workspace}px"><div class="pane-split-line resize-divider-line"></div><div class="pane-split-hit"></div></div>
      </div></div>
    </div></div></div></main>
  </div></div>`;
}

async function settle(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().iterations)).map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const box = selector => {
      const element = document.querySelector(selector), rect = element.getBoundingClientRect(), css = getComputedStyle(element);
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(Number.parseFloat),
        radii: [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius],
        background: css.backgroundColor, opacity: css.opacity };
    };
    return Object.fromEntries(Object.entries({ main: '.main-view', stage: '.ws-stage', terminal: '.terminal-page', git: '.git-page', center: '.center-panel', side: '.side-tools-panel', divider: '.pane-split-v', hit: '.pane-split-hit', line: '.pane-split-line' }).map(([name, selector]) => [name, box(selector)]));
  });
}

function pixel(png, x, y) {
  const index = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  return Array.from(png.data.subarray(index, index + 4));
}
