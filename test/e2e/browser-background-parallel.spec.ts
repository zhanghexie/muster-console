/**
 * Real Electron + Shell API: token-bound workers use explicit DOM actions on
 * background webviews while human native input keeps its foreground target.
 * Semantic AI events and trusted human events are asserted separately.
 * Run: npm run test:e2e -- browser-background-parallel.spec.ts --retries=0
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserTabsPayload } from '../../src/shared/browser';
import { buildExternalFileUrl } from '../../src/shared/filePreview';

const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);
const workspaceId = 'browser-background-workers';
interface ToolReply { ok: boolean; result?: unknown; error?: string }
interface Trace { type: string; trusted: boolean; target: string; key?: string; value?: string; buttons?: number }
interface GuestState {
  ready: boolean; draft: string; focus: string; clicks: number; scrollY: number; checked: boolean; selected: string; memory: string; lateFocusCount: number;
  drag: { x: number; y: number; down: boolean }; trace: Trace[]; queue: string[];
}
interface ManagedWidgetInspection {
  widgets: Array<{ path: string; version: number; modelContent: Record<string, unknown> | null;
    stateRevision: number; receipt: { status: string; visible: boolean; error?: string } }>;
}
interface ManagedWidgetState {
  nativeHost: boolean; version: number; value: string; input: string; text: string;
  action: { ok?: boolean; error?: string } | null;
}
const stateExpression = `({ready:!!window.__ready,draft:document.getElementById('draft').value,
  focus:document.activeElement?.id??document.activeElement?.tagName,
  checked:document.getElementById('check').checked,selected:document.getElementById('select').value,
  memory:window.__memory,clicks:window.__clicks,lateFocusCount:window.__lateFocusCount,scrollY:window.scrollY,
  drag:window.__drag,trace:window.__trace,queue:window.__queue})`;

function html(route: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${route}</title>
  <style>html,body{margin:0;background:#edf3fc;font:16px system-ui}body{height:3000px}
  #click{position:absolute;left:20px;top:20px;width:140px;height:36px}
  #draft{position:absolute;left:20px;top:70px;width:240px;height:30px}
  #check{position:absolute;left:300px;top:70px}#select{position:absolute;left:350px;top:70px}
  #drag{position:absolute;left:24px;top:140px;width:80px;height:50px;background:#3573bd;color:white;touch-action:none;user-select:none}
  </style></head><body><button id="click">Action ${route}</button><input id="draft" aria-label="Background draft">
  <input id="check" type="checkbox"><select id="select"><option value="first">First</option><option value="second">Second</option></select>
  <div id="drag">Drag me</div><script>
  window.__ready=true;window.__clicks=0;window.__trace=[];window.__queue=[];window.__memory='memory-'+Math.random();window.__lateFocusCount=0;
  window.__drag={x:0,y:0,down:false};
  const draft=document.getElementById('draft'),drag=document.getElementById('drag');
  for(const type of ['pointerdown','pointerup','click','paste','beforeinput','input','change','keydown','focusin','focusout'])document.addEventListener(type,e=>{
    window.__trace.push({type,trusted:e.isTrusted,target:e.target.id,key:e.key,value:e.target.value,buttons:e.buttons});
  });
  document.getElementById('click').addEventListener('click',()=>{
    window.__clicks++;window.focus();draft.focus();
    setTimeout(()=>{draft.focus();window.__lateFocusCount++},20);
  });
  drag.addEventListener('pointerdown',e=>{window.__drag.down=true;drag.setPointerCapture(e.pointerId)});
  drag.addEventListener('pointermove',e=>{if(window.__drag.down){window.__drag.x=e.clientX;window.__drag.y=e.clientY}});
  drag.addEventListener('pointerup',e=>{window.__drag={x:e.clientX,y:e.clientY,down:false}});
  draft.addEventListener('input',()=>window.__queue.push('input:'+draft.value));
  </script></body></html>`;
}

/** Independent observation/control while the public per-page queue is occupied. */
async function backendValue<T>(app: ElectronApplication, guestId: number, expression: string): Promise<T> {
  return await app.evaluate(async ({ webContents }, { guestId, expression }) => {
    const guest = webContents.fromId(guestId);
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') throw new Error(`Missing native guest ${guestId}`);
    return await guest.executeJavaScript(expression);
  }, { guestId, expression }) as T;
}

async function guestContentsId(win: Page, tabId: string): Promise<number> {
  return win.locator(`webview[data-tab-id="${tabId}"]`).evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
}

async function nativeGuestPoint(win: Page, app: ElectronApplication, tabId: string, selector: string, leadingEdge = false): Promise<{ x: number; y: number }> {
  const view = win.locator(`webview[data-tab-id="${tabId}"]`), box = await view.boundingBox();
  expect(box).not.toBeNull();
  const geometry = await backendValue<{ x: number; y: number; width: number; height: number }>(app,
    await guestContentsId(win, tabId), `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+Math.min(r.width/2,${leadingEdge ? '12' : 'Infinity'}),y:r.y+r.height/2,width:innerWidth,height:innerHeight}})()`);
  return { x: box!.x + geometry.x * box!.width / geometry.width, y: box!.y + geometry.y * box!.height / geometry.height };
}

