/** Native Electron + production CenterPanel/stores/CSS. IPC and content leaves are
 * fixture substitutes; no real workspace or application profile is opened.
 * Ignore unrelated desktop mouse input; Playwright still sends trusted CDP input. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { viteFixtureAssets } from '../.agents/skills/ui-verification/scripts/vite-fixture-assets.mjs';
import { _electron } from 'playwright-core';
import { acquireTestLease } from './helpers/lease.mjs';
import { armProcessDeadline } from './helpers/execute.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = acquireTestLease(root);
const disarm = armProcessDeadline(Date.now() + 150_000, 'Native pane fullscreen');
const output = path.join(root, '.tmp/ui-captures/center-pane-fullscreen');
let app, server;
const evidence = { platform: process.platform, cases: [] };
try {
  await fs.mkdir(output, { recursive: true });
  const contentFile = path.join(root, 'test/fixtures/center-split-production-content.tsx').replaceAll('\\', '/');
  const compiled = await build({ absWorkingDir: root, entryPoints: ['test/fixtures/center-split-production.tsx'],
    outfile: path.join(output, 'fixture.js'), bundle: true, write: false, format: 'esm', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.webp': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
    plugins: [viteFixtureAssets, { name: 'fixture-build', setup(builder) {
      builder.onResolve({ filter: /\/(TerminalView|AgentChatView|PromptTaskPanel|ExtensionPanel|DomainExtensionPanel)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'leaf' }));
      builder.onLoad({ filter: /.*/, namespace: 'leaf' }, args => ({ contents: `export { ${args.path} } from ${JSON.stringify(contentFile)};`, loader: 'js', resolveDir: root }));
    } }]
  });
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/renderer/src/styles.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); return; }
      if (pathname === '/fixture.js' || pathname === '/fixture.css') {
        response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(compiled.outputFiles.find(item => path.basename(item.path) === pathname.slice(1))?.contents ?? ''); return;
      }
      const file = path.resolve(root, '.' + decodeURIComponent(pathname)), relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', { '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream'); response.end(await fs.readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log('Fixture server ready');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const entry = path.join(output, 'electron.cjs');
  await fs.writeFile(entry, `const {app,BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(output, 'electron-profile'))});
app.whenReady().then(()=>{const win=new BrowserWindow({width:1200,height:850,titleBarStyle:'hidden',webPreferences:{sandbox:true}});win.setIgnoreMouseEvents(true);
win.fixtureHtmlFullscreen=false;
win.on('enter-html-full-screen',()=>{ win.fixtureHtmlFullscreen=true; });
win.on('leave-html-full-screen',()=>{ win.fixtureHtmlFullscreen=false; });
win.loadURL('${baseUrl}/?fullscreen');});
app.on('window-all-closed',()=>app.quit());`);
  app = await _electron.launch({ args: [entry], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  console.log('Electron launched');
  const page = await app.firstWindow();
  console.log('Window ready');
  page.setDefaultTimeout(12_000);
  const errors = []; page.on('pageerror', error => { errors.push(String(error)); console.error('Renderer:', String(error)); });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const fullscreenState = () => app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { html: window.fixtureHtmlFullscreen, native: window.isFullScreen(), focused: window.isFocused() };
  });
  await page.locator('[data-session="a"]').waitFor();
  const nativeWindowVerified = process.platform !== 'darwin' || (await fullscreenState()).focused;
  evidence.nativeWindowVerified = nativeWindowVerified;
  if (!nativeWindowVerified) console.log('macOS window is unfocused. Checking actual Electron HTML fullscreen, layout, and exit; native Space transition is unavailable.');
  const waitFullscreen = async value => {
    await page.waitForFunction(value => !!document.fullscreenElement === value, value);
    const deadline = Date.now() + 8000;
    let state = await fullscreenState();
    while ((state.html !== value || (nativeWindowVerified && state.native !== value)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      state = await fullscreenState();
    }
    assert.equal(state.html, value);
    if (nativeWindowVerified) assert.equal(state.native, value);
    await frames();
  };
  const menu = async (slot, label) => {
    const pane = page.getByTestId(`center-pane-${slot}`), rect = await pane.boundingBox(); assert.ok(rect);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 4);
    const handle = page.getByTestId(`center-pane-handle-${slot}`);
    await page.waitForFunction(slot => Number(getComputedStyle(document.querySelector(`[data-testid="center-pane-${slot}"] [role="toolbar"]`)).opacity) === 1, slot);
    await handle.click();
    await page.getByRole('menuitemcheckbox', { name: label, exact: true }).click();
    await page.getByRole('menu').waitFor({ state: 'detached' });
  };
  const reset = async options => { await page.evaluate(options => { window.__centerSplitTest.reset(options); window.__lruRetouch(); }, options); await frames(); };
  for (const theme of ['dark', 'light']) {
    await page.goto(`${baseUrl}/?fullscreen&theme=${theme}`);
    await page.locator('[data-session="a"]').waitFor();
    await page.evaluate(() => {
      window.__toolbarEvents = [];
      for (const type of ['pointerover', 'pointerout', 'pointermove', 'focusin', 'focusout']) document.addEventListener(type, event => {
        window.__toolbarEvents.push({ type, target: event.target?.className, related: event.relatedTarget?.className,
          x: event.clientX, y: event.clientY });
        if (window.__toolbarEvents.length > 24) window.__toolbarEvents.shift();
      }, true);
    });
    for (const kind of ['session', 'extension']) {
      console.log(`Checking ${theme} ${kind}`);
      await reset({ secondary: kind === 'session' ? { kind: 'session', sessionId: 'b' } : { kind: 'utility', sel: 'nav:child' }, ratio: .61 });
      const draft = kind === 'session' ? page.getByRole('textbox', { name: '草稿 b' }) : page.frameLocator('iframe[title="分屏测试沙箱"]').getByRole('textbox');
      await draft.fill('全屏往返保留草稿');
      const node = await (kind === 'session' ? page.locator('[data-session="b"]') : page.locator('iframe[title="分屏测试沙箱"]')).elementHandle();
      const originalParent = await node.evaluateHandle(element => element.parentElement);
      const before = await page.evaluate(() => window.__centerSplitTest.split.getCenterSplitState());
      await menu(1, '全屏显示'); await waitFullscreen(true);
      const toolbar = page.getByTestId('center-pane-1').getByRole('toolbar');
      // Do not enter/leave the relocated toolbar to repair stale hover state.
      await page.waitForFunction(() => {
        const bar = document.querySelector('[data-testid="center-pane-1"] [role="toolbar"]');
        return bar.dataset.mpStage === 'out' && Number(getComputedStyle(bar).opacity) === 0;
      });
      await page.waitForFunction(() => document.querySelector('.center-panel').clientWidth === innerWidth && document.querySelector('.center-panel').clientHeight === innerHeight);
      const rect = await page.getByTestId('center-panel').boundingBox();
      assert.equal(rect.x, 0); assert.equal(rect.y, 0);
      assert.equal(await draft.inputValue(), '全屏往返保留草稿');
      assert.equal(await node.evaluate((element, parent) => element.parentElement === parent, originalParent), true);
      assert.equal(await page.locator('.chrome-bar').isVisible(), false);
      await page.screenshot({ path: path.join(output, `${theme}-${kind}-fullscreen.png`) });
      const hoverX = await page.evaluate(() => innerWidth / 2);
      await page.mouse.move(hoverX, 4);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-testid="center-pane-1"] [role="toolbar"]')).opacity) === 1);
      await page.screenshot({ path: path.join(output, `${theme}-${kind}-toolbar-revealed.png`) });
      if (kind === 'extension') await draft.click();
      else await page.mouse.move(hoverX, 240);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-testid="center-pane-1"] [role="toolbar"]')).opacity) === 0);
      assert.equal(await toolbar.getAttribute('data-mp-stage'), 'out');
      // Body-portal menu remains operable inside document fullscreen.
      await menu(1, '退出全屏'); await waitFullscreen(false);
      assert.equal(await draft.inputValue(), '全屏往返保留草稿');
      const after = await page.evaluate(() => window.__centerSplitTest.split.getCenterSplitState());
      assert.deepEqual(after, { ...before, focused: 1 });
      await page.screenshot({ path: path.join(output, `${theme}-${kind}-restored.png`) });
      evidence.cases.push({ theme, kind, restored: true, nativeFullscreen: nativeWindowVerified, parentPreserved: true, toolbarAutoHidden: true, toolbarHoverReversible: true });
      if (kind === 'extension') {
        await menu(1, '全屏显示'); await waitFullscreen(true);
        await draft.press('Escape'); await waitFullscreen(false);
        assert.equal(await draft.inputValue(), '全屏往返保留草稿');
        evidence.cases.push({ theme, kind: 'iframe-escape', escaped: true });
      }
    }
  }
  await reset({ secondary: { kind: 'session', sessionId: 'b' }, ratio: .61 });
  const pane = await page.getByTestId('center-pane-1').boundingBox();
  await page.mouse.move(pane.x + pane.width / 2, pane.y + 4);
  const handle = page.getByTestId('center-pane-handle-1'); await handle.focus();
  const grab = await handle.boundingBox(), area = await page.getByTestId('center-panel').boundingBox();
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2); await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2, area.y + 2, { steps: 5 });
  await page.waitForFunction(() => document.querySelector('.center-panel').dataset.edgeAction === 'fullscreen');
  await page.mouse.up(); await waitFullscreen(true);
  await page.keyboard.press('Escape'); await waitFullscreen(false);
  assert.equal(await page.evaluate(() => window.__centerSplitTest.split.getCenterSplitState().open), true);
  evidence.cases.push({ kind: 'pointer-top-edge', nativeFullscreen: nativeWindowVerified, restoredSplit: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(650, 700));
  await reset({ primary: { kind: 'utility', sel: 'tasks' } });
  await menu(0, '全屏显示'); await waitFullscreen(true);
  await page.screenshot({ path: path.join(output, 'narrow-tool-fullscreen.png') });
  await page.keyboard.press('Escape'); await waitFullscreen(false);
  await page.screenshot({ path: path.join(output, 'narrow-tool-restored.png') });
  evidence.cases.push({ kind: 'narrow-tool', escape: true });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(evidence, null, 2));
  console.log(`ok: ${evidence.cases.length} fullscreen cases; ${output}`);
} catch (error) {
  const page = app?.windows()[0];
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error(await page.evaluate(() => ({ focus: document.activeElement?.outerHTML.slice(0, 250), events: window.__toolbarEvents,
      boxes: [...document.querySelectorAll('#root,.app-shell,.main-view,.ws-stage,.ws-pane-live,.work-area,.workspace-page,.terminal-page,.center-panel')].map(el => ({ class: el.className, width: el.clientWidth, height: el.clientHeight })) })).catch(String));
  }
  throw error;
} finally {
  await app?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  disarm(); release();
}
