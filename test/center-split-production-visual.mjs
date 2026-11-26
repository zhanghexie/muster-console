/** Explicit real Chromium production split regression: node test/center-split-production-visual.mjs.
 * Production CenterPanel/StoreProvider/store, LeftPanel/NavigationTree sources and complete CSS.
 * IPC, terminal/chat content and ExtensionPanel are leaf substitutes, including a real sandbox iframe.
 * Electron/native terminal process and App's workspace preference persistence need separate E2E. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { viteFixtureAssets } from '../.agents/skills/ui-verification/scripts/vite-fixture-assets.mjs';
import { chromium } from 'playwright-core';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { acquireTestLease } from './helpers/lease.mjs';
import { armProcessDeadline } from './helpers/execute.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseLease = acquireTestLease(root);
const disarm = armProcessDeadline(Date.now() + 55_000, 'Production center split Chromium');
const output = path.join(root, '.tmp/ui-captures/center-split-production');
const report = { boundary: 'Current production shell/stores/producers/CSS; IPC and leaf terminal/chat/extension content substituted. Real native mouse, DataTransfer, iframe, geometry and pixels.', cases: [] };
let browser;
let server;
const panes = ['a', 'b'];
const box = async locator => {
  const value = await locator.boundingBox(); assert.ok(value, `Missing rendered box: ${locator}`); return value;
};
function equalBox(actual, expected, label) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < 0.2,
    `${label}.${key}: ${actual[key]} versus ${expected[key]}`);
}
function edgeEnergy(image, rect) {
  const left = Math.max(0, Math.floor(rect.x + 20)), top = Math.max(0, Math.floor(rect.y + 55));
  const right = Math.min(image.width, Math.floor(rect.x + rect.width - 20));
  const bottom = Math.min(image.height, Math.floor(rect.y + rect.height - 20));
  assert.ok(right - left > 1 && bottom - top > 1);
  const luminance = (x, y) => { const i = (y * image.width + x) * 4; return image.data[i] * .299 + image.data[i + 1] * .587 + image.data[i + 2] * .114; };
  let dx = 0, dy = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const value = luminance(x, y);
    if (x + 1 < right) dx += Math.abs(value - luminance(x + 1, y));
    if (y + 1 < bottom) dy += Math.abs(value - luminance(x, y + 1));
  }
  return (dx / ((right - left - 1) * (bottom - top)) + dy / ((right - left) * (bottom - top - 1))) / 2;
}
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function settledUtilityLayer(locator) {
  // Ordinary mp-panel enter uses transform. Wait for its real endpoint before
  // comparing final rectangles; pointer docking is deliberately measured live.
  await locator.evaluate(async element => {
    await new Promise(resolve => {
      const sample = () => {
        const style = getComputedStyle(element);
        const transformDone = style.transform === 'none' || new DOMMatrixReadOnly(style.transform).isIdentity;
        const moving = [...element.getAnimations(), ...element.parentElement.getAnimations()].some(animation => animation.playState === 'running' || animation.playState === 'pending');
        if (element.dataset.mpStage === 'in' && Number(style.opacity) > .999 && transformDone && !moving) resolve();
        else requestAnimationFrame(sample);
      };
      sample();
    });
  });
}
/** 把手条藏起时上移出格且不可命中：划过所在格顶触发带唤出，待滑入到位后取盒 */
async function revealHandleBox(page, slot, area) {
  const paneBox = await box(page.getByTestId(`center-pane-${slot}`));
  await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + 5);
  await page.waitForFunction(([slot, top]) => {
    const el = document.querySelector(`[data-testid="center-pane-handle-${slot}"]`);
    return !!el && el.getBoundingClientRect().y >= top - 1 && Number(getComputedStyle(el.closest('.center-split-pane-toolbar')).opacity) > .999;
  }, [slot, area.y]);
  return box(page.getByTestId(`center-pane-handle-${slot}`));
}