async function foregroundDiagnostics(win: Page, tabId: string, point: { x: number; y: number }): Promise<unknown> {
  return win.evaluate(({ tabId, point }) => {
    const view = document.querySelector<HTMLElement>(`webview[data-tab-id="${tabId}"]`);
    const rect = (element: Element | null) => {
      const r = element?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    };
    const describe = (element: Element | null) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return { tag: element.tagName, id: element.id, className: element.getAttribute('class'), tabId: element.getAttribute('data-tab-id'),
        rect: rect(element), visibility: style.visibility, opacity: style.opacity, pointerEvents: style.pointerEvents,
        transform: style.transform, zIndex: style.zIndex, inert: element.hasAttribute('inert'), ariaHidden: element.getAttribute('aria-hidden') };
    };
    const hit = document.elementFromPoint(point.x, point.y), page = view?.closest('.browser-page') ?? null;
    const ancestors = [];
    for (let element: Element | null = view ?? null; element && ancestors.length < 9; element = element.parentElement) ancestors.push(describe(element));
    return { point, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, hostActive: describe(document.activeElement),
      hit: describe(hit), hitTabId: hit?.closest('webview')?.getAttribute('data-tab-id') ?? null,
      page: describe(page), strip: describe(view?.closest('.h-strip') ?? document.querySelector('.h-strip')),
      gestureLayers: Array.from(page?.querySelectorAll('.browser-gesture-layer') ?? []).map(describe), ancestors };
  }, { tabId, point });
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

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cleanup timed out')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('background DOM browser: parallel workers, human focus and same-page FIFO after errors', async ({}, info) => {
  test.setTimeout(90_000);
  // Playwright's per-test retry path can exceed Git for Windows' working-tree limit.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-browser-e2e-'));
  const workspace = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(path.join(workspace, '.muster'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.muster/workspace.json'), JSON.stringify({
    hVirtualScreen: true, hDock: 'git', sideToolsTab: 'browser', hGitRatio: .8, hTerminalRatio: .5
  }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: workspaceId, defaultCwd: workspace,
    workspaces: [{ id: workspaceId, name: 'Background workers', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture').pathname.slice(1) || 'front';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html(route));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `browser-background-${process.pid}`,
    MUSTER_WEB_PORT: '0', APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata')
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined, win: Page | undefined;
  const sessionIds: string[] = [], errors: string[] = [];
  const observedTabIds: string[] = [];
  const evidence: Record<string, unknown> = {};
  try {
    app = await _electron.launch({ executablePath: nodeRequire('electron') as unknown as string,
      args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 30_000 });
    win = await app.firstWindow();
    win.setDefaultTimeout(8000);
    win.on('pageerror', error => errors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 30_000 });
    const hostWindow = await app.browserWindow(win);
    await hostWindow.evaluate(window => window.setContentSize(1500, 920));
    // Real shell sessions supply the same statusToken identity used by CLI AIs.
    // No Worker CLI, LLM network, or fake executor context is needed.
    for (const name of ['Background AI A', 'Background AI B']) {
      const session = await win.evaluate(async ({ name, cwd, workspaceId }) => window.api.sessions.create({
        name, cwd, workspaceId, shellProfileId: 'powershell'
      }), { name, cwd: workspace, workspaceId }) as { id: string };
      sessionIds.push(session.id);
    }
    const sessionList = await win.evaluate(async () => window.api.sessions.list());
    const tokens = sessionIds.map(id => sessionList.sessions.find(session => session.id === id)?.statusToken);
    expect(tokens.every(Boolean), 'Both worker sessions must have genuine session tokens').toBe(true);
    await expect.poll(() => fs.existsSync(path.join(userData, 'shell-api.json'))).toBe(true);
    const toolUrl = (JSON.parse(fs.readFileSync(path.join(userData, 'shell-api.json'), 'utf8')) as { toolUrl: string }).toolUrl;
    const call = async (worker: 0 | 1, name: string, args: Record<string, unknown>): Promise<ToolReply> => {
      const payload = name.startsWith('browser.')
        ? { name: 'host.browser.run', arguments: { action: name.slice('browser.'.length), params: args } }
        : { name: name.startsWith('host.') ? name : `host.${name}`, arguments: args };
      const response = await fetch(toolUrl, { method: 'POST', headers: {
        'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${tokens[worker]}`
      }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
      expect(response.ok, `${name} Shell API HTTP`).toBe(true);
      return await response.json() as ToolReply;
    };
    const tool = async (worker: 0 | 1, name: string, args: Record<string, unknown>): Promise<unknown> => {
      const reply = await call(worker, name, args);
      expect(reply.ok, `${name}: ${JSON.stringify(reply)}`).toBe(true);
      return reply.result;
    };
    const readState = async (tabId: string): Promise<GuestState> => backendValue(app!, await guestContentsId(win!, tabId), stateExpression);
    await win.evaluate(() => {
      const witness = window as typeof window & { __backgroundActions: Array<{ active: boolean; action: string | null; tabId: string | null }> };
      witness.__backgroundActions = [];
      window.api.on('browser:agentState', payload => witness.__backgroundActions.push(payload));
    });
    const foreground = await win.evaluate(async ({ url, workspaceId, sessionId }) => window.api.browser.open({ url, workspaceId, sessionId }),
      { url: `${baseUrl}/front-c`, workspaceId, sessionId: sessionIds[1] });
    observedTabIds.push(foreground.id);
    await win.evaluate(async id => window.api.browser.activate({ id }), foreground.id);
    await expect(win.locator('.right-tab[aria-selected="true"] .right-tab-title')).toHaveText('front-c');
    const frontActive = async (): Promise<string | null> => (await tool(0, 'browser.tabs', {}) as BrowserTabsPayload).activeId;
    const foregroundAddress = win.locator('.browser-addr');
    await foregroundAddress.fill('unsent foreground address');
    await foregroundAddress.focus();

    let tabA = '', tabB = '';
    await test.step('cold background mount and agent selection preserve the user selection and keyboard focus', async () => {
      tabA = (await tool(0, 'browser.open', { url: `${baseUrl}/worker-a` }) as { id: string }).id;
      tabB = (await tool(1, 'browser.open', { url: `${baseUrl}/worker-b` }) as { id: string }).id;
      observedTabIds.push(tabA, tabB);
      // The first mutation is deliberately issued before visiting either tab.
      await Promise.all([
        tool(0, 'browser.fill', { tabId: tabA, target: '#draft', text: 'cold-a' }),
        tool(1, 'browser.fill', { tabId: tabB, target: '#draft', text: 'cold-b' }),
        win!.keyboard.type('-cold-mount', { delay: 8 })
      ]);
      for (const [worker, tabId] of [[0, tabA], [1, tabB]] as const) {
        expect(await tool(worker, 'browser.activate', { tabId })).toMatchObject({ ok: true, background: true });
        await expect.poll(async () => { try { return (await readState(tabId)).ready; } catch { return false; } }).toBe(true);
      }
      expect((await readState(tabA)).draft).toBe('cold-a');
      expect((await readState(tabB)).draft).toBe('cold-b');
      const payload = await tool(0, 'browser.tabs', {}) as BrowserTabsPayload;
      expect(payload.tabs.find(tab => tab.id === tabA)).toMatchObject({ workspaceId, sessionId: sessionIds[0] });
      expect(payload.tabs.find(tab => tab.id === tabB)).toMatchObject({ workspaceId, sessionId: sessionIds[1] });
      expect(await frontActive()).toBe(foreground.id);
      await expect(win!.locator('.right-tab[aria-selected="true"] .right-tab-title')).toHaveText('front-c');
      await expect(foregroundAddress).toBeFocused();
      await expect(foregroundAddress).toHaveValue('unsent foreground address-cold-mount');
      await expect(win!.locator('[data-browser-execution], [data-browser-execution-frame]')).toHaveCount(0);
      const guestIds = await Promise.all([tabA, tabB, foreground.id].map(id => guestContentsId(win!, id)));
      expect(new Set(guestIds).size).toBe(3);
      const architecture = await app!.evaluate(({ BrowserWindow, webContents }, ids) => ({
        types: ids.map(id => webContents.fromId(id)?.getType()),
        independentBrowserWindows: BrowserWindow.getAllWindows().filter(window => ids.includes(window.webContents.id)).length
      }), guestIds);
      expect(architecture).toEqual({ types: ['webview', 'webview', 'webview'], independentBrowserWindows: 0 });
      evidence.architecture = architecture;
    });

    await test.step('two background DOM pages progress while the human types into the host', async () => {
      const hostFocusBefore = await app!.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null);
      const run = async (worker: 0 | 1, tabId: string, text: string): Promise<void> => {
        await tool(worker, 'browser.click', { tabId, target: '#click' });
        await tool(worker, 'browser.fill', { tabId, target: '#draft', text });
        await tool(worker, 'browser.click', { tabId, target: '#check' });
        await tool(worker, 'browser.selectOption', { tabId, target: '#select', value: 'second' });
        await expect.poll(async () => (await readState(tabId)).lateFocusCount).toBeGreaterThanOrEqual(1);
        await tool(worker, 'browser.scroll', { tabId, direction: 'down', amount: 450 });
      };
      await Promise.all([run(0, tabA, 'draft-a'), run(1, tabB, 'draft-b'), win!.keyboard.type('-user-kept-typing', { delay: 8 })]);
      for (const [tabId, draft] of [[tabA, 'draft-a'], [tabB, 'draft-b']]) {
        const state = await readState(tabId);
        expect(state.draft).toBe(draft);
        expect(state.clicks).toBe(1);
        expect(state.checked).toBe(true);
        expect(state.selected).toBe('second');
        expect(state.scrollY).toBeGreaterThan(0);
        expect(state.drag.down).toBe(false);
        expect(state.trace.some(event => event.type === 'click' && event.target === 'click' && !event.trusted)).toBe(true);
        expect(state.trace.some(event => event.type === 'input' && event.target === 'draft' && !event.trusted)).toBe(true);
        expect(state.trace.some(event => event.type === 'pointerdown' || event.type === 'keydown')).toBe(false);
        evidence[tabId] = state;
      }
      expect(await frontActive()).toBe(foreground.id);
      await expect(win!.locator('.right-tab[aria-selected="true"] .right-tab-title')).toHaveText('front-c');
      await expect(foregroundAddress).toBeFocused();
      expect(await app!.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null)).toBe(hostFocusBefore);
      await expect(foregroundAddress).toHaveValue('unsent foreground address-cold-mount-user-kept-typing');
    });

    await test.step('background actions cannot steal native text from the foreground guest', async () => {
      const diagnostic: Record<string, unknown> = {};
      evidence.foregroundC = diagnostic;
      const firstPoint = await nativeGuestPoint(win!, app!, foreground.id, '#draft');
      diagnostic.beforeFirstClick = await foregroundDiagnostics(win!, foreground.id, firstPoint);
      await win!.screenshot({ path: info.outputPath('foreground-c-before-native-click.png') });
      await win!.mouse.click(firstPoint.x, firstPoint.y);
      diagnostic.afterFirstClick = await foregroundDiagnostics(win!, foreground.id, firstPoint);
      // A peek shield consumes the first physical click to switch work surfaces.
      // After that real user gesture, settle the transition and click the input
      // again at its current position; never replace this with programmatic focus.
      await expect(win!.locator('webview[data-tab-id="' + foreground.id + '"]')).toBeVisible();
      await expect(win!.locator('webview[data-tab-id="' + foreground.id + '"]').locator('xpath=ancestor::*[contains(@class,"browser-page")][1]')).toHaveClass(/is-active/);
      await win!.locator('.h-strip, .ws-stage, .browser-page').evaluateAll(async elements => {
        await Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      });
      const point = await nativeGuestPoint(win!, app!, foreground.id, '#draft');
      diagnostic.beforeInputClick = await foregroundDiagnostics(win!, foreground.id, point);
      await win!.mouse.click(point.x, point.y);
      await win!.keyboard.type('p');
      diagnostic.baseline = { ui: await foregroundDiagnostics(win!, foreground.id, point),
        front: await readState(foreground.id), a: await readState(tabA), b: await readState(tabB),
        focusedContentsId: await app!.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null) };
      await win!.screenshot({ path: info.outputPath('foreground-c-native-prefix-baseline.png') });
      expect((await readState(foreground.id)).draft, 'Native C prefix must arrive before any concurrent AI operation starts').toBe('p');
      const frontGuestId = await guestContentsId(win!, foreground.id);
      const beforeA = await readState(tabA), beforeB = await readState(tabB);
      await Promise.all([
        tool(0, 'browser.click', { tabId: tabA, target: '#click' }).then(() =>
          tool(0, 'browser.fill', { tabId: tabA, target: '#draft', text: 'guest-focus-a' })),
        tool(1, 'browser.click', { tabId: tabB, target: '#click' }).then(() =>
          tool(1, 'browser.fill', { tabId: tabB, target: '#draft', text: 'guest-focus-b' })),
        win!.keyboard.type('front-c-user-kept-typing', { delay: 8 })
      ]);
      await expect.poll(async () => (await readState(tabA)).lateFocusCount).toBeGreaterThan(beforeA.lateFocusCount);
      await expect.poll(async () => (await readState(tabB)).lateFocusCount).toBeGreaterThan(beforeB.lateFocusCount);
      diagnostic.afterConcurrentActions = { ui: await foregroundDiagnostics(win!, foreground.id, point),
        front: await readState(foreground.id), a: await readState(tabA), b: await readState(tabB),
        focusedContentsId: await app!.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null) };
      expect((await readState(foreground.id)).draft).toBe('pfront-c-user-kept-typing');
      expect((await readState(tabA)).draft).toBe('guest-focus-a');
      expect((await readState(tabB)).draft).toBe('guest-focus-b');
      const frontTrace = (await readState(foreground.id)).trace;
      expect(frontTrace.some(event => event.type === 'keydown' && event.trusted)).toBe(true);
      expect(frontTrace.filter(event => event.type === 'input').every(event => event.trusted)).toBe(true);
      expect(await guestContentsId(win!, foreground.id)).toBe(frontGuestId);
      expect((await readState(tabA)).memory).toBe(beforeA.memory);
      expect((await readState(tabB)).memory).toBe(beforeB.memory);
      await foregroundAddress.fill('unsent foreground address-cold-mount-user-kept-typing');
      await foregroundAddress.focus();
    });

    await test.step('same-page operations wait FIFO, another page progresses, user switches tabs midflight', async () => {
      const idA = await guestContentsId(win!, tabA);
      await win!.evaluate(() => { (window as typeof window & { __backgroundActions: unknown[] }).__backgroundActions = []; });
      // A real DOM fill waits for an absent selector, holding only A's lane.
      // The test creates the fixture node later; it never supplies tool input.
      let firstFinished = false, fillFinished = false;
      const locked = tool(0, 'browser.fill', { tabId: tabA, target: '#late-field', text: 'first-gated-fill' })
        .then(result => { firstFinished = true; return result; });
      await expect.poll(() => win!.evaluate(id => (window as typeof window & {
        __backgroundActions: Array<{ active: boolean; action: string; tabId: string }>
      }).__backgroundActions.some(event => event.active && event.action === 'fill' && event.tabId === id), tabA)).toBe(true);
      const queued = tool(1, 'browser.fill', { tabId: tabA, target: '#draft', text: 'queued-from-other-ai' }).then(result => { fillFinished = true; return result; });
      // If the queue were global, this action would deadlock behind A's gate.
      await tool(1, 'browser.fill', { tabId: tabB, target: '#draft', text: 'other-page-progress' });
      expect(firstFinished).toBe(false);
      expect(fillFinished).toBe(false);
      expect((await readState(tabA)).draft).toBe('guest-focus-a');
      const nextForeground = await win!.evaluate(async ({ url, workspaceId, sessionId }) => window.api.browser.open({ url, workspaceId, sessionId }),
        { url: `${baseUrl}/front-d`, workspaceId, sessionId: sessionIds[1] });
      await expect(win!.locator('.right-tab[aria-selected="true"] .right-tab-title')).toHaveText('front-d');
      await win!.getByRole('tab').filter({ has: win!.getByText('front-c', { exact: true }) }).click();
      await win!.getByRole('tab').filter({ has: win!.getByText('front-d', { exact: true }) }).click();
      await expect.poll(frontActive).toBe(nextForeground.id);
      const address = win!.locator('.browser-addr');
      await address.fill('new foreground draft');
      await address.focus();
      await backendValue(app!, idA, `(()=>{window.__queue.push('gate:release');const field=document.createElement('input');
        field.id='late-field';field.addEventListener('input',()=>window.__queue.push('late:'+field.value));
        document.body.append(field);return true})()`);
      await Promise.all([locked, queued]);
      const state = await readState(tabA);
      expect(state.queue.indexOf('late:first-gated-fill')).toBeGreaterThan(state.queue.indexOf('gate:release'));
      expect(state.queue.indexOf('input:queued-from-other-ai')).toBeGreaterThan(state.queue.indexOf('late:first-gated-fill'));
      expect(state.draft).toBe('queued-from-other-ai');
      expect((await readState(tabB)).draft).toBe('other-page-progress');
      expect(await frontActive()).toBe(nextForeground.id);
      await expect(win!.locator('.right-tab[aria-selected="true"] .right-tab-title')).toHaveText('front-d');
      await expect(address).toBeFocused();
      await win!.keyboard.type('-continued');
      await expect(address).toHaveValue('new foreground draft-continued');
      evidence.queue = state.queue;
    });

    await test.step('a rejected queued action cannot poison later actions', async () => {
      const failure = call(0, 'browser.fill', { tabId: tabA, target: '[', text: 'must-not-land' });
      const following = tool(1, 'browser.fill', { tabId: tabA, target: '#draft', text: 'queue-recovered' });
      expect((await failure).ok).toBe(false);
      await following;
      expect((await readState(tabA)).draft).toBe('queue-recovered');
      await expect(win!.locator('.browser-addr')).toBeFocused();
      await expect(win!.locator('.browser-addr')).toHaveValue('new foreground draft-continued');
    });

    await test.step('a coordinate outside the page fails explicitly and semantic actions preserve focus', async () => {
      const address = win!.locator('.browser-addr'), before = await address.inputValue();
      const activeBefore = await frontActive(), stateBefore = await readState(tabA);
      for (const [name, args] of [
        ['browser.hover', { target: '#click' }],
        ['browser.pressKey', { key: 'Enter' }],
        ['browser.evaluate', { expression: 'window.focus(); document.title' }]
      ] as const) {
        const reply = await call(0, name, { tabId: tabA, ...args });
        expect(reply.ok, name).toBe(true);
        expect(await frontActive(), name).toBe(activeBefore);
        await expect(address).toBeFocused();
        await expect(address).toHaveValue(before);
      }
      for (const [name, args] of [
        ['browser.click', { target: '-300,220' }]
      ] as const) {
        const reply = await call(0, name, { tabId: tabA, ...args });
        expect(reply.ok, name).toBe(false);
        expect(JSON.stringify(reply.error), name).toContain('semantic_action_failed');
        expect(await frontActive(), name).toBe(activeBefore);
        await expect(address).toBeFocused();
        await expect(address).toHaveValue(before);
      }
      const after = await readState(tabA);
      expect(after.draft).toBe(stateBefore.draft);
      expect(after.drag).toEqual(stateBefore.drag);
    });

    await test.step('overlapping evaluate callbacks restore native methods and preserve host input focus', async () => {
      const guestId = await guestContentsId(win!, tabA);
      const address = win!.locator('.browser-addr'), before = await address.inputValue();
      await backendValue(app!, guestId, `window.__focusOverlap = {
        focus: HTMLElement.prototype.focus, blur: HTMLElement.prototype.blur,
        then: Promise.prototype.then, timer: window.setTimeout,
        callbackStarted: false, callbackDone: false, evalStarted: false
      }; 0`);
      try {
        await tool(0, 'browser.evaluate', { tabId: tabA, expression: `
          setTimeout(async () => {
            const state = window.__focusOverlap;
            state.callbackStarted = true;
            try {
              await new Promise(resolve => { state.releaseCallback = resolve; });
              document.querySelector('#draft').focus();
              window.focus();
            } finally { state.callbackDone = true; }
          }, 0); 'scheduled'
        ` });
        const newer = tool(1, 'browser.evaluate', { tabId: tabA, expression: `(async () => {
          const state = window.__focusOverlap;
          state.evalStarted = true;
          await new Promise(resolve => { state.releaseEvaluation = resolve; });
          return 'newer-done';
        })()` });
        const settled = newer.then(value => ({ value }), error => ({ error }));
        await expect.poll(() => backendValue(app!, guestId,
          'window.__focusOverlap.callbackStarted && window.__focusOverlap.evalStarted')).toBe(true);
        await backendValue(app!, guestId, 'window.__focusOverlap.releaseEvaluation(); 0');
        expect(await settled).toEqual({ value: { ok: true, value: 'newer-done', mode: 'semantic', trusted: false } });
        await backendValue(app!, guestId, 'window.__focusOverlap.releaseCallback(); 0');
        await expect.poll(() => backendValue(app!, guestId, `(() => {
          const state = window.__focusOverlap;
          return state.callbackDone && HTMLElement.prototype.focus === state.focus &&
            HTMLElement.prototype.blur === state.blur && Promise.prototype.then === state.then &&
            window.setTimeout === state.timer;
        })()`)).toBe(true);
        await expect(address).toBeFocused();
        await expect(address).toHaveValue(before);
      } finally {
        await backendValue(app!, guestId, `const state = window.__focusOverlap;
          state?.releaseEvaluation?.(); state?.releaseCallback?.(); delete window.__focusOverlap; 0`);
      }
    });

    await test.step('showing and hiding a page keeps the exact guest, memory and draft', async () => {
      const idA = await guestContentsId(win!, tabA), before = await readState(tabA);
      const selectedBefore = await win!.locator('.right-tab[aria-selected="true"] .right-tab-title').innerText();
      // Ordinary content tabs belong to their owning session. This is an
      // explicit human session selection, separate from the worker tool calls.
      await win!.evaluate(async id => window.api.sessions.select(id), sessionIds[0]);
      await win!.getByRole('tab').filter({ has: win!.getByText('worker-a', { exact: true }) }).click();
      await expect(win!.locator(`webview[data-tab-id="${tabA}"]`)).toBeVisible();
      await win!.locator('.h-strip, .ws-stage, .browser-page').evaluateAll(async elements => {
        await Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      });
      expect(await guestContentsId(win!, tabA)).toBe(idA);
      expect((await readState(tabA)).draft).toBe(before.draft);
      const box = await win!.locator(`webview[data-tab-id="${tabA}"]`).boundingBox(); expect(box).not.toBeNull();
      await win!.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await win!.mouse.wheel(0, -2000);
      await expect.poll(async () => (await readState(tabA)).scrollY).toBe(0);
      let point = await nativeGuestPoint(win!, app!, tabA, '#draft');
      evidence.humanA = { beforeClick: await foregroundDiagnostics(win!, tabA, point) };
      await win!.mouse.click(point.x, point.y);
      await win!.locator('.h-strip, .ws-stage, .browser-page').evaluateAll(async elements => {
        await Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      });
      point = await nativeGuestPoint(win!, app!, tabA, '#draft'); await win!.mouse.click(point.x, point.y);
      await win!.keyboard.press('End'); await win!.keyboard.type('-human-a');
      const afterHuman = await readState(tabA);
      expect(afterHuman.draft).toBe(before.draft + '-human-a');
      // The target is now visible, with recent genuine user activation. The
      // user can keep typing in its host address bar during a semantic action.
      const visibleAddress = win!.locator('.browser-addr');
      await visibleAddress.fill('visible target address');
      await visibleAddress.focus();
      await Promise.all([
        tool(0, 'browser.click', { tabId: tabA, target: '#click' }),
        win!.keyboard.type('-still-host', { delay: 8 })
      ]);
      await expect.poll(async () => (await readState(tabA)).lateFocusCount).toBeGreaterThan(afterHuman.lateFocusCount);
      await expect(visibleAddress).toBeFocused();
      await expect(visibleAddress).toHaveValue('visible target address-still-host');
      expect((await readState(tabA)).draft).toBe(afterHuman.draft);
      await win!.evaluate(async id => window.api.sessions.select(id), sessionIds[1]);
      await win!.getByRole('tab').filter({ has: win!.getByText(selectedBefore, { exact: true }) }).click();
      expect(await guestContentsId(win!, tabA)).toBe(idA);
      expect((await readState(tabA)).memory).toBe(before.memory);
      expect((await readState(tabA)).draft).toBe(afterHuman.draft);
      await win!.locator('.browser-addr').fill('new foreground draft-continued');
      await win!.locator('.browser-addr').focus();
      // A has recent genuine user activation. Its own synchronous and delayed
      // focus handlers must still leave the user's new foreground untouched.
      await Promise.all([
        tool(0, 'browser.click', { tabId: tabA, target: '#click' }),
        win!.keyboard.type('-after-prior-human', { delay: 8 })
      ]);
      await expect.poll(async () => (await readState(tabA)).lateFocusCount).toBeGreaterThan(afterHuman.lateFocusCount);
      await expect(win!.locator('.browser-addr')).toBeFocused();
      await expect(win!.locator('.browser-addr')).toHaveValue('new foreground draft-continued-after-prior-human');
      expect((await readState(tabA)).draft).toBe(afterHuman.draft);
    });

    await test.step('managed maUi state survives semantic input and updates; privileged actions require a human gesture', async () => {
      const childUrl = `${baseUrl}/managed-child`;
      const fragment = (version: string, defaultValue: string): string => `<ma-stack>
        <p id="managed-version">${version}</p>
        <ma-input id="managed-field" name="managedValue" label="Managed value" value="${defaultValue}"></ma-input>
        <button id="managed-open" type="button">Open managed child</button>
      </ma-stack><script>
        window.__managedAction=null;
        document.getElementById('managed-open').addEventListener('click',function(){
          maUi.openUrl(${JSON.stringify(childUrl)}).then(function(result){window.__managedAction=result})
            .catch(function(error){window.__managedAction={error:error.message}});
        });
      </script>`;
      const selectedBefore = await win!.locator('.right-tab[aria-selected="true"] .right-tab-title').innerText();
      const address = win!.locator('.browser-addr');
      const addressBefore = await address.inputValue();
      await expect(address).toBeFocused();
      const rendered = await tool(0, 'ui.render', { title: 'Managed bridge', mode: 'browser', html: fragment('managed v1', 'initial') }) as { link: string; version: number; presentation: { tabId: string } };
      // CLI ui.render intentionally opens its session's aggregate page, even when that session is not selected.
      const activeBefore = await frontActive();
      expect(activeBefore).toBe(rendered.presentation.tabId);
      expect(rendered.link.replace(/\\/g, '/')).toContain(`/agent-sessions/${sessionIds[0]}/ui/`);
      const artifactUrl = buildExternalFileUrl(rendered.link);
      const managedTab = (await tool(0, 'browser.open', { url: artifactUrl }) as { id: string }).id;
      await tool(0, 'browser.snapshot', { tabId: managedTab });
      const inspect = async () => (await tool(0, 'ui.inspect', { link: rendered.link }) as ManagedWidgetInspection).widgets[0];
      const managedState = async (): Promise<ManagedWidgetState> => backendValue(app!, await guestContentsId(win!, managedTab),
        `(async()=>{await maUi.whenReady();return {nativeHost:!!window.__maUiHost,version:maUi.version,
          value:maUi.get('managedValue'),input:document.querySelector('#managed-field input').value,
          text:document.getElementById('managed-version').textContent,action:window.__managedAction}})()`
      );
      expect(await managedState()).toMatchObject({ nativeHost: true, version: 2, value: 'initial', text: 'managed v1' });
      await tool(0, 'browser.fill', { tabId: managedTab, target: '#managed-field input', text: 'from-semantic-input' });
      await expect.poll(async () => (await inspect()).modelContent?.managedValue).toBe('from-semantic-input');
      // A background guest can be mounted and interactive without a compositor frame.
      // The foreground transition below separately requires the rendered receipt.
      expect(['mounted', 'rendered']).toContain((await inspect()).receipt.status);
      expect((await inspect()).receipt.visible).toBe(false);
      const savedRevision = (await inspect()).stateRevision;
      await win!.evaluate(async link => window.api.uiWidgets.save(link, {
        valueChanges: { managedValue: { value: 'published-from-host', private: false } }
      }), rendered.link);
      await expect.poll(async () => (await managedState()).input).toBe('published-from-host');
      expect((await managedState()).value).toBe('published-from-host');
      expect((await inspect()).stateRevision).toBeGreaterThan(savedRevision);

      const beforeChild = new Set((await tool(0, 'browser.tabs', {}) as BrowserTabsPayload).tabs.map(tab => tab.id));
      await tool(0, 'browser.click', { tabId: managedTab, target: '#managed-open' });
      await expect.poll(async () => (await managedState()).action?.error ?? '').toMatch(/点击|键盘|gesture|activation/i);
      expect((await tool(0, 'browser.tabs', {}) as BrowserTabsPayload).tabs.some(tab => tab.url === childUrl && !beforeChild.has(tab.id))).toBe(false);
      expect(await frontActive()).toBe(activeBefore);
      await expect(win!.locator('.right-tab[aria-selected="true"] .right-tab-title')).toHaveText(selectedBefore);
      await expect(address).toBeFocused();
      await expect(address).toHaveValue(addressBefore);

      const updated = await tool(0, 'ui.render', { title: 'Managed bridge updated', mode: 'browser', update: rendered.link,
        html: fragment('managed v2', 'replacement default') }) as { link: string; version: number };
      expect(updated.link).toBe(rendered.link);
      expect(updated.version).toBe(rendered.version + 1);
      await expect.poll(async () => (await managedState()).text).toBe('managed v2');
      expect(await managedState()).toMatchObject({ value: 'published-from-host', input: 'published-from-host', nativeHost: true });
      // Hidden native guests may not receive a compositor rAF after reload.
      // DOM/model readiness above is independent of the pixel-render receipt.
      expect(['generated', 'mounted', 'rendered']).toContain((await inspect()).receipt.status);
      expect((await inspect()).receipt.visible).toBe(false);
      expect(await frontActive()).toBe(activeBefore);
      await expect(win!.locator('.right-tab[aria-selected="true"] .right-tab-title')).toHaveText(selectedBefore);
      await expect(address).toBeFocused();
      await expect(address).toHaveValue(addressBefore);
      const backgroundSnapshot = await inspect();
      // This is an explicit human selection and native click, outside the agent
      // proxy. It must activate the same widget's privileged action successfully.
      await win!.evaluate(async id => window.api.sessions.select(id), sessionIds[0]);
      await win!.evaluate(async id => window.api.browser.activate({ id }), managedTab);
      const managedView = win!.locator(`webview[data-tab-id="${managedTab}"]`);
      await expect(managedView).toBeVisible();
      await win!.locator('.h-strip, .ws-stage, .browser-page').evaluateAll(async elements => {
        await Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      });
      // Only the visible peek portion can receive this first physical gesture;
      // a stretched button's center can be outside the window until activation.
      const peekBox = await managedView.boundingBox(); expect(peekBox).not.toBeNull();
      // Programmatic owner selection suppresses follow-up page gestures for
      // 700ms in App. This later physical user gesture starts after that guard.
      await win!.waitForTimeout(750);
      await win!.mouse.click(peekBox!.x + 8, peekBox!.y + 8);
      await expect(win!.locator('.browser-page')).toHaveClass(/is-active/);
      await win!.locator('.h-strip, .ws-stage, .browser-page').evaluateAll(async elements => {
        await Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      });
      await expect(managedView).toHaveAttribute('data-browser-presentation', 'foreground');
      try {
        await expect.poll(async () => (await inspect()).receipt).toMatchObject({ status: 'rendered', visible: true });
      } catch (error) {
        evidence.managedReceiptFailure = {
          receipt: (await inspect()).receipt,
          guest: await backendValue(app!, await guestContentsId(win!, managedTab), `(() => {
            let visible;
            const off = window.__maUiHost.onAppearance(appearance => { visible = appearance.visible });
            off();
            return { visible, documentVisibility: document.visibilityState };
          })()`),
          aggregateVisible: (await win!.locator('.ui-session-page:visible').count()) > 0
        };
        throw error;
      }
      const point = await nativeGuestPoint(win!, app!, managedTab, '#managed-open', true);
      evidence.managedHumanClick = await foregroundDiagnostics(win!, managedTab, point);
      expect(point.x).toBeLessThan(await win!.evaluate(() => innerWidth));
      await win!.mouse.click(point.x, point.y);
      await expect.poll(async () => (await managedState()).action?.ok).toBe(true);
      const child = (await tool(0, 'browser.tabs', {}) as BrowserTabsPayload).tabs.find(tab => tab.url === childUrl && !beforeChild.has(tab.id));
      expect(child).toMatchObject({ workspaceId, sessionId: sessionIds[0] });
      evidence.managedBridge = { tabId: managedTab, child, backgroundSnapshot, state: await managedState() };
    });
    await win.screenshot({ path: info.outputPath('background-while-user-front.png') });
    expect(errors.filter(error => !error.includes('Invalid guestInstanceId')), 'Unexpected host renderer errors').toEqual([]);
  } catch (error) {
    evidence.failure = String(error);
    throw error;
  } finally {
    if (win) {
      await win.screenshot({ path: info.outputPath('background-final-state.png'), timeout: 5000 }).catch(error => { evidence.screenshotError = String(error); });
      evidence.finalGuests = await Promise.all(observedTabIds.map(async tabId => {
        try { return await bounded((async () => ({ tabId, guestId: await guestContentsId(win!, tabId),
          state: await backendValue(app!, await guestContentsId(win!, tabId), stateExpression) }))(), 5000); }
        catch (error) { return { tabId, error: String(error) }; }
      }));
    }
    if (win) for (const id of sessionIds) await bounded(win.evaluate(async sessionId => {
      await window.api.sessions.setArchived(sessionId, true);
      await window.api.sessions.close(sessionId);
    }, id), 5000)
      .catch(error => { errors.push(`session cleanup ${id}: ${String(error)}`); });
    if (app) await stopApp(app);
    await closeServer(server);
    fs.writeFileSync(info.outputPath('background-evidence.json'), JSON.stringify({ ...evidence, errors }, null, 2));
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (!evidence.failure && errors.some(error => error.startsWith('session cleanup '))) throw new Error('Test session cleanup failed; see background-evidence.json');
  }
});
