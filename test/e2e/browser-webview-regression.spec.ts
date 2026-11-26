/**
 * Production Electron regressions for the webview migration. The browser tools
 * go through the real Shell API/executor/IPC; user wheel and keyboard input is native,
 * while background tools use semantic DOM actions and reject unsupported gestures.
 * Layout preparation uses the production workspace preference API. No guest,
 * BrowserPage or focus isolation implementation is mocked, and peek cannot skip.
 *
 * Run: npm run test:e2e -- browser-webview-regression.spec.ts --retries=0
 */
import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceFileConfig } from '../../src/shared/metaAgent';
import { virtualScreenPageKey } from '../../src/renderer/src/virtualScreenPagePreference';

const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);
const A = 'browser-regression-a';
const B = 'browser-regression-b';

interface ToolReply { ok?: boolean; error?: unknown; result?: unknown }
interface GuestState {
  ready: boolean;
  draft: string;
  memory: string | null;
  historyLength: number;
  historyState: unknown;
  href: string;
  bodyY: number;
  innerY: number;
  innerX: number;
  clicks: number;
  pagePath: string;
  pointer: { downs: number; ups: number; x: number; y: number; buttons: number };
}

function guestHtml(pagePath: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Browser regression</title>
<style>html,body{margin:0;background:#eef1f6}body{height:3000px;font:16px system-ui}
#native-button{position:absolute;left:8px;top:8px;width:120px;height:30px}
#draft{position:absolute;left:8px;top:45px;width:180px}
#box{position:absolute;left:40px;top:100px;width:220px;height:200px;overflow:auto;border:4px solid #3867bb;background:#fff}
#inside{width:1200px;height:1800px;background:repeating-linear-gradient(#fff 0px,#fff 28px,#bbb 29px,#fff 30px)}</style>
</head><body><button id="native-button" onclick="window.__nativeClicks=(window.__nativeClicks||0)+1">Native click</button>
<input id="draft" aria-label="Web draft"><div id="box"><div id="inside">Inner scroll target</div></div>
<script>window.__regressionReady=true;window.__pagePath=${JSON.stringify(pagePath)};
window.__pointerTrace={downs:0,ups:0,x:0,y:0,buttons:0};
document.addEventListener('pointerdown',()=>window.__pointerTrace.downs++);
document.addEventListener('pointerup',e=>{Object.assign(window.__pointerTrace,{ups:window.__pointerTrace.ups+1,x:e.clientX,y:e.clientY,buttons:e.buttons})});
</script></body></html>`;
}

async function stopApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  // Normal close may minimize to tray. Keep the owned parent alive until the
  // fallback can stop its whole process tree rather than orphaning a PTY shell.
  await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (proc.exitCode === null && proc.pid) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    } else proc.kill('SIGKILL');
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function guestValue<T>(app: ElectronApplication, win: Page, tabId: string, expression: string): Promise<T> {
  const id = await win.locator(`webview[data-tab-id="${tabId}"]`).evaluate(el => (el as Electron.WebviewTag).getWebContentsId());
  return app.evaluate(async ({ webContents }, { id, expression }) => {
    const guest = webContents.fromId(id);
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') throw new Error(`Missing native guest ${id}`);
    return await guest.executeJavaScript(expression);
  }, { id, expression }) as Promise<T>;
}

async function guestState(app: ElectronApplication, win: Page, tabId: string): Promise<GuestState> {
  return guestValue<GuestState>(app, win, tabId, `({ready:!!window.__regressionReady,
      draft:document.getElementById('draft')?.value??'',memory:window.__regressionMemory??null,
      historyLength:history.length,historyState:history.state,href:location.href,
      bodyY:window.scrollY,innerY:document.getElementById('box')?.scrollTop??0,
      innerX:document.getElementById('box')?.scrollLeft??0,
      clicks:window.__nativeClicks??0,pagePath:window.__pagePath??'',pointer:window.__pointerTrace})`);
}

async function waitGuest(app: ElectronApplication, win: Page, tabId: string): Promise<void> {
  await expect.poll(async () => {
    try { return (await guestState(app, win, tabId)).ready; } catch { return false; }
  }, { timeout: 15_000, message: `Guest ${tabId} should reach the local fixture` }).toBe(true);
}

async function patchLayout(win: Page, patch: Partial<WorkspaceFileConfig>, owner = A): Promise<void> {
  const { hDock, ...layout } = patch;
  const reply = await win.evaluate(async ({ layout, owner, hDock, pageKey }) => {
    if (hDock) localStorage.setItem(pageKey, hDock === 'git' ? 'right' : 'left');
    return window.api.workspaceFile.patch(layout, owner);
  }, { layout, owner, hDock, pageKey: virtualScreenPageKey(owner) });
  expect(reply.ok, 'Production workspace layout patch should succeed').toBe(true);
  // patch persists preferences; it does not broadcast to independently mounted
  // hooks. Re-activate the same workspace through the real host to hydrate them.
  const activation = await win.evaluate(async id => window.api.workspaces.switch(id), owner);
  expect(activation.ok).toBe(true);
  await expect.poll(() => win.evaluate(async () => (await window.api.workspaceFile.get()).workspaceId)).toBe(owner);
  if (typeof patch.hVirtualScreen === 'boolean') {
    await expect(win.locator('.main-view')).toHaveClass(new RegExp(`\\bh-vs-${patch.hVirtualScreen ? 'on' : 'off'}\\b`));
  }
  if (patch.hDock) await expect(win.locator('.main-view')).toHaveClass(new RegExp(`\\bh-${patch.hDock}\\b`));
  // Wait for preference subscribers and compositor movement rather than relying
  // on a synthetic active flag or overriding the gesture layer's CSS.
  await win.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await win.locator('.h-strip').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}

test('browser regression: cold semantic tools, background isolation, workspace lifetime and native peek wheel', async ({}, info) => {
  test.setTimeout(120_000);
  const cwd = info.outputDir;
  const userData = path.join(cwd, '.dev-sandbox/userData');
  const workspaceA = path.join(cwd, 'workspace-a');
  const workspaceB = path.join(cwd, 'workspace-b');
  fs.mkdirSync(userData, { recursive: true });
  const requests = new Map<string, number>();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(guestHtml(pathname));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const directory of [workspaceA, workspaceB]) {
    fs.mkdirSync(path.join(directory, '.muster'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.muster/workspace.json'), JSON.stringify({
      hVirtualScreen: false, hDock: 'terminal', sideToolsTab: 'browser'
    }));
  }
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: A, defaultCwd: workspaceA,
    workspaces: [{ id: A, name: 'Browser A', path: workspaceA }, { id: B, name: 'Browser B', path: workspaceB }],
    // These shells are never visited before their respective first actions.
    // restore may also create/mount a blank active tab; assertions identify tabs
    // by URL and never assume an exact total count.
    browser: { tabs: { urls: ['about:blank', `${baseUrl}/lazy-input`, `${baseUrl}/navigate-original`], activeIdx: 0 } },
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `browser-regression-${process.pid}`,
    MUSTER_WEB_PORT: '0', APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata')
  };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[name];
  let app: ElectronApplication | undefined;
  let win: Page | undefined;
  let terminalId: string | undefined;
  const evidence: Record<string, unknown> = { requests: {}, stages: [], errors: [] };
  const stages = evidence.stages as string[];
  const errors = evidence.errors as string[];
  try {
    app = await _electron.launch({
      executablePath: nodeRequire('electron') as unknown as string,
      args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 60_000
    });
    win = await app.firstWindow();
    win.setDefaultTimeout(8000);
    win.on('pageerror', error => errors.push(error.message));
    win.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('Electron Security Warning')) errors.push(message.text());
    });
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 920));
    // Fixture preference: click mode keeps a held peek wheel from invoking the
    // independent 280ms dwell feature. Reload before any browser operation so
    // App loads the preference through its actual startup path.
    await win.evaluate(() => localStorage.setItem('muster.hSwitchMode', 'click'));
    await win.reload();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    await expect.poll(() => fs.existsSync(path.join(userData, 'shell-api.json'))).toBe(true);
    const toolUrl = (JSON.parse(fs.readFileSync(path.join(userData, 'shell-api.json'), 'utf8')) as { toolUrl: string }).toolUrl;
    const tool = async (name: string, args: Record<string, unknown>, unsupported = false): Promise<ToolReply> => {
      // R2 起 browser 域收敛为 browser.run 信封；旧直调名在此透明转换（Shell API 支持按 action 展开真实目标）
      const payload = name.startsWith('browser.')
        ? { name: 'host.browser.run', arguments: { action: name.slice('browser.'.length), params: args } }
        : { name: name.startsWith('host.') ? name : `host.${name}`, arguments: args };
      const response = await fetch(toolUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000)
      });
      expect(response.ok, `${name} Shell API HTTP status`).toBe(true);
      const reply = await response.json() as ToolReply;
      expect(reply.ok, `${name}: ${JSON.stringify(reply)}`).toBe(!unsupported);
      if (unsupported) expect(JSON.stringify(reply), `${name} must report a capability boundary`).toContain('capability_unsupported');
      return reply;
    };

    await test.step('cold terminal page can open and snapshot a guest without visiting Browser UI', async () => {
      await expect(win!.locator('.h-strip')).not.toHaveClass(/vs-axis/);
      await expect(win!.locator('.browser-page.is-active')).toHaveCount(0);
      const opened = (await tool('browser.open', { url: `${baseUrl}/cold` })).result as { id: string };
      evidence.coldTabId = opened.id;
      const snapshot = await tool('browser.snapshot', { tabId: opened.id });
      expect(JSON.stringify(snapshot.result)).toContain('Web draft');
      await waitGuest(app!, win!, opened.id);
      await expect(win!.locator('.browser-page.is-active')).toHaveCount(0);
      expect(requests.get('/cold')).toBe(1);
      stages.push('cold snapshot');
    });
    await patchLayout(win, { hVirtualScreen: true, hDock: 'git', sideToolsTab: 'browser', hGitRatio: .8, hTerminalRatio: .5 });
    // Subsequent steps switch sessions and workspaces while exercising one user-opened guest.
    const { id: tabId } = await win.evaluate(async ({ url, workspaceId }) => window.api.browser.open({ url, workspaceId, scope: 'workspace' }), { url: `${baseUrl}/shared`, workspaceId: A });
    const view = win.locator(`webview[data-tab-id="${tabId}"]`);
    await expect(win.locator('.browser-page')).toHaveClass(/is-active/);
    await expect(view).toBeVisible();
    await waitGuest(app!, win, tabId);
    await expect(win.getByRole('button', { name: '固定标签页', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(view).toHaveAttribute('data-browser-presentation', 'foreground');
    evidence.workspaceTabId = tabId;

    await test.step('read-only snapshot preserves the address draft and real terminal focus', async () => {
      const address = win!.locator('.browser-addr');
      await address.fill('unsent-address-draft');
      await address.focus();
      await tool('browser.snapshot', { tabId });
      await expect(address).toBeFocused();
      await win!.keyboard.type('-still-here');
      await expect(address).toHaveValue('unsent-address-draft-still-here');
      const shell = await win!.evaluate(async ({ cwd, workspaceId }) => window.api.sessions.create({
        name: 'Browser focus regression', shellProfileId: 'powershell', cwd, workspaceId
      }), { cwd: workspaceA, workspaceId: A }) as { id: string };
      terminalId = shell.id;
      await win!.evaluate(async id => window.api.sessions.select(id), shell.id);
      await patchLayout(win!, { hDock: 'terminal' });
      const terminal = win!.locator('.terminal-wrap.is-shown .xterm-helper-textarea');
      await terminal.waitFor();
      await terminal.focus();
      await tool('browser.snapshot', { tabId });
      await expect(terminal).toBeFocused();
      await win!.keyboard.type("Write-Output ('BROWSER_' + 'FOCUS_KEPT')");
      await win!.keyboard.press('Enter');
      await expect.poll(() => win!.evaluate(async id => window.api.pty.getBuffer(id), shell.id), { timeout: 8000 }).toContain('BROWSER_FOCUS_KEPT');
      stages.push('readonly focus');
    });

    await test.step('real peek wheel scrolls the hovered inner box on both axes', async () => {
      await patchLayout(win!, { hDock: 'terminal', hVirtualScreen: true, hTerminalRatio: .5, hGitRatio: .8 });
      await expect(win!.locator('.right-tab[aria-selected="true"] .right-tab-title')).toHaveText('Browser regression');
      await expect(view).toHaveAttribute('data-browser-presentation', 'foreground');
      await expect(win!.locator('.browser-page')).not.toHaveClass(/is-active/);
      const layer = win!.locator('.browser-gesture-layer');
      await expect.poll(() => layer.evaluate(el => getComputedStyle(el).pointerEvents)).not.toBe('none');
      await win!.evaluate(async id => {
        const el = document.querySelector<Electron.WebviewTag>(`webview[data-tab-id="${id}"]`)!;
        await el.executeJavaScript("window.scrollTo(0,0);document.getElementById('box').scrollTo(0,0);0");
      }, tabId);
      const rect = await view.boundingBox();
      expect(rect).not.toBeNull();
      const point = { x: rect!.x + 100, y: rect!.y + 160 };
      const hit = await win!.evaluate(point => document.elementFromPoint(point.x, point.y)?.classList.contains('browser-gesture-layer') ?? false, point);
      expect(hit, 'Native wheel must hit the real peek shield, not an active guest or offscreen area').toBe(true);
      await win!.mouse.move(point.x, point.y);
      await win!.mouse.wheel(0, 320);
      await expect.poll(async () => (await guestState(app!, win!, tabId)).innerY).toBeGreaterThan(0);
      expect((await guestState(app!, win!, tabId)).bodyY).toBe(0);
      await expect.poll(() => layer.evaluate(el => getComputedStyle(el).pointerEvents)).not.toBe('none');
      await win!.mouse.wheel(260, 0);
      await expect.poll(async () => (await guestState(app!, win!, tabId)).innerX).toBeGreaterThan(0);
      expect((await guestState(app!, win!, tabId)).bodyY).toBe(0);
      evidence.peekWheel = await guestState(app!, win!, tabId);
      await win!.screenshot({ path: info.outputPath('peek-inner-wheel.png') });
      // The same shield's native click must activate the pane, not the webpage.
      const before = await guestState(app!, win!, tabId);
      // App suppresses follow-up gestures for 700ms after programmatic owner/
      // layout selection. This separate human click starts after that guard.
      await win!.waitForTimeout(750);
      // Reuse the proven shield hit: the webview box can extend behind the
      // clipped peek edge, so its top-left button coordinate is not on screen.
      await win!.mouse.click(point.x, point.y);
      await expect(win!.locator('.browser-page')).toHaveClass(/is-active/);
      const afterActivation = await guestState(app!, win!, tabId);
      expect(afterActivation.clicks).toBe(before.clicks);
      expect(afterActivation.pointer.downs).toBe(before.pointer.downs);

      // History replay arms the follow-up click guard. A separate pointerdown
      // on the peek shield must still switch pages and stay out of the guest.
      await win!.emulateMedia({ reducedMotion: 'reduce' });
      try {
        await expect(win!.locator('html')).toHaveAttribute('data-ui-motion', 'reduced');
        await win!.getByRole('button', { name: '返回上一面板', exact: true }).click();
        await expect(win!.locator('.main-view')).toHaveClass(/\bh-terminal\b/);
        await win!.mouse.click(point.x, point.y);
        await expect(win!.locator('.main-view')).toHaveClass(/\bh-git\b/);
        const afterReplayClick = await guestState(app!, win!, tabId);
        expect(afterReplayClick.pointer.downs).toBe(before.pointer.downs);
        expect(afterReplayClick.clicks).toBe(before.clicks);
      } finally {
        await win!.emulateMedia({ reducedMotion: null });
      }
      stages.push('native peek wheel and activation');
    });

    await test.step('workspace A → B → A retains the exact guest, draft, SPA state and history', async () => {
      await patchLayout(win!, { hDock: 'git' });
      await win!.evaluate(async id => {
        const el = document.querySelector<Electron.WebviewTag>(`webview[data-tab-id="${id}"]`)!;
        el.focus();
        await el.executeJavaScript("window.__regressionMemory='keep-spa';history.pushState({draft:'keep-history'},'', '?spa=kept');document.getElementById('draft').focus();0");
      }, tabId);
      await win!.keyboard.type('keep-web-draft');
      const before = await guestState(app!, win!, tabId);
      expect(before.draft).toBe('keep-web-draft');
      expect(before.historyState).toEqual({ draft: 'keep-history' });
      const node = await view.elementHandle();
      expect(node).not.toBeNull();
      const guestId = await view.evaluate(el => (el as Electron.WebviewTag).getWebContentsId());
      await win!.evaluate(async id => window.api.workspaces.switch(id), B);
      await expect.poll(() => win!.evaluate(async () => (await window.api.workspaceFile.get()).workspaceId)).toBe(B);
      await expect(view).toHaveCount(1);
      expect(await view.evaluate(el => (el as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
      expect((await guestState(app!, win!, tabId)).draft).toBe(before.draft);
      await win!.evaluate(async id => window.api.workspaces.switch(id), A);
      await expect.poll(() => win!.evaluate(async () => (await window.api.workspaceFile.get()).workspaceId)).toBe(A);
      await expect(win!.locator('.browser-page')).toHaveClass(/is-active/);
      await expect(view).toBeVisible();
      expect(await node!.evaluate((el, id) => el.isConnected && el === document.querySelector(`webview[data-tab-id="${id}"]`), tabId)).toBe(true);
      expect(await view.evaluate(el => (el as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
      const after = await guestState(app!, win!, tabId);
      for (const key of ['draft', 'memory', 'historyLength', 'historyState', 'href', 'innerY', 'innerX'] as const) expect(after[key], `Retained ${key}`).toEqual(before[key]);
      expect(requests.get('/cold')).toBe(1);
      evidence.workspace = { guestId, before, after };
      await win!.screenshot({ path: info.outputPath('workspace-guest-retained.png') });
      stages.push('workspace lifetime');
    });

    await test.step('a narrow right drawer enables native guest interaction without virtual screen', async () => {
      await patchLayout(win!, { hVirtualScreen: false, hDock: 'terminal' });
      // The shipped window's minimum width is wider than the responsive breakpoint.
      // Allow this owned sandbox window to exercise the actual 700px renderer layout.
      await app!.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setMinimumSize(0, 0);
        window.setContentSize(700, 920);
      });
      await expect(win!.locator('html')).toHaveClass(/is-narrow/);
      await win!.getByTitle('唤出文件与 Git 面板', { exact: true }).click();
      await expect(win!.locator('.git-page')).toHaveClass(/is-drawer-open/);
      await expect(win!.locator('.browser-page')).toHaveClass(/is-active/);
      await expect(view).toBeVisible();
      await expect.poll(() => win!.locator('.browser-gesture-layer').evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
      await win!.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await win!.locator('.git-page, .h-strip, .ws-stage').evaluateAll(async elements => {
        await Promise.all(elements.flatMap(el => el.getAnimations().map(animation => animation.finished.catch(() => {}))));
      });
      const rect = await view.boundingBox();
      expect(rect).not.toBeNull();
      const button = await guestValue<{ x: number; y: number; width: number; height: number }>(app!, win!, tabId,
        `(()=>{const r=document.getElementById('native-button').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}})()`);
      const point = { x: rect!.x + button.x * rect!.width / button.width, y: rect!.y + button.y * rect!.height / button.height };
      const hit = await win!.evaluate(({ point, tabId }) => document.elementFromPoint(point.x, point.y)?.getAttribute('data-tab-id') === tabId, { point, tabId });
      evidence.narrowNativeTarget = { rect, button, point, hit };
      expect(hit, 'The settled narrow click must hit the original native guest').toBe(true);
      const before = (await guestState(app!, win!, tabId)).clicks;
      await win!.mouse.click(point.x, point.y);
      await expect.poll(async () => (await guestState(app!, win!, tabId)).clicks).toBe(before + 1);
      await win!.screenshot({ path: info.outputPath('narrow-native-browser.png') });
      await win!.getByTitle('唤出文件与 Git 面板', { exact: true }).click();
      await expect(win!.locator('.git-page')).not.toHaveClass(/is-drawer-open/);
      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 920));
      await expect(win!.locator('html')).not.toHaveClass(/is-narrow/);
      await patchLayout(win!, { hVirtualScreen: true, hDock: 'git' });
      await expect(win!.locator('.browser-page')).toHaveClass(/is-active/);
      stages.push('narrow drawer native input');
    });

    await test.step('a lazy first semantic fill mounts in background without revealing its owning workspace', async () => {
      const payload = await win!.evaluate(async () => window.api.browser.restore());
      const lazy = payload.tabs.find(tab => tab.url === `${baseUrl}/lazy-input`);
      expect(lazy, 'Unvisited lazy fixture shell should exist').toBeTruthy();
      await expect(win!.locator(`webview[data-tab-id="${lazy!.id}"]`)).toHaveCount(0);
      await win!.evaluate(async id => window.api.workspaces.switch(id), B);
      await expect.poll(() => win!.evaluate(async () => (await window.api.workspaceFile.get()).workspaceId)).toBe(B);
      await expect(win!.locator('.browser-page.is-active')).toHaveCount(0);
      await win!.evaluate(() => {
        const root = window as typeof window & { __backgroundFocusNode?: Element | null; __backgroundFocusRequests?: unknown[]; __offBackgroundFocus?: () => void };
        root.__backgroundFocusNode = document.activeElement;
        root.__backgroundFocusRequests = [];
        root.__offBackgroundFocus = window.api.on('browser:focus-request', request => root.__backgroundFocusRequests!.push(request));
      });
      const foregroundBefore = (await win!.evaluate(async () => window.api.browser.restore())).activeId;
      // The first action itself must mount and resolve the target: no foreground
      // activate, guest-ready wait, synthetic focus or action replay hides the race.
      await tool('browser.fill', { tabId: lazy!.id, target: '#draft', text: 'first-input-kept' });
      expect((await guestState(app!, win!, lazy!.id)).draft).toBe('first-input-kept');
      await tool('browser.pressKey', { tabId: lazy!.id, key: 'End' });
      await tool('browser.pressKey', { tabId: lazy!.id, key: '!' });
      expect((await guestState(app!, win!, lazy!.id)).draft).toBe('first-input-kept');
      expect((await win!.evaluate(async () => window.api.browser.restore())).activeId).toBe(foregroundBefore);
      expect((await win!.evaluate(async () => window.api.workspaceFile.get())).workspaceId).toBe(B);
      await expect(win!.locator('.browser-page.is-active')).toHaveCount(0);
      const isolation = await win!.evaluate(() => {
        const root = window as typeof window & { __backgroundFocusNode?: Element | null; __backgroundFocusRequests?: unknown[]; __offBackgroundFocus?: () => void };
        const result = { focusUnchanged: document.activeElement === root.__backgroundFocusNode, requests: root.__backgroundFocusRequests };
        root.__offBackgroundFocus?.(); delete root.__offBackgroundFocus; delete root.__backgroundFocusNode; delete root.__backgroundFocusRequests;
        return result;
      });
      expect(isolation).toEqual({ focusUnchanged: true, requests: [] });
      evidence.lazyBackgroundIsolation = isolation;
      expect(requests.get('/lazy-input')).toBe(1);
      stages.push('lazy background semantic fill and unsupported keys');
      await win!.evaluate(async id => window.api.workspaces.switch(id), A);
    });

    await test.step('first navigation of an unmounted shell performs exactly one document request', async () => {
      const payload = await win!.evaluate(async () => window.api.browser.restore());
      const lazy = payload.tabs.find(tab => tab.url === `${baseUrl}/navigate-original`);
      expect(lazy, 'Unvisited navigation shell should exist').toBeTruthy();
      await expect(win!.locator(`webview[data-tab-id="${lazy!.id}"]`)).toHaveCount(0);
      await win!.evaluate(async ({ id, input }) => window.api.browser.navigate({ id, input }), { id: lazy!.id, input: `${baseUrl}/first-navigation` });
      await waitGuest(app!, win!, lazy!.id);
      expect((await guestState(app!, win!, lazy!.id)).pagePath).toBe('/first-navigation');
      // The old second load follows ensureGuest's polling tick. A short settle
      // interval catches that late request instead of stopping at first load.
      await win!.waitForTimeout(500);
      expect(requests.get('/first-navigation')).toBe(1);
      expect(requests.get('/navigate-original') ?? 0).toBe(0);
      stages.push('single initial navigation');
    });
    expect(errors.filter(error => !/Invalid guestInstanceId/i.test(error))).toEqual([]);
  } catch (error) {
    evidence.failure = String(error);
    if (win) {
      evidence.dom = await win.evaluate(() => ({
        activeTag: document.activeElement?.tagName,
        activeClass: document.activeElement?.getAttribute('class'),
        browserClass: document.querySelector('.browser-page')?.className,
        stripClass: document.querySelector('.h-strip')?.className,
        views: [...document.querySelectorAll('webview')].map(el => ({ tabId: el.getAttribute('data-tab-id'), visibility: getComputedStyle(el).visibility }))
      })).catch(() => null);
      await win.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    let cleanupError: unknown;
    if (win && terminalId) {
      await win.evaluate(async id => {
        await window.api.sessions.setArchived(id, true);
        await window.api.sessions.close(id);
      }, terminalId).catch(error => {
        cleanupError = error;
        evidence.sessionCleanupError = String(error);
      });
    }
    evidence.requests = Object.fromEntries(requests);
    fs.writeFileSync(info.outputPath('browser-regression-result.json'), JSON.stringify(evidence, null, 2));
    if (app) await stopApp(app);
    await closeServer(server);
    if (cleanupError && !evidence.failure) throw cleanupError;
  }
});

test('browser feedback: background semantic actions preserve surfaces and a narrow native webview receives user input', async ({}, info) => {
  test.setTimeout(60_000);
  const cwd = info.outputDir, workspace = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(path.join(workspace, '.muster'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.muster/workspace.json'), JSON.stringify({ hVirtualScreen: false, hDock: 'terminal' }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: A, defaultCwd: workspace,
    workspaces: [{ id: A, name: 'Browser feedback', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(guestHtml('/feedback'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `browser-feedback-${process.pid}`,
    MUSTER_WEB_PORT: '0', APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata')
  };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[name];
  let app: ElectronApplication | undefined, win: Page | undefined;
  try {
    app = await _electron.launch({ executablePath: nodeRequire('electron') as unknown as string,
      args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 30_000 });
    win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 30_000 });
    const hostWindow = await app.browserWindow(win);
    await hostWindow.evaluate(window => window.setContentSize(1500, 920));
    await expect.poll(() => fs.existsSync(path.join(userData, 'shell-api.json'))).toBe(true);
    const toolUrl = (JSON.parse(fs.readFileSync(path.join(userData, 'shell-api.json'), 'utf8')) as { toolUrl: string }).toolUrl;
    const tool = async (name: string, args: Record<string, unknown>, failureMarker?: string): Promise<unknown> => {
      // R2 起 browser 域收敛为 browser.run 信封；旧直调名在此透明转换（Shell API 支持按 action 展开真实目标）
      const payload = name.startsWith('browser.')
        ? { name: 'host.browser.run', arguments: { action: name.slice('browser.'.length), params: args } }
        : { name: name.startsWith('host.') ? name : `host.${name}`, arguments: args };
      const response = await fetch(toolUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
      expect(response.ok).toBe(true);
      const reply = await response.json() as ToolReply;
      expect(reply.ok, `${name}: ${JSON.stringify(reply)}`).toBe(!failureMarker);
      if (failureMarker) expect(JSON.stringify(reply), `${name} must report the specific boundary`).toContain(failureMarker);
      return reply.result;
    };
    await patchLayout(win, { hVirtualScreen: false, hDock: 'terminal' });
    await expect(win.locator('.browser-page.is-active')).toHaveCount(0);
    const activeBefore = (await tool('browser.tabs', {}) as { activeId: string | null }).activeId;
    const opened = await tool('browser.open', { url: `${baseUrl}/feedback` }) as { id: string };
    expect(await tool('browser.activate', { tabId: opened.id })).toMatchObject({ ok: true, background: true });
    const readState = () => guestState(app!, win!, opened.id);
    await waitGuest(app, win, opened.id);
    expect((await tool('browser.tabs', {}) as { activeId: string | null }).activeId).toBe(activeBefore);
    await expect(win.locator('.browser-page.is-active')).toHaveCount(0);
    const before = await readState();
    await tool('browser.click', { tabId: opened.id, target: '#native-button' });
    await expect.poll(async () => (await readState()).clicks).toBe(before.clicks + 1);
    await tool('browser.hover', { tabId: opened.id, target: '#native-button' });
    await tool('browser.pressKey', { tabId: opened.id, key: 'Enter' });
    await tool('browser.drag', { tabId: opened.id, from: '#native-button', to: '300.5,220.25' });
    expect((await tool('browser.evaluate', { tabId: opened.id, expression: 'location.pathname' }) as { value: string }).value).toBe('/feedback');
    const unchanged = await readState();
    for (const [name, args, failureMarker] of [
      ['browser.upload', { target: '#draft', files: [] }, 'authenticated workspace or session'],
      ['browser.click', { target: '300.5,220.25' }, 'capability_unsupported']
    ] as Array<[string, Record<string, unknown>, string]>) {
      await tool(name, { tabId: opened.id, ...args }, failureMarker);
      expect(await readState(), `${name} cannot mutate the native document or send pointers`).toEqual(unchanged);
      expect((await tool('browser.tabs', {}) as { activeId: string | null }).activeId).toBe(activeBefore);
      await expect(win.locator('.browser-page.is-active')).toHaveCount(0);
    }
    // User IPC selects the existing native guest that the semantic tool changed.
    const guestId = await win.locator(`webview[data-tab-id="${opened.id}"]`).evaluate(el => (el as Electron.WebviewTag).getWebContentsId());
    await patchLayout(win, { hVirtualScreen: true, hDock: 'git' });
    await win.evaluate(async id => window.api.browser.activate({ id }), opened.id);
    const view = win.locator(`webview[data-tab-id="${opened.id}"]`);
    await expect(win.locator('.browser-page')).toHaveClass(/is-active/);
    await expect(view).toBeVisible();
    expect(await view.evaluate(el => (el as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
    await expect(win.locator('[data-browser-execution]')).toHaveCount(0);
    await win.screenshot({ path: info.outputPath('feedback-wide.png') });
    await hostWindow.evaluate(window => { window.setMinimumSize(0, 0); window.setContentSize(700, 920); });
    await expect(win.locator('html')).toHaveClass(/is-narrow/);
    await expect(win.locator('.git-page')).not.toHaveClass(/is-drawer-open/);
    expect(await tool('browser.activate', { tabId: opened.id })).toMatchObject({ ok: true, background: true });
    await expect(win.locator('.git-page')).not.toHaveClass(/is-drawer-open/);
    await win.locator('button[title="唤出文件与 Git 面板"]').click();
    await expect(win.locator('.git-page')).toHaveClass(/is-drawer-open/);
    // Settle the real drawer, then deliver real user input to the native webview.
    await win.locator('.h-strip, .ws-stage, .git-page').evaluateAll(async elements => {
      await Promise.all(elements.flatMap(el => el.getAnimations().map(animation => animation.finished.catch(() => {}))));
    });
    const narrowGeometry = await win.evaluate(id => {
      const el = document.querySelector<HTMLElement>(`webview[data-tab-id="${id}"]`)!;
      const rect = el.getBoundingClientRect(), drawer = document.querySelector('.git-page')!.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const layout = [];
      for (let node: Element | null = el; node && layout.length < 12; node = node.parentElement) {
        const r = node.getBoundingClientRect(), style = getComputedStyle(node);
        layout.push({ className: node.className, left: r.left, right: r.right, width: r.width,
          scrollLeft: node.scrollLeft, minWidth: style.minWidth, flex: style.flex, position: style.position, transform: style.transform });
      }
      return { viewportWidth: innerWidth, drawerRight: drawer.right, drawerLeft: drawer.left,
        layout,
        host: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        hit: hit?.tagName ?? null, unobscured: hit === el || el.contains(hit),
        ancestors: ['.h-strip', '.ws-stage', '.work-area', '.ws-rail'].map(selector => {
          const node = document.querySelector(selector)!; const style = getComputedStyle(node);
          return { selector, transform: style.transform, willChange: style.willChange, zIndex: style.zIndex };
        }) };
    }, opened.id);
    fs.writeFileSync(info.outputPath('feedback-narrow-geometry.json'), JSON.stringify(narrowGeometry, null, 2));
    expect(Math.abs(narrowGeometry.drawerRight - narrowGeometry.viewportWidth), 'Drawer must attach to the viewport right edge').toBeLessThanOrEqual(1);
    expect(narrowGeometry.host.x, 'The full native page must stay inside the narrow drawer').toBeGreaterThanOrEqual(narrowGeometry.drawerLeft - 1);
    expect(narrowGeometry.host.x + narrowGeometry.host.width).toBeLessThanOrEqual(narrowGeometry.drawerRight + 1);
    expect(narrowGeometry.layout.find(node => String(node.className).includes('side-tools-panel'))?.scrollLeft).toBe(0);
    expect(narrowGeometry.unobscured, `Root hit target: ${narrowGeometry.hit}; ${JSON.stringify(narrowGeometry)}`).toBe(true);
    const button = await guestValue<{ x: number; y: number; width: number; height: number; hit: string | null }>(app, win, opened.id,
      `(()=>{const button=document.getElementById('native-button');const rect=button.getBoundingClientRect();
        const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
        return {x,y,width:innerWidth,height:innerHeight,hit:document.elementFromPoint(x,y)?.id??null}})()`);
    expect(button.hit, 'The measured guest point must hit the actual button').toBe('native-button');
    const point = { x: narrowGeometry.host.x + button.x * narrowGeometry.host.width / button.width,
      y: narrowGeometry.host.y + button.y * narrowGeometry.host.height / button.height };
    const rootButtonHit = await win.evaluate(({ id, point }) => {
      const el = document.querySelector(`webview[data-tab-id="${id}"]`)!;
      const hit = document.elementFromPoint(point.x, point.y);
      return { hit: hit?.tagName ?? null, unobscured: hit === el || el.contains(hit) };
    }, { id: opened.id, point });
    expect(rootButtonHit.unobscured, `Measured button point root hit: ${rootButtonHit.hit}`).toBe(true);
    await win.screenshot({ path: info.outputPath('feedback-narrow.png') });
    const inputBefore = await readState();
    await win.mouse.click(point.x, point.y);
    await expect.poll(async () => (await readState()).clicks).toBe(inputBefore.clicks + 1);
    const inputAfter = await readState();
    const hostInputDelivered = inputAfter.pointer.downs > inputBefore.pointer.downs || inputAfter.pointer.ups > inputBefore.pointer.ups;
    const hostInputNote = hostInputDelivered ? 'Native user mouse input reached the same webview guest.'
      : 'Native user mouse input did not reach the webview despite the host and guest hit tests.';
    fs.writeFileSync(info.outputPath('feedback-narrow-input.json'), JSON.stringify({ point, button, rootButtonHit,
      hostInputDelivered, hostInputNote, inputBefore, inputAfter }, null, 2));
    expect(hostInputDelivered, hostInputNote).toBe(true);
    expect(inputAfter.clicks).toBe(inputBefore.clicks + 1);
    // Semantic tools still target the same guest after native user interaction.
    await tool('browser.click', { tabId: opened.id, target: '#native-button' });
    await expect.poll(async () => (await readState()).clicks).toBe(inputAfter.clicks + 1);
  } finally {
    if (app) await stopApp(app);
    await closeServer(server);
  }
});