async function reset(page, options = {}) {
  await page.evaluate(options => window.__centerSplitTest.reset(options), options); await frames(page);
}
async function state(page) { return page.evaluate(() => window.__centerSplitTest.split.getCenterSplitState()); }
async function sidebarState(page) {
  return page.locator('.left-panel').evaluate(panel => {
    const session = name => [...panel.querySelectorAll('.session-item:not(.utility-feature-item)')]
      .find(element => element.querySelector('.session-name-text')?.textContent === name);
    const elements = {
      a: session('会话甲'), b: session('会话乙'), c: session('会话丙'),
      tasks: [...panel.querySelectorAll('.utility-feature-item')].find(element => element.querySelector('.session-name-text')?.textContent === '定时任务'),
      child: panel.querySelector('[role="treeitem"][data-node-id="child"]'),
      'child-b': panel.querySelector('[role="treeitem"][data-node-id="child-b"]')
    };
    return Object.fromEntries(Object.entries(elements).map(([id, element]) => {
      if (!element) return [id, null];
      const style = getComputedStyle(element);
      const focusBar = getComputedStyle(element, id.startsWith('child') ? '::before' : '::after');
      return [id, { opened: element.dataset.paneOpen === 'true', focused: element.dataset.paneFocused === 'true',
        openedClass: element.classList.contains('is-pane-open'), focusedClass: element.classList.contains('is-pane-focused'),
        current: element.getAttribute('aria-current'), pressed: element.getAttribute('aria-pressed'), selected: element.getAttribute('aria-selected'),
        background: style.backgroundColor, outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, outlineColor: style.outlineColor,
        focusBarWidth: focusBar.width, focusBarContent: focusBar.content, focusBarOpacity: focusBar.opacity }];
    }));
  });
}
async function assertSidebar(page, opened, focused) {
  await page.waitForFunction(() => [...document.querySelectorAll('.left-panel .session-item, .left-panel .ext-nav-row')].every(element => {
    const bar = getComputedStyle(element, element.classList.contains('ext-nav-row') ? '::before' : '::after');
    return Math.abs(Number(bar.opacity) - (element.classList.contains('is-pane-focused') ? 1 : 0)) < .001;
  }));
  const snapshot = await sidebarState(page);
  for (const [id, item] of Object.entries(snapshot)) {
    assert.ok(item, `Production LeftPanel is missing ${id}`);
    assert.equal(item.opened, opened.includes(id), `Sidebar ${id} opened state`);
    assert.equal(item.openedClass, opened.includes(id), `Sidebar ${id} opened styling`);
    assert.equal(item.focused, id === focused, `Sidebar ${id} actual pane focus`);
    assert.equal(item.focusedClass, id === focused, `Sidebar ${id} focused styling`);
    if (['a', 'b', 'c'].includes(id)) assert.equal(item.current, id === focused ? 'true' : null, `Sidebar ${id} aria-current`);
    else if (id === 'tasks') assert.equal(item.pressed, String(id === focused), 'Built-in utility aria-pressed follows pane focus');
    else assert.equal(item.selected, String(id === focused), `Navigation ${id} aria-selected follows pane focus`);
  }
  return snapshot;
}
async function menuAction(page, slot, label) {
  await revealHandleBox(page, slot, await box(page.getByTestId('center-panel')));
  await page.getByTestId(`center-pane-handle-${slot}`).focus();
  await page.getByTestId(`center-pane-handle-${slot}`).click();
  await page.getByRole('menuitemcheckbox', { name: label, exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  await frames(page);
}
async function switchPane(page, slot) {
  await revealHandleBox(page, (await state(page)).focused, await box(page.getByTestId('center-panel')));
  await page.getByTestId(`center-pane-switch-${slot}`).click();
}
async function nativeDrag(page, source, target, diagnostic, options = {}) {
  await page.evaluate(() => {
    window.__nativeSnapProtocol = [];
    const types = ['dragover', 'drop', 'dragend'];
    // Fixture tape is document capture: even its microtask can run before
    // React's root listener. Read the negotiated operation in document bubble.
    const record = event => window.__nativeSnapProtocol.push({ type: event.type, trusted: event.isTrusted,
      inCenter: !!event.target.closest?.('.center-panel'), prevented: event.defaultPrevented,
      effect: event.dataTransfer?.dropEffect });
    types.forEach(type => document.addEventListener(type, record));
    window.__removeNativeSnapProtocol = () => types.forEach(type => document.removeEventListener(type, record));
  });
  await page.getByTestId('center-snap-bar').waitFor({ state: 'detached' });
  await source.scrollIntoViewIfNeeded();
  const bounds = await box(source);
  const start = { x: bounds.x + Math.min(80, bounds.width / 2), y: bounds.y + bounds.height / 2 };
  Object.assign(diagnostic, { bounds, start,
    source: await source.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      const describe = node => node ? { tag: node.tagName, id: node.id, classes: node.getAttribute('class'),
        node: node.closest('[data-node-id]')?.getAttribute('data-node-id'), text: node.textContent?.slice(0, 120) } : null;
      const ancestors = [];
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') ancestors.push({ ...describe(node),
          overflowX: style.overflowX, overflowY: style.overflowY, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      }
      return { hit: describe(hit), hitsSource: !!hit && element.contains(hit), draggable: element.draggable,
        html: element.outerHTML.slice(0, 1400), viewport: { width: innerWidth, height: innerHeight }, ancestors };
    }, start) });
  try {
    assert.ok(diagnostic.source.hitsSource, 'Native source point must actually hit the requested production source; see manifest diagnostic.');
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 10, start.y + 2);
    await page.mouse.move(start.x + 11, start.y + 3);
    const surface = await box(page.getByTestId('center-panel'));
    await page.getByTestId('center-snap-peek').waitFor();
    const pickerNode = await page.getByTestId('center-snap-peek').elementHandle();
    assert.equal(await page.getByTestId('center-snap-bar').count(), 0, 'Native drag first exposes only the peek');
    if (options.peekScreenshot) {
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-testid="center-snap-peek"]')).opacity) > .999);
      await page.waitForFunction(() => !document.querySelector('.center-snap-bar-position').getAnimations().some(a => a.playState === 'running'));
      const peekBounds = await box(page.getByTestId('center-snap-peek'));
      assert.ok(Math.abs(peekBounds.y + peekBounds.height - surface.y - 18) < .3, 'The actual picker bottom exposes 18px above the clipped viewport');
      await page.screenshot({ path: options.peekScreenshot });
    }
    if (!options.quickEdge) {
      await page.mouse.move(surface.x + surface.width / 2, surface.y + 18, { steps: 12 });
      const bar = page.getByTestId('center-snap-bar'); await bar.waitFor(); await settledUtilityLayer(bar);
      assert.ok(await bar.evaluate((el, original) => el === original, pickerNode), 'Peek and expanded picker must be the same DOM node');
      assert.equal(await page.getByTestId('center-native-drop-shield').count(), 1, 'Native source immediately shields existing iframes');
      diagnostic.bar = await box(bar);
      diagnostic.layouts = await page.locator('.center-snap-layout').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { id: element.dataset.snapLayout, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }));
      assert.ok(Math.abs(diagnostic.bar.width - 560) < .2, 'Wide Snap picker must be enlarged to 560px');
      assert.ok(diagnostic.layouts.every(layout => Math.abs(layout.height - 72) < .2), 'Every enlarged preset must be 72px high');
      if (options.full) assert.equal(await page.locator('.center-snap-cell').evaluateAll(elements => elements.every(element => element.disabled)), true,
        'A fourth native source must disable every undersized Snap destination');
    }
    if (options.via) {
      await page.mouse.move(options.via.x, options.via.y, { steps: 10 });
      diagnostic.viaHit = await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.getAttribute('data-testid'), options.via);
      assert.equal(diagnostic.viaHit, 'center-native-drop-shield', 'Native drag crossing iframe must stay in parent receiver');
      const viaTarget = await page.getByTestId('center-panel').getAttribute('data-snap-target');
      assert.ok(viaTarget == null || viaTarget.startsWith('halves:'), 'Crossing body may preview only a valid edge quick split');
    }
    if (typeof target === 'string') {
      await page.mouse.move(surface.x + surface.width / 2, surface.y + 18);
      await page.getByTestId('center-snap-bar').waitFor(); await settledUtilityLayer(page.getByTestId('center-snap-bar'));
    }
    const targetBox = typeof target === 'string' ? await box(page.getByTestId(target)) : null;
    diagnostic.target = targetBox ? { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 } : target;
    await page.mouse.move(diagnostic.target.x, diagnostic.target.y, { steps: 14 });
    await page.mouse.move(diagnostic.target.x + 1, diagnostic.target.y + 1);
    diagnostic.target.x += 1; diagnostic.target.y += 1;
    diagnostic.targetHit = await page.evaluate(point => {
      const hit = document.elementFromPoint(point.x, point.y);
      return hit ? { tag: hit.tagName, id: hit.id, classes: hit.getAttribute('class'), testid: hit.getAttribute('data-testid') } : null;
    }, diagnostic.target);
    if (options.quickEdge) {
      assert.equal(await page.getByTestId('center-panel').getAttribute('data-snap-target'), options.quickEdge);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-testid="center-snap-preview"]')).opacity) > .999);
    }
    if (options.screenshot) await page.screenshot({ path: options.screenshot });
    await page.mouse.up(); await frames(page);
  } finally {
    diagnostic.tape = await page.evaluate(() => window.__centerSplitTest.tape);
    diagnostic.protocol = await page.evaluate(() => { window.__removeNativeSnapProtocol(); return window.__nativeSnapProtocol; });
    diagnostic.state = await state(page);
  }
}
async function geometry(page, ids = panes) {
  const result = {};
  for (const id of ids) {
    const root = page.locator(`[data-session="${id}"]`);
    result[id] = { pane: await box(root), conversation: await box(root.locator('.fixture-conversation')),
      composer: await box(root.locator('.fixture-composer')) };
  }
  return result;
}

