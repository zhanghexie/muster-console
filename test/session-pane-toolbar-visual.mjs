/** Production CenterPanel/store/CSS; only IPC and content leaves are substituted.
 * Real Chromium verifies hover chrome without layout reservation, narrow controls and pointer capture. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { viteFixtureAssets } from '../.agents/skills/ui-verification/scripts/vite-fixture-assets.mjs';
import { chromium } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';
import { armProcessDeadline } from './helpers/execute.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = acquireTestLease(root);
const disarm = armProcessDeadline(Date.now() + 55_000, 'Session pane toolbar Chromium');
const out = path.join(root, '.tmp/ui-captures/session-pane-toolbar');
const report = { boundary: 'Production CenterPanel/store/CSS; mock IPC and terminal/chat/tool leaves. No native Electron acceptance.', cases: [] };
let browser, server;
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function waitToolbar(page, slot, visible) {
  await page.waitForFunction(({ slot, visible }) => {
    const toolbar = document.querySelector(`[data-testid="center-pane-${slot}"] .center-split-pane-toolbar`);
    const opacity = toolbar && Number(getComputedStyle(toolbar).opacity);
    return toolbar && (visible ? opacity > .999 : opacity < .001);
  }, { slot, visible });
}
async function reveal(page, slot) {
  const rect = await page.getByTestId(`center-pane-${slot}`).boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 4); await waitToolbar(page, slot, true);
}
async function resizeDivider(page, index, ratio, cancel = false) {
  const area = await page.getByTestId('center-panel').boundingBox();
  const divider = page.getByTestId(index === 0 ? 'center-split-divider' : 'center-split-divider-1');
  const rect = await divider.boundingBox();
  assert.ok(rect, 'Three-pane divider must be rendered');
  const vertical = await divider.getAttribute('aria-orientation') === 'vertical';
  // Avoid the focus-layout junction, where the horizontal handle legitimately owns the hit.
  const x = rect.x + rect.width / 2, y = rect.y + rect.height * (vertical ? .25 : .5);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.center-split-divider')?.getAttribute('data-testid'), { x, y });
  assert.equal(hit, index === 0 ? 'center-split-divider' : 'center-split-divider-1', 'Native start point must hit the requested divider');
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(vertical ? area.x + area.width * ratio : x, vertical ? y : area.y + area.height * ratio, { steps: 5 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up(); await frame(page);
  const result = await page.evaluate(() => window.__centerSplitTest.split.getCenterSplitState().ratios);
  (report.resizeActions ??= []).push({ index, ratio, cancel, rect, vertical, result });
  return result;
}
async function chromeGeometry(page, label) {
  const snapshot = await page.getByTestId('center-panel').evaluate(main => {
    const sheet = main.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(main).getPropertyValue('--radius-page'));
    return [...main.querySelectorAll('.center-split-pane')].filter(pane => pane.getAttribute('aria-hidden') !== 'true').map(pane => {
      const bar = pane.querySelector('.center-split-pane-toolbar'), handle = pane.querySelector('.center-split-handle');
      const rect = bar.getBoundingClientRect(), grip = handle.getBoundingClientRect(), css = getComputedStyle(bar);
      return { slot: pane.dataset.pane, delta: grip.x + grip.width / 2 - (rect.x + rect.width / 2),
        radii: [parseFloat(css.borderTopLeftRadius), parseFloat(css.borderTopRightRadius)],
        expected: [Math.abs(rect.y - sheet.y) < .5 && Math.abs(rect.x - sheet.x) < .5 ? radius : 0,
          Math.abs(rect.y - sheet.y) < .5 && Math.abs(rect.right - sheet.right) < .5 ? radius : 0] };
    });
  });
  for (const pane of snapshot) {
    assert.ok(Math.abs(pane.delta) < .1, `${label} slot ${pane.slot}: handle must be at the exact pane center`);
    assert.deepEqual(pane.radii, pane.expected, `${label} slot ${pane.slot}: round outside corners only`);
  }
  return snapshot;
}
try {
  await fs.mkdir(out, { recursive: true });
  const contentFile = path.join(root, 'test/fixtures/center-split-production-content.tsx').replaceAll('\\', '/');
  const compiled = await build({ absWorkingDir: root, entryPoints: ['test/fixtures/center-split-production.tsx'],
    outfile: path.join(out, 'fixture.js'), bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.webp': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
    plugins: [viteFixtureAssets, { name: 'content-leaves', setup(builder) {
      builder.onResolve({ filter: /\/(TerminalView|AgentChatView|PromptTaskPanel|ExtensionPanel)$/ }, args =>
        ({ path: args.path.split('/').at(-1), namespace: 'toolbar-leaf' }));
      builder.onLoad({ filter: /.*/, namespace: 'toolbar-leaf' }, args =>
        ({ contents: `export { ${args.path} } from ${JSON.stringify(contentFile)};`, loader: 'js', resolveDir: root }));
    } }] });
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/src/styles.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      if (pathname === '/fixture.js' || pathname === '/fixture.css') { const file = compiled.outputFiles.find(item => path.basename(item.path) === pathname.slice(1)); if (!file) { response.writeHead(404).end(); return; } response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(file.contents); return; }
      const file = path.resolve(root, '.' + decodeURIComponent(pathname));
      if (path.relative(root, file).startsWith('..') || path.isAbsolute(path.relative(root, file))) { response.statusCode = 403; response.end(); return; }
      response.setHeader('Content-Type', { '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }[path.extname(file)] ?? 'application/octet-stream');
      response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || undefined });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1320, height: 720 } });
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}&toolbar=1`);
    await page.locator('[data-session="a"]').waitFor(); await page.evaluate(() => window.__lruRetouch());
    await page.evaluate(() => document.fonts.ready); await frame(page);
    const toolbar = page.getByRole('toolbar', { name: '会话顶栏与交互优化' });
    const handle = page.getByTestId('center-pane-handle-0');
    const before = await page.locator('[data-session="a"]').boundingBox();
    const singleGeometry = await chromeGeometry(page, 'single');
    await page.mouse.move(2, 2);
    const css = await toolbar.evaluate(element => {
      const style = getComputedStyle(element), handleStyle = getComputedStyle(element.querySelector('.center-split-handle'));
      return { background: style.backgroundColor, filter: style.backdropFilter, opacity: style.opacity, handleOpacity: handleStyle.opacity,
        pointerEvents: handleStyle.pointerEvents, color: style.color, height: element.getBoundingClientRect().height };
    });
    assert.equal(css.filter, 'none'); assert.equal(css.opacity, '0'); assert.equal(css.pointerEvents, 'none');
    assert.ok(!css.background.includes('rgba'), 'Header must have opaque chrome');
    const headerBox = await toolbar.boundingBox();
    const conversation = await page.locator('[data-conversation="a"]').boundingBox();
    assert.ok(conversation.y < headerBox.y + 10, 'Hidden toolbar must not reserve content height');
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-hidden.png`) });
    // Real Tab reaches the retained hidden control and reveals it for keyboard users.
    await page.locator('#fixture-center').evaluate(element => { element.tabIndex = -1; element.focus(); });
    await page.keyboard.press('Tab');
    assert.equal(await handle.evaluate(element => element === document.activeElement), true);
    await waitToolbar(page, 0, true);
    await page.locator('[data-body-control="a"]').click(); await page.mouse.move(2, 2); await waitToolbar(page, 0, false);
    await reveal(page, 0);
    assert.deepEqual(await page.locator('[data-conversation="a"]').boundingBox(), conversation, 'Hover cannot move the body');
    assert.deepEqual(await page.locator('[data-session="a"]').boundingBox(), before, 'Hover cannot move content');
    await toolbar.screenshot({ path: path.join(out, `${theme}-wide.png`) });
    await page.mouse.move(2, 2); await waitToolbar(page, 0, false);
    await reveal(page, 0);
    // Menu remains usable outside the top hotzone and fades after it closes.
    await handle.click(); await page.mouse.move(2, 2);
    assert.equal(await toolbar.evaluate(element => getComputedStyle(element).opacity), '1');
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'detached' });
    await page.evaluate(() => document.activeElement?.blur()); await waitToolbar(page, 0, false);
    await reveal(page, 0);
    await page.getByRole('button', { name: '选择分屏布局', exact: true }).click();
    await page.getByTestId('center-snap-bar').waitFor(); await page.keyboard.press('Escape');
    await page.getByTestId('center-snap-bar').waitFor({ state: 'detached' });
    assert.equal(await handle.evaluate(element => element === document.activeElement), true);
    // Native hold + drag still uses the same capture element; Escape restores it.
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 20, hb.y + hb.height / 2 + 80, { steps: 4 });
    await page.getByTestId('center-pane-capture-shield').waitFor();
    assert.equal(await page.getByTestId('center-pane-0').getAttribute('data-floating'), 'true');
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await page.locator('[data-session="a"]').boundingBox(), before);
    await page.evaluate(() => window.__centerSplitTest.reset({ secondary: { kind: 'session', sessionId: 'b' } })); await frame(page);
    await reveal(page, 0);
    const splitGeometry = await chromeGeometry(page, 'halves');
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-split.png`) });
    await page.evaluate(() => window.__centerSplitTest.split.centerSplitSwap()); await frame(page);
    const swappedGeometry = await chromeGeometry(page, 'swapped');
    await page.evaluate(() => window.__centerSplitTest.split.centerSplitFlip()); await frame(page);
    await reveal(page, 0);
    const stackGeometry = await chromeGeometry(page, 'stack');
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-stack.png`) });
    await page.evaluate(() => window.__centerSplitTest.reset({ secondary: { kind: 'session', sessionId: 'b' } })); await frame(page);
    await reveal(page, 0);
    await toolbar.getByRole('button', { name: '选择分屏布局', exact: true }).click();
    await page.getByTestId('center-snap-cell-thirds-0').click(); await page.getByTestId('center-snap-bar').waitFor({ state: 'detached' }); await frame(page);
    await page.getByTestId('center-snap-fill-2-c').click(); await frame(page);
    await reveal(page, 0);
    const thirdsGeometry = await chromeGeometry(page, 'thirds');
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-thirds.png`) });
    const nodes = await Promise.all(['a', 'b', 'c'].map(id => page.locator(`[data-session="${id}"]`).elementHandle()));
    await page.getByRole('textbox', { name: '草稿 b' }).fill('三分屏真实鼠标调宽草稿');
    await resizeDivider(page, 0, .25);
    const thirdsRatios = await resizeDivider(page, 1, .7);
    assert.ok(Math.abs(thirdsRatios[0] - .25) < .002 && Math.abs(thirdsRatios[1] - .7) < .002);
    const cancelled = await resizeDivider(page, 0, .4, true); assert.deepEqual(cancelled, thirdsRatios, 'Escape restores both divider ratios');
    const thirdsResizedGeometry = await chromeGeometry(page, 'thirds-resized'); await reveal(page, 0);
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-thirds-resized.png`) });
    await page.getByTestId('center-split-divider-1').focus(); await page.keyboard.press('Home');
    assert.ok(Math.abs((await page.evaluate(() => window.__centerSplitTest.split.getCenterSplitState().ratios))[1] - .45) < .002);
    await reveal(page, 0);
    await handle.click(); await page.getByRole('menuitemcheckbox', { name: '选择分屏布局', exact: true }).click();
    await page.getByTestId('center-snap-cell-focus-0').click(); await page.getByTestId('center-snap-bar').waitFor({ state: 'detached' }); await frame(page);
    await reveal(page, 0);
    const focusGeometry = await chromeGeometry(page, 'focus');
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-focus.png`) });
    await resizeDivider(page, 0, .63);
    const focusRatios = await resizeDivider(page, 1, .35);
    assert.ok(Math.abs(focusRatios[0] - .63) < .002 && Math.abs(focusRatios[1] - .35) < .002, `Focus resize: ${JSON.stringify(focusRatios)}`);
    await chromeGeometry(page, 'focus-resized'); await reveal(page, 0);
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-focus-resized.png`) });
    await handle.click(); await page.getByRole('menuitemcheckbox', { name: '选择分屏布局', exact: true }).click();
    await page.getByTestId('center-snap-cell-focus-mirror-2').click(); await page.getByTestId('center-snap-bar').waitFor({ state: 'detached' });
    await resizeDivider(page, 0, .6); const mirrorRatios = await resizeDivider(page, 1, .4);
    assert.ok(Math.abs(mirrorRatios[0] - .6) < .002 && Math.abs(mirrorRatios[1] - .4) < .002);
    await chromeGeometry(page, 'mirror-resized'); await reveal(page, 0);
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-mirror-resized.png`) });
    assert.equal(await page.getByRole('textbox', { name: '草稿 b' }).inputValue(), '三分屏真实鼠标调宽草稿');
    for (let index = 0; index < nodes.length; index++) assert.equal(await nodes[index].evaluate((node, id) => node === document.querySelector(`[data-session="${id}"]`), ['a', 'b', 'c'][index]), true);
    await page.evaluate(() => window.__centerSplitTest.split.centerSplitSetFocused(1));
    // A long title must not displace actions in a 320px central container.
    await page.setViewportSize({ width: 638, height: 720 }); await frame(page);
    await reveal(page, 1);
    const narrow = page.getByRole('toolbar', { name: '视觉与交互方案复核' });
    const narrowBox = await narrow.boundingBox(); assert.equal(narrowBox.width, 320);
    const narrowGeometry = await chromeGeometry(page, 'narrow');
    for (const button of await narrow.getByRole('button').all()) {
      const rect = await button.boundingBox(); assert.ok(rect.x >= narrowBox.x && rect.x + rect.width <= narrowBox.x + narrowBox.width + .1);
    }
    await page.getByTestId('center-pane-switch-0').click();
    await reveal(page, 0);
    assert.equal(await page.getByRole('toolbar', { name: '会话顶栏与交互优化' }).isVisible(), true);
    await page.getByTestId('center-panel').screenshot({ path: path.join(out, `${theme}-narrow.png`) });
    assert.deepEqual(errors, []);
    report.cases.push({ theme, css, singleGeometry, splitGeometry, swappedGeometry, stackGeometry, thirdsGeometry, thirdsResizedGeometry,
      thirdsRatios, focusRatios, mirrorRatios, focusGeometry, narrowGeometry,
      narrowWidth: narrowBox.width, errors }); await page.close();
  }
  console.log('Passed hover toolbar: hidden by default, no reserved body height/reflow, real Tab and hover reveal, menu retention, centered grip/corners, real drag/cancel and narrow switching in both themes.');
} catch (error) { report.error = String(error?.stack ?? error); throw error; }
finally {
  await fs.mkdir(out, { recursive: true }); await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(report, null, 2));
  await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  disarm(); release();
}
