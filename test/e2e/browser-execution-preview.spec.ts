/**
 * Native webview regression after removing the offscreen frame preview.
 * Human input uses the real host pointer/keyboard; agent tools use DOM actions.
 * Run: npm run test:e2e -- browser-execution-preview.spec.ts --retries=0
 */
import { test, expect, _electron, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);
const { PNG } = nodeRequire('playwright-core/lib/utilsBundle') as {
  PNG: { sync: { read(bytes: Buffer): { width: number; height: number; data: Buffer } } }
};
const workspaceId = 'browser-native-webview';
const themeId = process.env.BROWSER_TEST_THEME === 'light' ? 'light' : 'dark';
type Tool = <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
interface Reply { ok: boolean; result?: unknown; error?: unknown }
interface InputTrace { type: string; target: string; trusted: boolean; key?: string; x?: number; y?: number; buttons?: number }
interface FixtureState {
  ready: boolean; draft: string; next: string; focus: string; clicks: number;
  innerX: number; innerY: number; bodyY: number; width: number; height: number;
  drag: { x: number; y: number; down: boolean }; trace: InputTrace[]; ticks: number;
}
interface Recording {
  id: string; status: string; frameCount: number; error?: string;
  artifact?: { path: string; width: number; height: number; durationMs: number; frameCount: number };
}
interface ElementGeometry { x: number; y: number; width: number; height: number }
interface Download { tabId: string | null; filename: string; path: string; state: string }
const stateExpression = `({ready:!!window.__nativeReady,draft:document.getElementById('draft').value,
  next:document.getElementById('next').value,focus:document.activeElement.id,clicks:window.__clicks,
  innerX:document.getElementById('scroll').scrollLeft,innerY:document.getElementById('scroll').scrollTop,
  bodyY:window.scrollY,width:innerWidth,height:innerHeight,drag:window.__drag,trace:window.__trace,ticks:window.__ticks})`;

function fixtureHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Native browser fixture</title>
  <style>html,body{margin:0;background:rgb(238,244,250);font:16px system-ui}
  #swatch{position:fixed;left:8px;top:8px;width:32px;height:32px;background:rgb(221,40,92)}
  #draft,#next{position:absolute;left:60px;top:30px;width:220px;height:32px}#next{left:320px}
  #drag{position:absolute;left:60px;top:115px;width:90px;height:50px;background:#2866ad;color:#fff;touch-action:none;user-select:none}
  #native-click{position:absolute;left:200px;top:115px;width:140px;height:40px}
  #download{position:absolute;left:380px;top:120px}
  #scroll{position:absolute;left:60px;top:220px;width:300px;height:160px;overflow:auto;border:2px solid #2866ad;background:white}
  #inside{width:1600px;height:1800px;background:repeating-linear-gradient(#fff 0px,#fff 28px,#c5c9d3 29px,#fff 30px)}
  #file{position:absolute;left:60px;top:425px;width:320px;height:32px}
  #pulse{position:fixed;right:8px;top:8px;width:36px;height:36px;color:#fff;background:#185abd}
  </style></head><body><div id="swatch"></div><input id="draft" aria-label="First field"><input id="next" aria-label="Next field">
  <div id="drag">Drag here</div><button id="native-click">Native action</button><a id="download" href="/download" download>Download fixture</a>
  <div id="scroll"><div id="inside">Native wheel target</div></div><input id="file" type="file" aria-label="Upload fixture"><div id="pulse">0</div>
  <script>window.__nativeReady=true;window.__trace=[];window.__clicks=0;window.__drag={x:0,y:0,down:false};window.__ticks=0;
  for(const type of ['pointerdown','pointerup','pointermove','mousedown','mouseup','click','keydown','beforeinput','input'])document.addEventListener(type,event=>window.__trace.push({type,target:event.target.id,trusted:event.isTrusted,key:event.key,x:event.clientX,y:event.clientY,buttons:event.buttons}));
  document.getElementById('native-click').addEventListener('click',()=>window.__clicks++);
  const drag=document.getElementById('drag');
  drag.addEventListener('pointerdown',event=>{window.__drag.down=true;drag.setPointerCapture(event.pointerId)});
  drag.addEventListener('pointermove',event=>{if(window.__drag.down){window.__drag.x=event.clientX;window.__drag.y=event.clientY}});
  drag.addEventListener('pointerup',event=>{window.__drag={x:event.clientX,y:event.clientY,down:false}});
  setInterval(()=>{const pulse=document.getElementById('pulse');pulse.textContent=String(++window.__ticks);pulse.style.background=window.__ticks%2?'#185abd':'#d13e28'},100);
  </script></body></html>`;
}

async function stopApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (proc.exitCode === null && proc.pid) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already stopped */ }
    } else proc.kill('SIGKILL');
  }
}
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Native guest pixels fill their DOM box; no image letterboxing or input sink. */
async function hostPoint(view: Locator, point: { x: number; y: number }, size: { width: number; height: number }): Promise<{ x: number; y: number }> {
  const box = await view.boundingBox();
  expect(box, 'The production webview must be on screen').not.toBeNull();
  return { x: box!.x + point.x * box!.width / size.width, y: box!.y + point.y * box!.height / size.height };
}

test('native browser webview: human input, live overlays, viewport, download and recording', async ({}, info) => {
  test.setTimeout(150_000);
  const cwd = info.outputDir, workspace = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(path.join(workspace, '.muster'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.muster/workspace.json'), JSON.stringify({
    hVirtualScreen: true, hDock: 'git', sideToolsTab: 'browser', hGitRatio: .8, hTerminalRatio: .5
  }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId, activeWorkspaceId: workspaceId, defaultCwd: workspace,
    workspaces: [{ id: workspaceId, name: 'Native browser', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  let recordingFile = '';
  const serverRequests: Array<{ method: string; route: string; status: number; disposition: string | null }> = [];
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture').pathname;
    response.once('finish', () => serverRequests.push({ method: request.method ?? '', route,
      status: response.statusCode, disposition: String(response.getHeader('Content-Disposition') ?? '') || null }));
    if (route === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (route === '/download') {
      response.setHeader('Content-Type', 'text/plain');
      response.setHeader('Content-Disposition', 'attachment; filename="native-fixture.txt"');
      response.writeHead(200);
      response.end('native webview download fixture\n'); return;
    }
    if (route === '/recording.webm') {
      if (!recordingFile) { response.writeHead(404); response.end(); return; }
      const bytes = fs.readFileSync(recordingFile);
      response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': bytes.byteLength, 'Cache-Control': 'no-store' });
      response.end(bytes); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(route === '/player' ? '<!doctype html><html><head><title>Recording playback</title></head><body style="margin:0;background:#222"><video id="recording" autoplay muted loop playsinline controls src="/recording.webm" style="display:block;max-width:100vw;max-height:100vh"></video></body></html>' : fixtureHtml());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MUSTER_NO_SANDBOX: '1', MUSTER_PACKAGED_SMOKE: '1', MUSTER_PACKAGED_USER_DATA: userData,
    MUSTER_INSTANCE_ID: `browser-native-${process.pid}`, MUSTER_WEB_PORT: '0',
    APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata')
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_SANDBOX', 'MUSTER_SANDBOX_ROOT']) delete env[key];
  let app: ElectronApplication | undefined, win: Page | undefined, tool: Tool | undefined, recordingId = '';
  let observedGuestId: number | undefined;
  const errors: string[] = [], evidence: Record<string, unknown> = {
    themeId,
    keyboardScope: 'Native keyboard and Unicode commit automated; OS IME candidate-window interaction requires manual verification.'
  };
  try {
    app = await _electron.launch({ executablePath: nodeRequire('electron') as unknown as string,
      args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 60_000 });
    win = await app.firstWindow(); win.setDefaultTimeout(8000);
    win.on('pageerror', error => errors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 30_000 });
    const hostWindow = await app.browserWindow(win);
    await hostWindow.evaluate(window => window.setContentSize(1500, 920));
    await expect.poll(() => fs.existsSync(path.join(userData, 'shell-api.json'))).toBe(true);
    const toolUrl = (JSON.parse(fs.readFileSync(path.join(userData, 'shell-api.json'), 'utf8')) as { toolUrl: string }).toolUrl;
    const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
      // R2 起 browser 域收敛为 browser.run 信封；旧直调名在此透明转换（Shell API 支持按 action 展开真实目标）
      const payload = name.startsWith('browser.')
        ? { name: 'host.browser.run', arguments: { action: name.slice('browser.'.length), params: args } }
        : { name: name.startsWith('host.') ? name : `host.${name}`, arguments: args };
      const response = await fetch(toolUrl, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
      expect(response.ok, `${name} Shell API HTTP`).toBe(true); return await response.json() as Reply;
    };
    const callTool: Tool = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const reply = await call(name, args); expect(reply.ok, `${name}: ${JSON.stringify(reply)}`).toBe(true); return reply.result as T;
    };
    tool = callTool;
    const opened = await win.evaluate(async ({ url, workspaceId }) => window.api.browser.open({ url, workspaceId, sessionId: '' }),
      { url: `${baseUrl}/page`, workspaceId });
    await win.evaluate(async id => window.api.browser.activate({ id }), opened.id);
    const view = win.locator(`webview[data-tab-id="${opened.id}"]`);
    await expect(view).toBeVisible();
    const guestId = await view.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
    observedGuestId = guestId;
    const backend = async <T,>(id: number, expression: string): Promise<T> => app!.evaluate(async ({ webContents }, { id, expression }) => {
      const guest = webContents.fromId(id);
      if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') throw new Error(`Missing authoritative native guest ${id}`);
      return await guest.executeJavaScript(expression);
    }, { id, expression }) as Promise<T>;
    const readState = async (): Promise<FixtureState> => {
      const state = await backend<FixtureState>(guestId, stateExpression); evidence.latestGuestState = state; return state;
    };
    const geometry = async (selector: string): Promise<ElementGeometry> => backend(guestId,
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}})()`);
    const hostHit = async (point: { x: number; y: number }) => win!.evaluate(point => {
      const hit = document.elementFromPoint(point.x, point.y), page = document.querySelector('.browser-page');
      const describe = (element: Element | null) => element ? { tag: element.tagName, id: element.id,
        className: element.getAttribute('class'), tabId: element.getAttribute('data-tab-id'),
        pointerEvents: getComputedStyle(element).pointerEvents, visibility: getComputedStyle(element).visibility } : null;
      return { point, hit: describe(hit), active: describe(document.activeElement), page: describe(page),
        gesture: describe(page?.querySelector('.browser-gesture-layer') ?? null),
        hitTabId: hit?.closest('webview')?.getAttribute('data-tab-id') ?? null };
    }, point);
    const clickElement = async (selector: string): Promise<void> => {
      const diagnostic: Record<string, unknown> = { selector }; evidence.latestNativeClick = diagnostic;
      // The first physical click on a peek shield switches work surfaces. Only
      // after that user gesture and its transition may the target box be reused.
      if (!await view.evaluate(element => element.closest('.browser-page')?.classList.contains('is-active') ?? false)) {
        const target = await geometry(selector), point = await hostPoint(view, target, target);
        diagnostic.beforePeekClick = await hostHit(point); await win!.mouse.click(point.x, point.y);
        await expect(win!.locator('.browser-page')).toHaveClass(/is-active/);
      }
      await win!.locator('.h-strip, .ws-stage, .browser-page').evaluateAll(async elements => {
        await Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      });
      const target = await geometry(selector), point = await hostPoint(view, target, target);
      diagnostic.geometry = target; diagnostic.beforeClick = await hostHit(point);
      expect((diagnostic.beforeClick as { hitTabId: string | null }).hitTabId,
        `A native ${selector} click must hit its production webview`).toBe(opened.id);
      await win!.mouse.click(point.x, point.y); diagnostic.afterClick = await hostHit(point);
    };
    await expect.poll(async () => { try { return (await readState()).ready; } catch { return false; } }).toBe(true);
    const initial = await readState();

    await test.step('the live foreground is a native webview with actual pixels and no frame preview', async () => {
      await expect(win!.locator('[data-browser-execution], [data-browser-execution-frame]')).toHaveCount(0);
      const architecture = await app!.evaluate(({ BrowserWindow, webContents }, id) => ({
        type: webContents.fromId(id)?.getType(),
        independentBrowserWindow: BrowserWindow.getAllWindows().some(window => window.webContents.id === id)
      }), guestId);
      expect(architecture).toEqual({ type: 'webview', independentBrowserWindow: false });
      const readSwatch = async (): Promise<number[]> => {
        const size = await readState(), point = await hostPoint(view, { x: 24, y: 24 }, size);
        const shot = PNG.sync.read(await win!.screenshot());
        const viewport = await win!.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const x = Math.floor(point.x * shot.width / viewport.width), y = Math.floor(point.y * shot.height / viewport.height);
        const offset = (y * shot.width + x) * 4;
        return [...shot.data.subarray(offset, offset + 4)];
      };
      await expect.poll(readSwatch).toEqual([221, 40, 92, 255]);
      evidence.architecture = architecture;
      await win!.screenshot({ path: info.outputPath('native-webview.png') });
    });

    await test.step('human native input, editing, Unicode commit and Tab reach the guest directly', async () => {
      await clickElement('#draft'); await win!.keyboard.type('hello'); await win!.keyboard.press('Backspace');
      await win!.keyboard.insertText('你好🙂');
      await expect.poll(async () => (await readState()).draft).toBe('hell你好🙂');
      await win!.keyboard.press('Tab');
      await expect.poll(async () => (await readState()).focus).toBe('next');
      await win!.keyboard.type('second');
      await expect.poll(async () => (await readState()).next).toBe('second');
      const state = await readState();
      expect(state.trace.some(event => event.type === 'keydown' && event.key === 'Backspace' && event.trusted)).toBe(true);
      expect(state.trace.some(event => event.type === 'keydown' && event.key === 'Tab' && event.trusted)).toBe(true);
      expect(state.trace.filter(event => event.type === 'input').every(event => event.trusted)).toBe(true);
      evidence.humanKeyboard = state;
    });

    await test.step('human pointer drag and two-axis wheel keep real guest targeting', async () => {
      const source = await geometry('#drag'), target = { x: 390, y: 165 };
      const from = await hostPoint(view, source, source), to = await hostPoint(view, target, source);
      await win!.mouse.move(from.x, from.y); await win!.mouse.down();
      await win!.mouse.move(to.x, to.y, { steps: 8 }); await win!.mouse.up();
      await expect.poll(async () => (await readState()).drag.down).toBe(false);
      const drag = (await readState()).drag;
      expect(Math.abs(drag.x - target.x)).toBeLessThanOrEqual(2); expect(Math.abs(drag.y - target.y)).toBeLessThanOrEqual(2);
      const box = await geometry('#scroll'), point = await hostPoint(view, box, box);
      await win!.mouse.move(point.x, point.y); await win!.mouse.wheel(0, 260);
      await expect.poll(async () => (await readState()).innerY).toBeGreaterThan(0);
      await win!.mouse.wheel(170, 0);
      await expect.poll(async () => (await readState()).innerX).toBeGreaterThan(0);
      const state = await readState(); expect(state.bodyY).toBe(0);
      expect(state.trace.some(event => event.type === 'pointerdown' && event.target === 'drag' && event.trusted)).toBe(true);
      expect(state.trace.some(event => event.type === 'pointerup' && event.target === 'drag' && event.trusted)).toBe(true);
      evidence.humanPointer = state;
    });

    await test.step('a real settings overlay covers the live guest and prevents click-through', async () => {
      await clickElement('#native-click');
      const before = await readState(), target = await geometry('#native-click'), point = await hostPoint(view, target, target);
      await win!.getByRole('button', { name: '设置', exact: true }).click();
      const settings = win!.getByRole('dialog', { name: '设置', exact: true }); await expect(settings).toBeVisible();
      expect(await win!.evaluate(point => Boolean(document.elementFromPoint(point.x, point.y)?.closest('.settings-page')), point),
        'The tested native guest button must actually lie behind the production settings overlay').toBe(true);
      await win!.mouse.click(point.x, point.y);
      expect((await readState()).clicks).toBe(before.clicks);
      await expect.poll(async () => (await readState()).ticks).toBeGreaterThan(before.ticks);
      await win!.screenshot({ path: info.outputPath('native-webview-settings-overlay.png') });
      await settings.getByRole('button', { name: /返回工作台/ }).click();
      const discard = settings.getByRole('button', { name: '放弃并离开', exact: true });
      await expect.poll(async () => !(await settings.isVisible()) || await discard.isVisible()).toBe(true);
      if (await discard.isVisible()) await discard.click();
      await expect(settings).toHaveCount(0);
      await clickElement('#native-click');
      await expect.poll(async () => (await readState()).clicks).toBe(before.clicks + 1);
      expect(await view.evaluate(element => (element as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
      expect((await readState()).draft).toBe('hell你好🙂');
    });

    await test.step('viewport set and reset preserve the native guest and draft', async () => {
      const beforeViewport = await readState();
      await callTool('browser.setViewport', { tabId: opened.id, width: 640, height: 480 });
      await expect.poll(async () => { const state = await readState(); return [state.width, state.height]; }).toEqual([640, 480]);
      await callTool('browser.setViewport', { tabId: opened.id, reset: true });
      await expect.poll(async () => (await readState()).height).toBe(beforeViewport.height);
      const restoredViewport = await readState();
      expect(Math.abs(restoredViewport.width - beforeViewport.width)).toBeLessThanOrEqual(4);
      expect(restoredViewport.draft).toBe('hell你好🙂');
      expect(await view.evaluate(element => (element as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
    });

    await test.step('anonymous upload is rejected; human download still saves a real file', async () => {
      const address = win!.locator('.browser-addr'); await address.fill('upload unsupported focus draft'); await address.focus();
      const uploaded = await call('browser.upload', { tabId: opened.id, target: '#file', files: [] });
      expect(uploaded.ok).toBe(false); expect(JSON.stringify(uploaded.error)).toContain('authenticated');
      const chooserClick = await call('browser.click', { tabId: opened.id, target: '#file' });
      expect(chooserClick.ok).toBe(false); expect(JSON.stringify(chooserClick.error)).toContain('capability_unsupported');
      await expect(address).toBeFocused(); await expect(address).toHaveValue('upload unsupported focus draft');
      const beforeTrace = (await readState()).trace.length;
      await clickElement('#download');
      await expect.poll(async () => (await readState()).trace.slice(beforeTrace)
        .some(event => event.type === 'click' && event.target === 'download' && event.trusted),
      { message: 'The real host pointer must deliver a trusted download click to the guest' }).toBe(true);
      await expect.poll(() => serverRequests.some(request => request.route === '/download' && request.status === 200 &&
        request.disposition === 'attachment; filename="native-fixture.txt"'),
      { message: 'The native link must receive the fixture attachment response' }).toBe(true);
      const readDownloads = async (): Promise<Download[]> => {
        const items = (await callTool<{ items: Download[] }>('browser.downloads', {})).items;
        evidence.latestDownloads = items; return items;
      };
      await expect.poll(async () => (await readDownloads()).find(item => item.filename === 'native-fixture.txt')?.state).toBe('completed');
      const download = (await readDownloads()).find(item => item.filename === 'native-fixture.txt')!;
      expect(download.tabId).toBe(opened.id); expect(path.relative(userData, download.path).startsWith('..')).toBe(false);
      expect(fs.readFileSync(download.path, 'utf8')).toBe('native webview download fixture\n'); evidence.download = download;
    });

    await test.step('hidden recording rejects without stealing focus; a visible native guest records a playable WebM', async () => {
      const foreground = await win!.evaluate(async ({ url, workspaceId }) => window.api.browser.open({ url, workspaceId, sessionId: '' }),
        { url: `${baseUrl}/front`, workspaceId });
      const frontView = win!.locator(`webview[data-tab-id="${foreground.id}"]`);
      await expect(frontView).toBeVisible(); await expect(view).toBeHidden();
      await expect(view).toHaveAttribute('data-browser-presentation', 'background');
      const address = win!.locator('.browser-addr'); await address.click();
      const addressBefore = await address.inputValue();
      const focusBefore = await app!.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null);
      const hiddenShot = await call('browser.screenshot', { tabId: opened.id });
      expect(hiddenShot.ok, JSON.stringify(hiddenShot)).toBe(true);
      const hiddenShotResult = hiddenShot.result as { path?: string; previewPath?: string };
      expect(hiddenShotResult.path).toBeTruthy();
      const hiddenShotPng = PNG.sync.read(fs.readFileSync(hiddenShotResult.path!));
      expect(hiddenShotPng.width).toBeGreaterThan(0); expect(hiddenShotPng.height).toBeGreaterThan(0);
      expect((await callTool<{ activeId: string | null }>('browser.tabs', {})).activeId).toBe(foreground.id);
      await expect(address).toBeFocused(); await expect(address).toHaveValue(addressBefore);
      await expect(view).toBeHidden(); await expect(view).toHaveAttribute('data-browser-presentation', 'background');
      evidence.hiddenScreenshot = { path: hiddenShotResult.path, width: hiddenShotPng.width, height: hiddenShotPng.height };
      const hiddenStart = await call('browser.recording', { action: 'start', tabId: opened.id });
      evidence.hiddenRecording = { reply: hiddenStart, addressBefore, focusBefore };
      expect(hiddenStart.ok).toBe(false); expect(JSON.stringify(hiddenStart.error)).toContain('capability_unsupported');
      expect((await callTool<{ activeId: string | null }>('browser.tabs', {})).activeId).toBe(foreground.id);
      await expect(address).toBeFocused(); await expect(address).toHaveValue(addressBefore);
      expect(await app!.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null)).toBe(focusBefore);
      await expect(frontView).toBeVisible(); await expect(view).toBeHidden();

      // Both fixture routes intentionally share a title. The original page is
      // the sole inactive native fixture tab; use its stable text, not a title
      // attribute that the production tooltip temporarily removes.
      const originalTab = win!.locator('.right-tab:not([aria-selected="true"]) .right-tab-title')
        .filter({ hasText: /^Native browser fixture$/ });
      await expect(originalTab).toHaveCount(1); await originalTab.click();
      await expect(view).toBeVisible(); await expect(view).toHaveAttribute('data-browser-presentation', 'foreground');
      await expect.poll(() => backend<string>(guestId, 'document.visibilityState')).toBe('visible');
      expect((await callTool<{ activeId: string | null }>('browser.tabs', {})).activeId).toBe(opened.id);
      expect(await view.evaluate(element => (element as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
      expect((await readState()).draft).toBe('hell你好🙂');
      const started = await callTool<{ recording: Recording }>('browser.recording', { action: 'start', tabId: opened.id });
      recordingId = started.recording.id;
      await expect.poll(async () => (await callTool<{ recording: Recording }>('browser.recording', { action: 'status', recordingId })).recording.frameCount,
        { timeout: 10_000 }).toBeGreaterThanOrEqual(6);
      const stopped = await callTool<{ recording: Recording }>('browser.recording', { action: 'stop', recordingId });
      expect(stopped.recording.status, JSON.stringify(stopped.recording)).toBe('completed');
      const artifact = stopped.recording.artifact!; expect(artifact.frameCount).toBeGreaterThanOrEqual(3);
      expect(artifact.durationMs).toBeGreaterThanOrEqual(250); expect(fs.statSync(artifact.path).size).toBeGreaterThan(256);
      recordingFile = artifact.path;
      expect((await callTool<{ activeId: string | null }>('browser.tabs', {})).activeId).toBe(opened.id);
      expect(await view.evaluate(element => (element as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
      const player = await win!.evaluate(async ({ url, workspaceId }) => window.api.browser.open({ url, workspaceId, sessionId: '' }),
        { url: `${baseUrl}/player`, workspaceId });
      const playerView = win!.locator(`webview[data-tab-id="${player.id}"]`); await expect(playerView).toBeVisible();
      const playerId = await playerView.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
      const readPlayer = async () => {
        const state = await backend<{ ready: number; width: number; height: number; time: number; frames: number; error: string | null }>(playerId,
          `(()=>{const v=document.getElementById('recording');if(!v)return{ready:0,width:0,height:0,time:0,frames:0,error:null};return{ready:v.readyState,width:v.videoWidth,height:v.videoHeight,time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,error:v.error?.message??null}})()`);
        evidence.latestPlayback = state;
        return state;
      };
      await expect.poll(async () => (await readPlayer()).ready, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      const state = await readPlayer(); expect([state.width, state.height]).toEqual([artifact.width, artifact.height]); expect(state.error).toBeNull();
      await backend(playerId, `(async()=>{const v=document.getElementById('recording');v.muted=true;await v.play();return true})()`);
      await expect.poll(async () => (await readPlayer()).time).toBeGreaterThan(.05);
      await expect.poll(async () => (await readPlayer()).frames).toBeGreaterThanOrEqual(2);
      evidence.recording = { recording: stopped.recording, playback: await readPlayer() };
      await win!.screenshot({ path: info.outputPath('native-webview-recording-playback.png') });
    });
    expect(errors.filter(error => !error.includes('Invalid guestInstanceId')), 'Unexpected host renderer errors').toEqual([]);
  } catch (error) { evidence.failure = String(error); throw error;
  } finally {
    if (win) {
      await win.screenshot({ path: info.outputPath('native-webview-final.png') }).catch(error => { evidence.finalScreenshotError = String(error); });
      evidence.finalHost = await win.evaluate(() => ({ active: { tag: document.activeElement?.tagName,
        className: document.activeElement?.getAttribute('class'), value: (document.activeElement as HTMLInputElement | null)?.value },
        selectedTabs: [...document.querySelectorAll('.right-tab[aria-selected="true"]')].map(element => element.textContent),
        views: [...document.querySelectorAll<HTMLElement>('webview')].map(element => ({ tabId: element.dataset.tabId,
          presentation: element.dataset.browserPresentation, visibility: getComputedStyle(element).visibility,
          width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
          inert: element.hasAttribute('inert'), connected: element.isConnected }))
      })).catch(error => ({ diagnosticError: String(error) }));
    }
    if (app && observedGuestId !== undefined) evidence.finalGuest = await app.evaluate(async ({ webContents }, { id, expression }) => {
      const guest = webContents.fromId(id);
      return guest && !guest.isDestroyed() ? { id, url: guest.getURL(), state: await guest.executeJavaScript(expression) } : { id, destroyed: true };
    }, { id: observedGuestId, expression: stateExpression }).catch(error => ({ diagnosticError: String(error) }));
    if (tool) {
      evidence.finalDownloads = await tool('browser.downloads', {}).catch(error => ({ diagnosticError: String(error) }));
      if (recordingId) evidence.finalRecording = await tool('browser.recording', { action: 'status', recordingId })
        .catch(error => ({ diagnosticError: String(error) }));
    }
    fs.writeFileSync(info.outputPath('native-webview-evidence.json'), JSON.stringify({ ...evidence, serverRequests, errors }, null, 2));
    if (recordingId && tool) await tool('browser.recording', { action: 'cancel', recordingId }).catch(() => {});
    if (app) await stopApp(app); await closeServer(server);
  }
});