// Wait only for React to publish the requested gesture state. Read geometry in
// that same DOM task; waiting for a CSS transition endpoint would hide the bug.
function utilityGestureSnapshot(phase = null) {
  const main = document.querySelector('[data-testid="center-panel"]');
  const pane = document.querySelector('[data-testid="center-pane-0"]');
  const handle = document.querySelector('[data-testid="center-pane-handle-0"]');
  if (phase === 'lift' && pane?.dataset.floating !== 'true') return false;
  if (phase === 'activate' && pane?.dataset.floating !== 'true') return false;
  if (phase === 'dock' && main?.dataset.snapTarget !== 'halves:0') return false;
  if (phase === 'cancel' && (pane?.dataset.floating === 'true' || main?.dataset.snapTarget)) return false;
  const describe = element => {
    if (!element) return null;
    const value = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { rect: { x: value.x, y: value.y, width: value.width, height: value.height },
      classes: element.className, attributes: Object.fromEntries([...element.attributes].map(attr => [attr.name, attr.value])),
      computed: { transform: style.transform, transformOrigin: style.transformOrigin, transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration, opacity: style.opacity, display: style.display, pointerEvents: style.pointerEvents, zIndex: style.zIndex },
      animations: element.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime,
        property: animation.transitionProperty, timing: animation.effect?.getComputedTiming() })) };
  };
  const trace = window.__utilityGestureTrace ?? [];
  const pointerId = trace.findLast(event => event.type === 'pointerdown')?.pointerId;
  return { phase, state: window.__centerSplitTest.split.getCenterSplitState(), primary: window.__centerSplitTest.primary(),
    side: main?.dataset.previewSide ?? null, source: describe(document.querySelector('[data-extension="fixture-frame"][data-view="pane"]')?.closest('.center-utility-layer')),
    remaining: describe(document.querySelector('[data-session="b"]')), pane: describe(pane), handle: describe(handle),
    target: main?.dataset.snapTarget ?? null,
    frost: describe(document.querySelector('[data-testid="center-snap-preview"]')),
    scrim: describe(document.querySelector('[data-testid="center-drag-scrim"]')),
    capture: { pointerId, handleOwnsCapture: pointerId != null && handle?.hasPointerCapture(pointerId) }, trace: [...trace] };
}

try {
  await fs.mkdir(output, { recursive: true });
  const contentFile = path.join(root, 'test/fixtures/center-split-production-content.tsx').replaceAll('\\', '/');
  const compiled = await build({
    absWorkingDir: root, entryPoints: [path.join(root, 'test/fixtures/center-split-production.tsx')],
    outfile: path.join(output, 'fixture.js'), bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.webp': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
    plugins: [viteFixtureAssets, { name: 'explicit-leaf-substitutes', setup(builder) {
      builder.onResolve({ filter: /\/(TerminalView|AgentChatView|PromptTaskPanel|ExtensionPanel|DomainExtensionPanel)$/ }, args =>
        ({ path: args.path.split('/').at(-1), namespace: 'split-test-leaf' }));
      builder.onLoad({ filter: /.*/, namespace: 'split-test-leaf' }, args =>
        ({ contents: `export { ${args.path} } from ${JSON.stringify(contentFile)};`, loader: 'js', resolveDir: root }));
    } }]
  });
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/src/styles.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      response.setHeader('Cache-Control', 'no-store');
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      if (pathname === '/fixture.js' || pathname === '/fixture.css') { const file = compiled.outputFiles.find(item => path.basename(item.path) === pathname.slice(1)); if (!file) { response.writeHead(404).end(); return; } response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(file.contents); return; }
      const file = path.resolve(root, '.' + decodeURIComponent(pathname));
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.statusCode = 403; response.end(); return; }
      response.setHeader('Content-Type', { '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }[path.extname(file)] ?? 'application/octet-stream');
      response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || undefined });

  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1160, height: 720 }, colorScheme: theme, deviceScaleFactor: 1 });
    page.setDefaultTimeout(4500);
    const result = { theme, errors: [] }; report.cases.push(result);
    page.on('pageerror', error => result.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.locator('[data-session="a"]').waitFor(); await frames(page);
    await page.evaluate(() => window.__lruRetouch());
    const main = page.getByTestId('center-panel');
    const session = id => page.locator(`[data-session="${id}"]`);
    const originalA = await session('a').elementHandle();
    // 种子会话计入 LRU（性能专项后只保活最近访问；初始注入会被启动期 retain 清池）
    await page.evaluate(() => window.__lruRetouch());
    const originalB = await session('b').elementHandle();
    const area = await box(main);
    const splitOptions = { primary: { kind: 'session', sessionId: 'a' }, secondary: { kind: 'session', sessionId: 'b' } };
    await reset(page, splitOptions);
    await page.mouse.move(2, 2);
    assert.equal(await page.getByTestId('center-pane-handle-0').evaluate(el => getComputedStyle(el.closest('.center-split-pane-toolbar')).opacity), '0', 'Toolbar must be hidden without hovering.');
    await page.screenshot({ path: path.join(output, `${theme}-hidden-toolbar.png`) });
    const hoverHandle = await revealHandleBox(page, 0, area);
    await page.mouse.move(hoverHandle.x + hoverHandle.width / 2, hoverHandle.y + hoverHandle.height / 2);
    await page.getByTestId('center-pane-handle-0').click(); await page.getByRole('menu').waitFor();
    await settledUtilityLayer(page.getByRole('menu'));
    await page.screenshot({ path: path.join(output, `${theme}-hover-menu.png`) });
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'detached' });
    const bodyButton = page.locator('[data-body-control="a"]'); const buttonBox = await box(bodyButton);
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-body-control]')?.getAttribute('data-body-control'),
      { x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 }), 'a', 'R3: transparent skeleton must pass content hits.');
    await bodyButton.click(); assert.equal(await page.evaluate(() => window.__centerSplitTest.clicked), 'a');
    await page.getByRole('textbox', { name: '草稿 a' }).fill('保留甲的真实输入');
    await page.getByRole('textbox', { name: '草稿 b' }).fill('保留乙的真实输入');
    await page.getByRole('textbox', { name: '草稿 a' }).click(); await frames(page); assert.equal((await state(page)).focused, 0);
    result.sidebar = { dual: await assertSidebar(page, ['a', 'b'], 'a') };
    await page.getByRole('textbox', { name: '草稿 b' }).click(); await frames(page); assert.equal((await state(page)).focused, 1);
    result.sidebar.dualRefocused = await assertSidebar(page, ['a', 'b'], 'b');
    const conversation = session('a').locator('.fixture-conversation');
    const scrollBox = await box(conversation); await page.mouse.move(scrollBox.x + 30, scrollBox.y + scrollBox.height / 2); await page.mouse.wheel(0, 160);
    await page.waitForFunction(() => document.querySelector('[data-conversation="a"]').scrollTop > 0);
    for (const slot of [1, 0]) {
      await reset(page, splitOptions); await menuAction(page, slot, '收起此侧');
      assert.equal((await state(page)).open, false); equalBox(await box(session(slot === 0 ? 'b' : 'a')), area, `R1 close ${slot}`);
      if (slot === 1) await page.screenshot({ path: path.join(output, `${theme}-close-full.png`) });
    }
    for (const slot of [0, 1]) {
      await reset(page, splitOptions); await menuAction(page, slot, '解散分屏（保留此侧）');
      equalBox(await box(session(slot === 0 ? 'a' : 'b')), area, `R1 dissolve ${slot}`);
    }
    await reset(page, splitOptions); await page.evaluate(() => window.__centerSplitTest.switchWorkspace()); await frames(page);
    equalBox(await box(session('a')), area, 'R1 caller workspace-close cleanup');
    assert.equal(await originalA.evaluate(el => el.isConnected && el === document.querySelector('[data-session="a"]')), true);
    assert.equal(await originalB.evaluate(el => el.isConnected && el === document.querySelector('[data-session="b"]')), true);

    // R4/R5: actual CSS hidden state, both kinds of focused content, and recovery.
    await reset(page, { secondary: { kind: 'utility', sel: 'tasks' }, ratio: .6 });
    for (const id of ['b', 'c']) assert.equal(await session(id).evaluate(el => getComputedStyle(el).visibility), 'hidden', `R4 hidden ${id}`);
    await page.setViewportSize({ width: 740, height: 720 });
    await page.getByTestId('center-pane-switch-0').waitFor(); await frames(page);
    let narrowArea = await box(main);
    const taskLayer = page.locator('.center-utility-layer').filter({ has: page.locator('[data-tasks-panel]') });
    await settledUtilityLayer(taskLayer);
    equalBox(await box(taskLayer), narrowArea, 'R5 focused utility fills narrow');
    await page.screenshot({ path: path.join(output, `${theme}-narrow-utility.png`) });
    // Real clicks, not force/action dispatch, guard the utility-vs-handle stack.
    await menuAction(page, 1, '转为上下分屏'); assert.equal((await state(page)).dir, 'col');
    await menuAction(page, 1, '转为左右分屏'); assert.equal((await state(page)).dir, 'row');
    await switchPane(page, 0); await frames(page);
    equalBox(await box(session('a')), narrowArea, 'R5 focused session fills narrow');
    await switchPane(page, 1); await page.getByRole('textbox', { name: '任务草稿' }).fill('窄屏工具仍可输入');
    await settledUtilityLayer(taskLayer);
    await page.setViewportSize({ width: 1160, height: 720 }); await frames(page);
    assert.ok(Math.abs((await box(taskLayer)).width - area.width * .4) < 1);
    assert.equal((await state(page)).ratio, .6);
    await reset(page, { secondary: { kind: 'session', sessionId: 'c' }, ratio: .65 });
    await page.setViewportSize({ width: 740, height: 720 }); await page.getByTestId('center-pane-switch-0').waitFor(); await frames(page);
    narrowArea = await box(main); equalBox(await box(session('c')), narrowArea, 'R5 chat content fills narrow');
    await page.setViewportSize({ width: 1160, height: 720 }); await frames(page);

    // The sidebar distinguishes every bound reference from the actual focused
    // pane, across sessions, built-ins and navigation. The extra fixture tree
    // outside LeftPanel is an independent source and has no split-state props.
    await reset(page, { secondary: { kind: 'utility', sel: 'tasks' } });
    await menuAction(page, 0, '选择分屏布局');
    await page.getByTestId('center-snap-cell-thirds-0').click();
    await page.getByTestId('center-snap-bar').waitFor({ state: 'detached' });
    await page.getByTestId('center-snap-fill-2-nav:child').click(); await frames(page);
    const sidebarFrame = page.frameLocator('iframe[title="分屏测试沙箱"]');
    await sidebarFrame.locator('body[data-ready="true"]').waitFor();
    await sidebarFrame.locator('#draft').click(); await frames(page);
    result.sidebar.mixedNavigation = await assertSidebar(page, ['a', 'tasks', 'child'], 'child');
    await page.getByRole('textbox', { name: '草稿 a' }).click(); await frames(page);
    result.sidebar.mixedSession = await assertSidebar(page, ['a', 'tasks', 'child'], 'a');
    await page.getByRole('textbox', { name: '任务草稿' }).click(); await frames(page);
    result.sidebar.mixedUtility = await assertSidebar(page, ['a', 'tasks', 'child'], 'tasks');
    const sidebarVisual = result.sidebar.mixedUtility;
    for (const id of ['a', 'tasks', 'child']) {
      assert.notEqual(sidebarVisual[id].background, 'rgba(0, 0, 0, 0)', `Opened ${id} has a visible background in ${theme}`);
      assert.notEqual(sidebarVisual[id].background, sidebarVisual.b.background, `Opened ${id} differs from closed session in ${theme}`);
    }
    // 焦点指示为行首 2px 竖条（::after，2026-09 重设计后弃用 outline），仅当前 pane 的行有
    assert.ok(sidebarVisual.tasks.focusBarContent !== 'none' && parseFloat(sidebarVisual.tasks.focusBarWidth) >= 2 && Number(sidebarVisual.tasks.focusBarOpacity) > .999,
      `Focused utility has the pane-focus bar in ${theme}`);
    assert.ok(Number(sidebarVisual.a.focusBarOpacity) < .001 && Number(sidebarVisual.child.focusBarOpacity) < .001,
      'Opened unfocused session/navigation has no focus bar');
    await page.screenshot({ path: path.join(output, `${theme}-sidebar-open-focused.png`) });
    await menuAction(page, 2, '收起此侧'); await frames(page);
    await assertSidebar(page, ['a', 'tasks'], 'a');
    await menuAction(page, 0, '收起此侧'); await frames(page);
    assert.equal((await state(page)).open, false);
    result.sidebar.singleUtility = await assertSidebar(page, ['tasks'], 'tasks');

    // Native production source handlers, protected dragover and compatible operations.
    await reset(page);
    result.native = { copy: {}, move: {}, iframe: {}, capacity: {}, edge: {} };
    const sourceB = page.locator('#fixture-sources .session-item').filter({ hasText: '会话乙' }).first();
    await nativeDrag(page, sourceB, 'center-snap-cell-halves-1', result.native.copy,
      { screenshot: path.join(output, `${theme}-native-snap-picker.png`), peekScreenshot: path.join(output, `${theme}-native-snap-peek.png`) });
    assert.equal((await state(page)).secondary.sessionId, 'b', 'R2 actual copy source must drop.');
    assert.equal((await state(page)).layoutId, 'halves', 'Native source commits the selected Snap preset.');
    const copyTape = result.native.copy.tape;
    assert.ok(copyTape.some(event => event.type === 'drop' && event.trusted && event.inCenter && event.allowed === 'copy'));
    assert.ok(copyTape.some(event => event.type === 'dragover' && event.inCenter && event.payload === ''), 'Real dragover payload is protected.');
    await reset(page);
    const navigationSource = page.locator('[data-native-navigation-source] [role="treeitem"][data-node-id="child"]');
    await nativeDrag(page, navigationSource, 'center-snap-cell-halves-1', result.native.move);
    assert.deepEqual((await state(page)).secondary, { kind: 'utility', sel: 'nav:child' }, 'R2 actual move source must drop.');
    const moveTape = result.native.move.tape;
    assert.ok(moveTape.some(event => event.type === 'drop' && event.trusted && event.inCenter && event.allowed === 'move'));
    const iframe = page.locator('iframe[title="分屏测试沙箱"]'); await iframe.waitFor();
    const frame = page.frameLocator('iframe[title="分屏测试沙箱"]'); await frame.locator('body[data-ready="true"]').waitFor();
    await frame.locator('#draft').fill('iframe节点不能重载');
    const iframeNode = await iframe.elementHandle();
    // Drag through an existing iframe to the central drop receiver: it must shield the child document.
    const sourceC = page.locator('#fixture-sources .session-item').filter({ hasText: '会话丙' }).first();
    const iframeBox = await box(iframe);
    await nativeDrag(page, sourceC, 'center-snap-cell-focus-2', result.native.iframe,
      { via: { x: iframeBox.x + iframeBox.width / 2, y: iframeBox.y + iframeBox.height / 2 } });
    assert.deepEqual((await state(page)).secondary, { kind: 'utility', sel: 'nav:child' }, 'Native Snap retains existing iframe content.');
    assert.deepEqual((await state(page)).tertiary, { kind: 'session', sessionId: 'c' }, 'Native drop after crossing iframe commits the selected third Snap cell.');
    assert.equal(await iframeNode.evaluate(el => el.isConnected && el === document.querySelector('iframe[title="分屏测试沙箱"]')), true);
    assert.equal(await frame.locator('#draft').inputValue(), 'iframe节点不能重载');
    const fullState = await state(page);
    await nativeDrag(page, sourceB, 'center-snap-cell-thirds-0', result.native.capacity, { full: true });
    assert.deepEqual(await state(page), fullState, 'Full three-pane layout must reject a fourth native source without losing content.');
    assert.ok(result.native.capacity.protocol.some(event => event.type === 'dragend' && event.trusted && event.effect === 'none'),
      'Chromium must report the disabled capacity destination as a rejected native drop.');
    assert.equal(result.native.capacity.protocol.some(event => event.type === 'drop' && event.trusted), false,
      'Disabled capacity destinations must not dispatch a trusted native drop.');
    await reset(page, { secondary: { kind: 'utility', sel: 'nav:child' } }); await iframe.waitFor();
    assert.equal(await iframeNode.evaluate(el => el.isConnected && el === document.querySelector('iframe[title="分屏测试沙箱"]')), true);
    assert.equal(await frame.locator('#draft').inputValue(), 'iframe节点不能重载');
    const handleBox = await revealHandleBox(page, 0, area);
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2); await page.mouse.down();
    await page.mouse.move(area.x + area.width - 10, area.y + area.height / 2, { steps: 10 });
    assert.equal(await main.getAttribute('data-preview-side'), 'right', 'Captured pointer crossing iframe must update docking.');
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.getByTestId('center-drag-scrim').waitFor({ state: 'detached' });
    assert.equal(await frame.locator('#draft').inputValue(), 'iframe节点不能重载');

    // Single-pane utility content fills the center. Its hover handle must align
    // with the content and native drag must still cross the embedded iframe.
    await reset(page, { primary: { kind: 'utility', sel: 'nav:child' } });
    const windowLayer = page.locator('.center-utility-layer.utility-placement-center')
      .filter({ has: page.locator('[data-extension="fixture-frame"][data-view="pane"]') });
    await settledUtilityLayer(windowLayer);
    const windowBox = await box(windowLayer);
    equalBox(windowBox, area, 'Single utility fills the center');
    equalBox(await box(page.getByTestId('center-pane-0')), windowBox, 'Single utility controls match content');
    const windowHandle = await revealHandleBox(page, 0, area);
    await page.mouse.move(windowHandle.x + windowHandle.width / 2, windowHandle.y + windowHandle.height / 2);
    await page.getByTestId('center-pane-handle-0').click(); await page.getByRole('menu').waitFor();
    await settledUtilityLayer(page.getByRole('menu'));
    await page.screenshot({ path: path.join(output, `${theme}-window-menu.png`) });
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'detached' });
    const windowTarget = { x: windowBox.x + windowBox.width - 12, y: windowBox.y + windowBox.height - 36 };
    assert.equal(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.tagName, windowTarget), 'IFRAME');
    result.native.window = {};
    await nativeDrag(page, sourceC, 'center-snap-cell-halves-1', result.native.window, { via: windowTarget });
    assert.equal((await state(page)).open, true);
    assert.deepEqual((await state(page)).secondary, { kind: 'session', sessionId: 'c' }, 'Existing central iframe must accept the real native drop');
    assert.equal(await iframeNode.evaluate(element => element.isConnected && element === document.querySelector('iframe[title="分屏测试沙箱"]')), true);
    await reset(page);
    await nativeDrag(page, sourceB, { x: area.x + area.width - 100, y: area.y + area.height / 2 }, result.native.edge,
      { quickEdge: 'halves:1', screenshot: path.join(output, `${theme}-native-quick-right.png`) });
    assert.equal((await state(page)).open, true, 'Sidebar card touching the right edge opens a quick split.');
    assert.equal((await state(page)).secondary.sessionId, 'b');
    assert.ok(result.native.edge.protocol.some(event => event.type === 'dragover' && event.trusted && event.inCenter && event.prevented && event.effect === 'copy'),
      'Edge quick split negotiates the same compatible native copy operation.');
    await reset(page); result.native.edgeLeft = {};
    await nativeDrag(page, sourceB, { x: area.x + 60, y: area.y + area.height / 2 }, result.native.edgeLeft,
      { quickEdge: 'halves:0', screenshot: path.join(output, `${theme}-native-quick-left.png`) });
    assert.equal((await state(page)).order[1], 0, 'Sidebar source lands on the left when its card touches the left edge.');

    // Utility mp-panel normally animates transform; the same real layer must
    // follow handle geometry immediately while splitting, including an iframe.
    await reset(page, { primary: { kind: 'utility', sel: 'nav:child' }, secondary: { kind: 'session', sessionId: 'b' }, ratio: .65 });
    const utilitySource = page.locator('.center-utility-layer').filter({ has: page.locator('[data-extension="fixture-frame"][data-view="pane"]') });
    await settledUtilityLayer(utilitySource);
    const originalUtilityBox = await box(utilitySource);
    const utilityHandle = await revealHandleBox(page, 0, area);
    const utilityStart = { x: utilityHandle.x + utilityHandle.width / 2, y: utilityHandle.y + utilityHandle.height / 2 };
    result.utilityGesture = { original: originalUtilityBox, start: utilityStart };
    await page.evaluate(() => {
      window.__utilityGestureTrace = [];
      const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture'];
      const record = event => {
        const target = event.target;
        window.__utilityGestureTrace.push({ type: event.type, trusted: event.isTrusted, pointerId: event.pointerId,
          buttons: event.buttons, x: event.clientX, y: event.clientY, target: { tag: target.tagName,
            classes: target.getAttribute?.('class'), testid: target.closest?.('[data-testid]')?.getAttribute('data-testid') } });
      };
      types.forEach(type => document.addEventListener(type, record, true));
      window.__removeUtilityGestureTrace = () => types.forEach(type => document.removeEventListener(type, record, true));
    });
    await frame.locator('body').evaluate(element => {
      const guest = element.ownerDocument.defaultView;
      guest.__utilityGuestTrace = [];
      const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture'];
      const record = event => guest.__utilityGuestTrace.push({ type: event.type, trusted: event.isTrusted,
        pointerId: event.pointerId, buttons: event.buttons, x: event.clientX, y: event.clientY,
        target: { tag: event.target.tagName, id: event.target.id } });
      types.forEach(type => element.ownerDocument.addEventListener(type, record, true));
      guest.__removeUtilityGuestTrace = () => types.forEach(type => element.ownerDocument.removeEventListener(type, record, true));
    });
    try {
      result.utilityGesture.startHit = await page.evaluate(point => {
        const hit = document.elementFromPoint(point.x, point.y);
        return { tag: hit?.tagName, classes: hit?.getAttribute('class'), handle: hit?.closest('[data-testid="center-pane-handle-0"]') != null };
      }, utilityStart);
      assert.ok(result.utilityGesture.startHit.handle, 'Utility gesture must start on the actual handle');
      // A first native packet can cross into an iframe before the 6px threshold.
      // The invisible capture shield must protect it from guest routing already
      // on pointerdown, without making the visual gesture begin prematurely.
      await page.mouse.move(utilityStart.x, utilityStart.y); await page.mouse.down();
      result.utilityGesture.directFirstPacket = { requested: { x: area.x + area.width * .55, y: area.y + 200 },
        down: await page.evaluate(utilityGestureSnapshot) };
      assert.equal(await page.getByTestId('center-pane-capture-shield').count(), 1, 'Accepted down protects iframe before movement');
      assert.equal(result.utilityGesture.directFirstPacket.down.pane.attributes['data-floating'], undefined);
      assert.equal(result.utilityGesture.directFirstPacket.down.scrim, null, 'Pointerdown alone must not start visual blur');
      await page.mouse.move(area.x + area.width * .55, area.y + 200);
      const directHandle = await page.waitForFunction(utilityGestureSnapshot, 'lift', { polling: 'raf' });
      const direct = await directHandle.jsonValue(); await directHandle.dispose();
      const guestDirect = await frame.locator('body').evaluate(element => element.ownerDocument.defaultView.__utilityGuestTrace);
      Object.assign(result.utilityGesture.directFirstPacket, { after: direct, guest: guestDirect,
        parentMoveDelivered: direct.trace.some(event => event.type === 'pointermove' && event.buttons === 1),
        guestMoveDelivered: guestDirect.some(event => event.type === 'pointermove' && event.buttons === 1) });
      assert.equal(result.utilityGesture.directFirstPacket.parentMoveDelivered, true, 'First cross-iframe move must reach captured parent handle');
      assert.equal(result.utilityGesture.directFirstPacket.guestMoveDelivered, false, 'Guest iframe must not steal first captured move');
      assert.ok(Math.abs(direct.source.rect.width - originalUtilityBox.width * .78) < .2, 'First cross-iframe published lift has immediate .78 scale');
      assert.ok(Math.abs(direct.source.rect.height - originalUtilityBox.height * .78) < .2);
      equalBox(direct.remaining.rect, area, 'First cross-iframe lift immediately expands counterpart');
      await page.keyboard.press('Escape'); await page.mouse.up();
      await page.getByTestId('center-drag-scrim').waitFor({ state: 'detached' });
      await page.evaluate(() => { window.__utilityGestureTrace.length = 0; });
      await frame.locator('body').evaluate(element => { element.ownerDocument.defaultView.__utilityGuestTrace.length = 0; });

      // The geometry regression starts with a genuine threshold packet still
      // inside the captured handle, then crosses the iframe without extra steps.
      await revealHandleBox(page, 0, area);
      await page.mouse.move(utilityStart.x, utilityStart.y); await page.mouse.down();
      result.utilityGesture.down = await page.evaluate(utilityGestureSnapshot);
      await page.mouse.move(utilityStart.x + 8, utilityStart.y + 4);
      const activationHandle = await page.waitForFunction(utilityGestureSnapshot, 'activate', { polling: 'raf' });
      result.utilityGesture.thresholdPacket = await activationHandle.jsonValue(); await activationHandle.dispose();
      // Stay below the enlarged Snap picker and its 18px retention buffer.
      await page.mouse.move(area.x + area.width * .55, area.y + 200);
      const liftHandle = await page.waitForFunction(utilityGestureSnapshot, 'lift', { polling: 'raf' });
      const instantLift = await liftHandle.jsonValue(); await liftHandle.dispose();
      result.utilityGesture.lifted = instantLift;
      assert.ok(Math.abs(instantLift.source.rect.width - originalUtilityBox.width * .78) < .2, 'Utility lift scale must apply in its first published state, without transform easing');
      assert.ok(Math.abs(instantLift.source.rect.height - originalUtilityBox.height * .78) < .2);
      equalBox(instantLift.remaining.rect, area, 'Utility lift immediately gives remaining session full surface');
      await page.mouse.move(area.x + 8, area.y + area.height / 2);
      const dockHandle = await page.waitForFunction(utilityGestureSnapshot, 'dock', { polling: 'raf' });
      const instantDock = await dockHandle.jsonValue(); await dockHandle.dispose();
      result.utilityGesture.docked = instantDock;
      assert.equal(instantDock.pane.attributes['data-floating'], 'true', 'Selected destination must retain the real floating source');
      assert.ok(Math.abs(instantDock.source.rect.width - originalUtilityBox.width * .78) < .2, 'Selected destination must not dock or ease the source before release');
      equalBox(instantDock.remaining.rect, area, 'Selecting a destination must keep lifted background geometry');
      equalBox(instantDock.frost.rect, { x: area.x, y: area.y, width: area.width / 2, height: area.height }, 'Single target frost follows normalized destination');
      assert.equal(instantDock.state.ratio, .65);
      await page.keyboard.press('Escape'); await page.mouse.up();
      const cancelHandle = await page.waitForFunction(utilityGestureSnapshot, 'cancel', { polling: 'raf' });
      const instantCancel = await cancelHandle.jsonValue(); await cancelHandle.dispose();
      result.utilityGesture.cancelled = instantCancel;
      equalBox(instantCancel.source.rect, originalUtilityBox, 'Utility cancel immediately restores original rectangle');
      assert.equal(await iframeNode.evaluate(element => element.isConnected && element === document.querySelector('iframe[title="分屏测试沙箱"]')), true);
      await page.getByTestId('center-drag-scrim').waitFor({ state: 'detached' });
    } finally {
      result.utilityGesture.final = await page.evaluate(utilityGestureSnapshot);
      result.utilityGesture.guestTrace = await frame.locator('body').evaluate(element => element.ownerDocument.defaultView.__utilityGuestTrace);
      await page.evaluate(() => window.__removeUtilityGestureTrace?.());
      await frame.locator('body').evaluate(element => element.ownerDocument.defaultView.__removeUtilityGuestTrace?.());
    }

    // Sandboxed child documents don't bubble focus/pointer events to main. Real
    // cross-frame focus must still route a subsequent list selection to its pane.
    const frameB = page.frameLocator('iframe[title="分屏测试沙箱乙"]');
    result.iframeFocus = [];
    for (const slot of [0, 1]) {
      await reset(page, { primary: { kind: 'utility', sel: 'nav:child' }, secondary: { kind: 'utility', sel: 'nav:child-b' } });
      await frame.locator('body[data-ready="true"]').waitFor(); await frameB.locator('body[data-ready="true"]').waitFor();
      await settledUtilityLayer(page.locator('.center-utility-layer').filter({ has: page.locator('[data-extension="fixture-frame"][data-view="pane"]') }));
      await settledUtilityLayer(page.locator('.center-utility-layer').filter({ has: page.locator('[data-extension="fixture-frame"][data-view="pane-b"]') }));
      await frame.locator('#draft').fill('左 iframe 焦点保活'); await frameB.locator('#draft').fill('右 iframe 焦点保活');
      const previous = slot === 0 ? frameB : frame, next = slot === 0 ? frame : frameB;
      await previous.locator('#draft').click(); await next.locator('#draft').click(); await frames(page);
      const focused = await state(page);
      result.iframeFocus.push({ slot, focused, activeFrame: await page.evaluate(() => document.activeElement?.getAttribute('title')) });
      assert.equal(focused.focused, slot, `R12 iframe ${slot} must own logical focus`);
      await sourceC.click(); await frames(page);
      if (slot === 0) {
        assert.deepEqual(await page.evaluate(() => window.__centerSplitTest.primary()), { kind: 'session', sessionId: 'c' });
        assert.deepEqual((await state(page)).secondary, { kind: 'utility', sel: 'nav:child-b' });
      } else {
        assert.deepEqual(await page.evaluate(() => window.__centerSplitTest.primary()), { kind: 'utility', sel: 'nav:child' });
        assert.deepEqual((await state(page)).secondary, { kind: 'session', sessionId: 'c' });
      }
      assert.equal(await previous.locator('#draft').inputValue(), slot === 0 ? '右 iframe 焦点保活' : '左 iframe 焦点保活');
    }

    // Real folder card callback and center-only behavior for either slot.
    for (const slot of [0, 1]) {
      await reset(page, slot === 0
        ? { primary: { kind: 'utility', sel: 'nav:folder' }, secondary: { kind: 'session', sessionId: 'b' } }
        : { secondary: { kind: 'utility', sel: 'nav:folder' } });
      await page.getByRole('button', { name: '沙箱面板', exact: true }).click(); await iframe.waitFor();
      const activeExtension = page.locator('[data-extension="fixture-frame"][data-active="true"]');
      assert.equal(await activeExtension.getAttribute('data-placement'), 'center', `R8/R9 slot ${slot} remains central`);
      await activeExtension.locator('button').click(); await frames(page);
      assert.equal((await state(page)).open, false); equalBox(await box(session(slot === 0 ? 'b' : 'a')), area, `R9 internal close ${slot}`);
    }

    // Windows Snap keeps the actual source floating above one destination frost.
    // Its lifted background remains fixed while different thumbnails are hovered.
    await reset(page, { ...splitOptions, dir: 'col', ratio: .65 });
    await page.getByRole('textbox', { name: '草稿 a' }).fill('甲的生产布局草稿'); await page.getByRole('textbox', { name: '草稿 b' }).fill('乙的生产布局草稿');
    const originalC = await session('c').elementHandle();
    const originalDrafts = await Promise.all(['a', 'b', 'c'].map(id => page.getByRole('textbox', { name: `草稿 ${id}`, includeHidden: true }).elementHandle()));
    const bHandle = await revealHandleBox(page, 1, area);
    await page.mouse.move(bHandle.x + bHandle.width / 2, bHandle.y + bHandle.height / 2); await page.mouse.down();
    await page.mouse.move(area.x + area.width / 2, area.y + 100, { steps: 8 });
    await page.waitForFunction(() => document.querySelector('[data-testid="center-pane-1"]')?.dataset.floating === 'true');
    assert.equal(await page.getByTestId('center-snap-preview').count(), 0, 'Centre lift has no whole-surface Gaussian');
    await page.screenshot({ path: path.join(output, `${theme}-floating-source.png`) });
    equalBox(await box(session('a')), area, 'Remaining actual pane fills during lift');
    await page.mouse.move(area.x + area.width / 2, area.y + 18, { steps: 6 });
    const bar = page.getByTestId('center-snap-bar'); await bar.waitFor(); await settledUtilityLayer(bar);
    assert.equal(await main.getAttribute('data-preview-side'), null, 'Top band opens presets without top-half docking');
    assert.equal(await main.getAttribute('data-snap-target'), null);
    const selectedCell = await box(page.getByTestId('center-snap-cell-focus-2'));
    await page.mouse.move(selectedCell.x + selectedCell.width / 2, selectedCell.y + selectedCell.height / 2);
    await page.waitForFunction(() => document.querySelector('[data-testid="center-panel"]')?.dataset.snapTarget === 'focus:2');
    assert.equal(await page.getByTestId('center-pane-1').getAttribute('data-floating'), 'true');
    assert.ok(Math.abs((await box(session('b'))).width - area.width * .32) < .2, 'Bar miniature keeps original full-width source dimensions at .32');
    equalBox(await box(session('a')), area, 'Target selection retains full lifted background');
    const target = await box(page.getByTestId('center-snap-preview'));
    equalBox(target, { x: area.x + area.width / 2, y: area.y + area.height / 2, width: area.width / 2, height: area.height / 2 }, 'Selected thumbnail maps to actual full-surface target');
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="center-snap-preview"]');
      return element?.dataset.mpStage === 'in' && Number(getComputedStyle(element).opacity) > .999;
    });
    const previewGeometry = await geometry(page);
    const previewPng = PNG.sync.read(await page.screenshot({ path: path.join(output, `${theme}-dock-preview.png`) }));
    // Compare pixels against the SAME frozen background. Committing replaces the
    // text underneath with the source, so preview/committed is not a valid blur
    // control. Leave opacity/material unchanged and toggle only the filter.
    const priorFilter = await page.getByTestId('center-snap-preview').evaluate(element => {
      const before = { backdropFilter: element.style.backdropFilter, webkit: element.style.getPropertyValue('-webkit-backdrop-filter') };
      element.style.backdropFilter = 'none'; element.style.setProperty('-webkit-backdrop-filter', 'none'); return before;
    });
    let sharpPng;
    try {
      sharpPng = PNG.sync.read(await page.screenshot({ path: path.join(output, `${theme}-snap-filter-control.png`) }));
      equalBox(await box(session('a')), previewGeometry.a.pane, 'Pixel control retains the same background rectangle');
      equalBox(await box(session('b')), previewGeometry.b.pane, 'Pixel control retains the same floating source rectangle');
    } finally {
      await page.getByTestId('center-snap-preview').evaluate((element, before) => {
        element.style.backdropFilter = before.backdropFilter; element.style.setProperty('-webkit-backdrop-filter', before.webkit);
      }, priorFilter);
    }
    const previewEdges = edgeEnergy(previewPng, target), sharpEdges = edgeEnergy(sharpPng, target);
    assert.ok(sharpEdges > .05, 'Fixed sharp control must contain actual remaining-pane text');
    const ratio = previewEdges / sharpEdges;
    assert.ok(ratio < .45, `${theme}: actual Gaussian missing despite computed style, fixed-background pixel ratio=${ratio}`);
    result.pixels = { target, previewEdges, sharpEdges, ratio, control: 'Only backdrop filters disabled; same active target/background/source/material' };
    assert.equal(await page.locator('[data-testid^="center-preview-blur-"], [data-testid="center-preview-divider"]').count(), 0, 'Old dual-blur pane previews must be absent');
    await page.mouse.up(); await page.getByTestId('center-drag-scrim').waitFor({ state: 'detached' }); await frames(page);
    const committedGeometry = await geometry(page);
    equalBox(committedGeometry.b.pane, target, 'Released source occupies its exact selected frost target');
    assert.deepEqual(await page.evaluate(() => window.__centerSplitTest.primary()), { kind: 'session', sessionId: 'a' });
    assert.deepEqual((await state(page)).secondary, { kind: 'session', sessionId: 'b' });
    assert.deepEqual((await state(page)).tertiary, { kind: 'empty' });
    await page.screenshot({ path: path.join(output, `${theme}-dock-committed.png`) });
    result.previewGeometry = previewGeometry; result.committedGeometry = committedGeometry;
    assert.equal(await page.getByTestId('center-snap-fill-2-a').count(), 0); assert.equal(await page.getByTestId('center-snap-fill-2-b').count(), 0);
    await page.getByTestId('center-snap-fill-2-c').click(); await frames(page);
    await page.getByRole('textbox', { name: '草稿 c' }).fill('丙的三格布局草稿');
    result.sidebar.triple = await assertSidebar(page, ['a', 'b', 'c'], 'c');
    for (const id of ['b', 'a', 'c']) {
      await page.getByRole('textbox', { name: `草稿 ${id}` }).click(); await frames(page);
      await assertSidebar(page, ['a', 'b', 'c'], id);
    }
    const threeBefore = await state(page), cHandle = await revealHandleBox(page, 2, area);
    assert.deepEqual(threeBefore.tertiary, { kind: 'session', sessionId: 'c' });
    await page.mouse.move(cHandle.x + cHandle.width / 2, cHandle.y + cHandle.height / 2); await page.mouse.down();
    await page.mouse.move(area.x + area.width / 2, area.y + 160);
    await page.waitForFunction(() => document.querySelector('[data-testid="center-pane-2"]')?.dataset.floating === 'true');
    const remainingBefore = { a: await box(session('a')), b: await box(session('b')) };
    await page.mouse.move(area.x + area.width / 2, area.y + 18); await settledUtilityLayer(bar);
    for (const layout of ['halves', 'stack']) for (const index of [0, 1]) assert.equal(await page.getByTestId(`center-snap-cell-${layout}-${index}`).isDisabled(), true, 'Three refs cannot fit a two-cell preset');
    const thumbnailRefs = await page.locator('[data-snap-layout="thirds"] [data-center-snap-layout]').evaluateAll(elements => elements.map(element => element.dataset.snapRefId).sort());
    assert.deepEqual(thumbnailRefs, ['a', 'b', 'c'], 'Preset thumbnails show all retained real refs');
    const thirdsCell = await box(page.getByTestId('center-snap-cell-thirds-0'));
    await page.mouse.move(thirdsCell.x + thirdsCell.width / 2, thirdsCell.y + thirdsCell.height / 2);
    await page.waitForFunction(() => document.querySelector('[data-testid="center-panel"]')?.dataset.snapTarget === 'thirds:0');
    const thirdTarget = await box(page.getByTestId('center-snap-preview'));
    equalBox(await box(session('a')), remainingBefore.a, 'Selecting third cell keeps A background fixed');
    equalBox(await box(session('b')), remainingBefore.b, 'Selecting third cell keeps B background fixed');
    const transient = await state(page); assert.equal(transient.layoutId, threeBefore.layoutId); assert.deepEqual(transient.order, threeBefore.order);
    await page.mouse.up(); await page.getByTestId('center-drag-scrim').waitFor({ state: 'detached' }); await frames(page);
    equalBox(await box(session('c')), thirdTarget, 'Third source commits its exact target');
    assert.deepEqual((await state(page)).secondary, { kind: 'session', sessionId: 'b' }); assert.deepEqual((await state(page)).tertiary, { kind: 'session', sessionId: 'c' });
    const fixedNodes = [originalA, originalB, originalC];
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      assert.equal(await fixedNodes[index].evaluate((element, id) => element.isConnected && element === document.querySelector(`[data-session="${id}"]`), id), true);
      assert.equal(await originalDrafts[index].evaluate((element, id) => element.isConnected && element === document.querySelector(`[aria-label="草稿 ${id}"]`), id), true);
    }
    result.threeGeometry = await geometry(page, ['a', 'b', 'c']);
    await page.screenshot({ path: path.join(output, `${theme}-three-slot-snap.png`) });
    await page.setViewportSize({ width: 640, height: 720 }); await page.getByTestId('center-pane-switch-2').waitFor(); await frames(page);
    equalBox(await box(session('c')), await box(main), 'Narrow third focused ref fills surface');
    await page.screenshot({ path: path.join(output, `${theme}-narrow-three-slot.png`) });
    await switchPane(page, 0); await frames(page); equalBox(await box(session('a')), await box(main), 'Narrow first ref switches full surface');
    await menuAction(page, 0, '选择分屏布局');
    await bar.waitFor(); await settledUtilityLayer(bar);
    const compactArea = await box(main), compactBar = await box(bar);
    result.narrowPicker = { area: compactArea, bar: compactBar,
      columns: await bar.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length) };
    assert.equal(result.narrowPicker.columns, 3, 'Central surfaces under 440px retain three columns for the enlarged Snap picker');
    assert.ok(compactBar.x >= compactArea.x && compactBar.x + compactBar.width <= compactArea.x + compactArea.width,
      'Enlarged narrow Snap picker must stay inside the central surface');
    assert.ok(Math.abs(compactBar.width - (compactArea.width - 20)) < .2, 'Narrow enlarged picker follows available central width');
    await page.screenshot({ path: path.join(output, `${theme}-narrow-snap-picker.png`) });
    await page.keyboard.press('Escape'); await bar.waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 1160, height: 720 }); await frames(page);
    for (const id of ['a', 'b', 'c']) equalBox(await box(session(id)), result.threeGeometry[id].pane, 'Restored three-slot content geometry');
    await menuAction(page, 2, '收起此侧'); await menuAction(page, 1, '收起此侧'); equalBox(await box(session('a')), area, 'Closing third then second restores full-size first');
    assert.equal(await page.getByRole('textbox', { name: '草稿 a' }).inputValue(), '甲的生产布局草稿');
    assert.equal(await page.getByRole('textbox', { name: '草稿 b', includeHidden: true }).inputValue(), '乙的生产布局草稿');
    assert.equal(await page.getByRole('textbox', { name: '草稿 c', includeHidden: true }).inputValue(), '丙的三格布局草稿');
    assert.deepEqual(result.errors, [], `${theme}: production fixture browser errors`);
    await page.close();
  }
  console.log('Passed production central split: sidebar opened/focused sessions, utilities and navigation in both themes; close/narrow, unified native copy/move Snap picker and iframe capture, enlarged 560px/72px presets with narrow three-column fit, capacity-safe drops, Windows Snap thumbnails/three retained refs, fixed DOM/drafts, exact released target geometry and same-background actual blur pixels.');
} catch (error) { report.error = String(error?.stack ?? error); throw error; }
finally {
  try { await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2)); }
  finally { try { await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve)); }
    finally { disarm(); releaseLease(); } }
}
