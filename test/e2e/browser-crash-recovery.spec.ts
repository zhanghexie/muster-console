/** Task-A real Electron regressions: native crash acknowledgements, production
 * IPC/Shell API, isolated userData, and independent readiness observations. */
import { test as base, expect, _electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserTabsPayload } from '../../src/shared/browser';

const repoRoot = path.resolve(__dirname, '..', '..');
const nodeRequire = createRequire(__filename);
type NativeEvent = { id: number; kind: string; at: number; reason?: string };
type NativeLog = { events: NativeEvent[]; watched: number[] };
type FixtureState = { label: string; token: string; href: string; toolClicks: number; toolWitness: string };
type ToolReply = { ok: boolean; error?: string; result?: { ok?: boolean; mode?: string; error?: string } };

class CrashApp {
  readonly evidence: Record<string, unknown> = {};
  readonly errors: string[] = [];
  constructor(readonly app: ElectronApplication, readonly win: Page, readonly baseUrl: string,
    readonly toolUrl: string, readonly info: TestInfo) {}

  tabs(): Promise<BrowserTabsPayload> { return this.win.evaluate(() => window.api.browser.restore()); }

  async open(label: string): Promise<string> {
    const opened = await this.win.evaluate(async url => window.api.browser.open({ url }), this.baseUrl + '/' + label);
    await this.ready(opened.id, label);
    await this.watch(await this.guestId(opened.id));
    // Keep each scenario to its owned tab instead of testing unrelated startup
    // targets in the same recovery fixture.
    for (const tab of (await this.tabs()).tabs) if (tab.id !== opened.id) await this.close(tab.id);
    return opened.id;
  }

  guestId(tabId: string): Promise<number> {
    return this.win.locator('webview[data-tab-id="' + tabId + '"]').evaluate(el => (el as Electron.WebviewTag).getWebContentsId());
  }

  async state(tabId: string, currentGuestId?: number): Promise<FixtureState> {
    const id = currentGuestId ?? await this.guestId(tabId);
    // The renderer-side webview bridge can retain a disposed frame after crash.
    // Resolve the current native frame independently, before testing tools.
    return this.app.evaluate(async ({ webContents }, id) => {
      const wc = webContents.fromId(id);
      if (!wc || wc.isDestroyed() || wc.isCrashed() || wc.isLoadingMainFrame()) throw new Error('Native document not ready');
      return await wc.executeJavaScript("({label:window.__label,token:window.__loadToken,href:location.href,toolClicks:window.__toolClicks??0,toolWitness:document.getElementById('tool-witness')?.textContent??''})") as FixtureState;
    }, id);
  }

  async ready(tabId: string, label: string, previousToken?: string, timeout = 12_000): Promise<FixtureState> {
    let state: FixtureState | undefined;
    await expect.poll(async () => {
      try {
        state = await this.state(tabId);
        return state.label === label && !!state.token && state.token !== previousToken;
      } catch { return false; }
    }, { timeout, intervals: [100, 200, 400], message: tabId + ' reaches a new ' + label + ' document' }).toBe(true);
    return state!;
  }

  async watch(id: number): Promise<void> {
    await this.app.evaluate(({ webContents }, id) => {
      const root = globalThis as typeof globalThis & { __browserCrashE2E?: NativeLog };
      const log = root.__browserCrashE2E ??= { events: [], watched: [] };
      if (log.watched.includes(id)) return;
      const wc = webContents.fromId(id);
      if (!wc || wc.getType() !== 'webview') throw new Error('Missing native guest ' + id);
      log.watched.push(id);
      wc.on('render-process-gone', (_e, details) => log.events.push({ id, kind: 'gone', reason: details.reason, at: Date.now() }));
      wc.on('did-start-loading', () => log.events.push({ id, kind: 'load', at: Date.now() }));
      wc.on('dom-ready', () => log.events.push({ id, kind: 'ready', at: Date.now() }));
      wc.once('destroyed', () => log.events.push({ id, kind: 'destroyed', at: Date.now() }));
    }, id);
  }

  events(): Promise<NativeEvent[]> {
    return this.app.evaluate(() => (globalThis as typeof globalThis & { __browserCrashE2E?: NativeLog }).__browserCrashE2E?.events ?? []);
  }

  async crash(tabId: string): Promise<NativeEvent> {
    const id = await this.guestId(tabId);
    const before = (await this.events()).filter(e => e.id === id && e.kind === 'gone').length;
    // Acknowledged native injection does not depend on the Page session being
    // terminated. Sending Page.crash through a dead session can hang or no-op.
    await this.app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id);
      if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.isCrashed()) throw new Error('Guest cannot be crashed: ' + id);
      wc.forcefullyCrashRenderer();
    }, id);
    await expect.poll(async () => (await this.events()).filter(e => e.id === id && e.kind === 'gone').length,
      { timeout: 5000, intervals: [50, 100], message: 'Native crash must actually occur' }).toBe(before + 1);
    return (await this.events()).filter(e => e.id === id && e.kind === 'gone').at(-1)!;
  }

  async tool(tabId: string, expectedLabel: string, currentGuestId?: number): Promise<FixtureState> {
    const before = await this.state(tabId, currentGuestId);
    const response = await fetch(this.toolUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'browser.click', arguments: { tabId, target: '#recovery-witness' } }),
      signal: AbortSignal.timeout(8000)
    });
    expect(response.ok, 'Shell API HTTP status').toBe(true);
    const reply = await response.json() as ToolReply;
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    expect(reply.result?.ok, JSON.stringify(reply)).toBe(true);
    expect(reply.result?.mode).toBe('semantic');
    const after = await this.state(tabId, currentGuestId);
    expect(after.label).toBe(expectedLabel);
    expect(after.token).toBe(before.token);
    expect(after.toolClicks, 'Real Shell API action reaches the current document exactly once').toBe(before.toolClicks + 1);
    expect(after.toolWitness).toBe(`${after.label}|${after.token}|${after.toolClicks}`);
    const witnesses = this.evidence.toolWitnesses as FixtureState[] | undefined;
    if (witnesses) witnesses.push(after); else this.evidence.toolWitnesses = [after];
    return after;
  }

  async close(tabId: string): Promise<void> {
    expect(await this.win.evaluate(async id => window.api.browser.close({ id }), tabId)).toEqual({ ok: true });
    await expect(this.win.locator('webview[data-tab-id="' + tabId + '"]')).toHaveCount(0);
    await expect.poll(async () => (await this.tabs()).tabs.some(t => t.id === tabId)).toBe(false);
  }

  // A bounded real wait is necessary to prove a scheduled load never runs.
  async quietUntil(deadline: number, ids: number[]): Promise<void> {
    const before = (await this.events()).filter(e => ids.includes(e.id) && e.kind === 'load').length;
    await this.win.waitForTimeout(Math.max(0, deadline - Date.now()));
    expect((await this.events()).filter(e => ids.includes(e.id) && e.kind === 'load').length,
      'No delayed load may run after cancellation/give-up').toBe(before);
  }
}

async function stopApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (proc.exitCode === null && proc.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* exited */ }
      } else proc.kill('SIGKILL');
    }
  }
}

const test = base.extend<{ crashApp: CrashApp }>({
  crashApp: async ({}, use, info) => {
    const cwd = info.outputDir;
    const userData = path.join(cwd, '.dev-sandbox/userData');
    const workspace = path.join(cwd, 'workspace');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(path.join(workspace, '.muster'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.muster/workspace.json'), JSON.stringify({
      hVirtualScreen: true, hDock: 'git', sideToolsTab: 'browser', hGitRatio: .8
    }));
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'crash-e2e', defaultCwd: workspace,
      workspaces: [{ id: 'crash-e2e', name: 'Crash E2E', path: workspace }],
      webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
    }));
    fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
    const requests: Record<string, number> = {};
    const server = createServer((req, res) => {
      const label = new URL(req.url ?? '/', 'http://fixture').pathname.slice(1);
      if (label === 'favicon.ico') { res.writeHead(204); res.end(); return; }
      requests[label] = (requests[label] ?? 0) + 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>' + label + '</title>' +
        '<style>body{background:#f0f4fa;color:#172235;font:24px system-ui;padding:24px}</style>' +
        '<h1>' + label + '</h1><input aria-label="Recovered input"><button id="recovery-witness" onclick="window.__toolClicks=(window.__toolClicks||0)+1;document.getElementById(\'tool-witness\').textContent=window.__label+\'|\'+window.__loadToken+\'|\'+window.__toolClicks">Recovered button</button><output id="tool-witness"></output>' +
        '<script>window.__label=' + JSON.stringify(label) + ';window.__loadToken=crypto.randomUUID();</script>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: 'crash-e2e-' + process.pid + '-' + info.testId,
      MUSTER_WEB_PORT: '0', APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata')
    };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
    let app: ElectronApplication | undefined;
    let ctx: CrashApp | undefined;
    try {
      app = await _electron.launch({ executablePath: nodeRequire('electron') as unknown as string,
        args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 25_000 });
      const win = await app.firstWindow();
      win.setDefaultTimeout(5000);
      // Drain output until the owned process exits; retain useful failure context.
      const mainLog: string[] = [];
      const capture = (data: Buffer): void => { mainLog.push(String(data)); if (mainLog.length > 200) mainLog.shift(); };
      app.process().stdout?.on('data', capture);
      app.process().stderr?.on('data', capture);
      await win.locator('.app-shell').waitFor({ timeout: 25_000 });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 920));
      await win.locator('.browser-page.is-active').waitFor();
      // Rehydrate layout through production IPC after startup preference races,
      // then wait for the real transform; is-active only means Browser tab.
      expect(await win.evaluate(() => window.api.workspaceFile.patch({
        hVirtualScreen: true, hDock: 'git', sideToolsTab: 'browser', hGitRatio: .8
      }, 'crash-e2e'))).toMatchObject({ ok: true });
      expect(await win.evaluate(() => window.api.workspaces.switch('crash-e2e'))).toMatchObject({ ok: true });
      await win.locator('.h-strip').evaluate(async el => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      await expect.poll(() => fs.existsSync(path.join(userData, 'shell-api.json'))).toBe(true);
      const { toolUrl } = JSON.parse(fs.readFileSync(path.join(userData, 'shell-api.json'), 'utf8')) as { toolUrl: string };
      ctx = new CrashApp(app, win, baseUrl, toolUrl, info);
      win.on('pageerror', err => ctx!.errors.push(err.message));
      win.on('console', msg => {
        if (msg.type() === 'error' && !msg.text().includes('Electron Security Warning')) ctx!.errors.push(msg.text());
      });
      try {
        await use(ctx);
        // Never use a broad /crashed/ exclusion that hides product exceptions.
        expect(ctx.errors.filter(e => !e.includes('Invalid guestInstanceId'))).toEqual([]);
      } finally {
        ctx.evidence.requests = requests;
        ctx.evidence.errors = ctx.errors;
        ctx.evidence.nativeEvents = await ctx.events().catch(() => []);
        ctx.evidence.tabs = await ctx.tabs().catch(() => null);
        ctx.evidence.nativeGuests = await app.evaluate(({ webContents }) => webContents.getAllWebContents()
          .filter(wc => wc.getType() === 'webview')
          .map(wc => ({ id: wc.id, url: wc.getURL(), crashed: wc.isCrashed(), processId: wc.getOSProcessId() }))).catch(() => []);
        fs.writeFileSync(path.join(cwd, 'evidence.json'), JSON.stringify(ctx.evidence, null, 2));
        fs.writeFileSync(path.join(cwd, 'main-output.log'), mainLog.join(''));
        await info.attach('native recovery evidence', { path: path.join(cwd, 'evidence.json'), contentType: 'application/json' });
        if (info.status !== info.expectedStatus) await win.screenshot({ path: path.join(cwd, 'failure.png') }).catch(() => {});
      }
    } finally {
      if (app) await stopApp(app);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

// A 165s monolithic case plus a retry cannot fit the shared 175s budget.
test.describe.configure({ retries: 0, timeout: 55_000 });

test('single crash preserves guest/history and revives the existing tool connection', async ({ crashApp: c }) => {
  const id = await c.open('page-a');
  await c.win.evaluate(async ({ id, url }) => window.api.browser.navigate({ id, input: url }), { id, url: c.baseUrl + '/page-b' });
  const before = await c.ready(id, 'page-b');
  const guestId = await c.guestId(id);
  expect((await c.tool(id, 'page-b')).label).toBe('page-b'); // real action connects before crash
  await c.crash(id);
  await c.ready(id, 'page-b', before.token);
  expect(await c.guestId(id)).toBe(guestId);
  expect((await c.tool(id, 'page-b')).label).toBe('page-b'); // real action through recovered connection
  expect((await c.tabs()).tabs.find(t => t.id === id)?.canGoBack).toBe(true);
  await c.win.evaluate(async id => window.api.browser.nav({ id, dir: 'back' }), id);
  await c.ready(id, 'page-a');
  expect((await c.tool(id, 'page-a')).label).toBe('page-a');
  await c.win.evaluate(async id => window.api.browser.nav({ id, dir: 'forward' }), id);
  await c.ready(id, 'page-b');
  c.evidence.guestId = guestId;
  await c.win.screenshot({ path: path.join(c.info.outputDir, 'history-recovered.png') });
});

test('five crashes back off, stop loading, and native Retry starts a fresh budget', async ({ crashApp: c }) => {
  const id = await c.open('crash-limit');
  let guestId = await c.guestId(id);
  const delays = [0, 1000, 3000, 8000];
  const observed: number[] = [];
  let lastCrash!: NativeEvent;
  for (let index = 0; index < 5; index++) {
    const before = await c.ready(id, 'crash-limit');
    lastCrash = await c.crash(id);
    if (index < 4) {
      await c.ready(id, 'crash-limit', before.token, delays[index] + 6000);
      const reload = (await c.events()).find(e => e.id === guestId && e.kind === 'load' && e.at >= lastCrash.at);
      expect(reload, 'Recovery produces a native load event').toBeTruthy();
      const delay = reload!.at - lastCrash.at;
      expect(delay, 'Crash ' + (index + 1) + ' respects backoff').toBeGreaterThanOrEqual(delays[index] - 100);
      observed.push(delay);
    }
  }
  await expect.poll(async () => (await c.tabs()).tabs.find(t => t.id === id)?.crashed).toBe(true);
  await expect(c.win.locator('.browser-crash-overlay')).toBeVisible();
  await c.win.screenshot({ path: path.join(c.info.outputDir, 'crash-limit.png') });
  await c.quietUntil(lastCrash.at + 8500, [guestId]);
  expect((await c.tabs()).tabs.find(t => t.id === id)?.crashed).toBe(true);
  // Reload the real host renderer after give-up. Its replacement guest must
  // stay blank until the user retries, rather than bypass the exhausted budget.
  const beforeRemountId = guestId;
  await c.win.reload();
  await expect(c.win.locator('.browser-crash-overlay')).toBeVisible();
  await expect.poll(async () => {
    try { return await c.guestId(id); } catch { return beforeRemountId; }
  }, { timeout: 8000 }).not.toBe(beforeRemountId);
  guestId = await c.guestId(id);
  await c.watch(guestId);
  expect(['', 'about:blank']).toContain(await c.app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), guestId));
  expect((await c.tabs()).tabs.find(t => t.id === id)?.crashed).toBe(true);
  c.evidence.giveUpRemount = { oldId: beforeRemountId, newId: guestId };
  const loadsBeforeRetry = (await c.events()).filter(e => e.id === guestId && e.kind === 'load').length;
  await c.win.locator('.browser-crash-overlay button', { hasText: '重新加载' }).click();
  const recovered = await c.ready(id, 'crash-limit');
  await expect(c.win.locator('.browser-crash-overlay')).toHaveCount(0);
  expect((await c.events()).filter(e => e.id === guestId && e.kind === 'load').length).toBe(loadsBeforeRetry + 1);
  expect((await c.tool(id, 'crash-limit')).label).toBe('crash-limit');
  const freshCrash = await c.crash(id);
  await c.ready(id, 'crash-limit', recovered.token);
  const freshLoad = (await c.events()).find(e => e.id === guestId && e.kind === 'load' && e.at >= freshCrash.at);
  expect(freshLoad!.at - freshCrash.at, 'Retry clears the old count').toBeLessThan(1000);
  c.evidence.backoffMs = observed;
  await c.win.screenshot({ path: path.join(c.info.outputDir, 'manual-retry.png') });
});

test('closing during backoff cancels recovery and rejects a late attach', async ({ crashApp: c }) => {
  const id = await c.open('close-backoff');
  const guestId = await c.guestId(id);
  let lastCrash!: NativeEvent;
  for (let index = 0; index < 3; index++) {
    const before = await c.ready(id, 'close-backoff');
    lastCrash = await c.crash(id);
    if (index < 2) await c.ready(id, 'close-backoff', before.token);
  }
  expect((await c.events()).some(e => e.id === guestId && e.kind === 'load' && e.at >= lastCrash.at)).toBe(false);
  await c.close(id); // third crash is in a 3s backoff, not already at give-up
  await c.quietUntil(lastCrash.at + 3500, [guestId]);
  const late = await c.win.evaluate(async ({ tabId, webContentsId }) => window.api.browser.guestAttach({ tabId, webContentsId }),
    { tabId: id, webContentsId: guestId });
  expect(late.ok).toBe(false);
  expect((await c.tabs()).tabs.some(t => t.id === id)).toBe(false);
  expect((await c.events()).some(e => e.id === guestId && e.kind === 'destroyed')).toBe(true);
});

test('guest replacement cancels the old recovery and refuses its late attach', async ({ crashApp: c }) => {
  const id = await c.open('replace-backoff');
  const oldId = await c.guestId(id);
  let lastCrash!: NativeEvent;
  for (let index = 0; index < 3; index++) {
    const before = await c.ready(id, 'replace-backoff');
    lastCrash = await c.crash(id);
    if (index < 2) await c.ready(id, 'replace-backoff', before.token);
  }
  expect((await c.events()).some(e => e.id === oldId && e.kind === 'load' && e.at >= lastCrash.at)).toBe(false);
  // Native guest replacement through real guestAttach. No React state or crash
  // event is synthesized. This covers the service generation boundary.
  const newId = await c.win.evaluate(async tabId => {
    const original = document.querySelector<Electron.WebviewTag>('webview[data-tab-id="' + tabId + '"]')!;
    const view = document.createElement('webview') as Electron.WebviewTag;
    view.setAttribute('partition', original.getAttribute('partition')!);
    view.setAttribute('preload', original.getAttribute('preload')!);
    document.querySelector('.browser-host')!.appendChild(view);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('replacement dom-ready timeout')), 5000);
      (view as HTMLElement).addEventListener('dom-ready', () => { clearTimeout(timer); resolve(); }, { once: true });
      view.setAttribute('src', 'about:blank');
    });
    return view.getWebContentsId();
  }, id);
  await c.watch(newId);
  expect(await c.win.evaluate(async ({ tabId, webContentsId }) => window.api.browser.guestAttach({ tabId, webContentsId }),
    { tabId: id, webContentsId: newId })).toMatchObject({ ok: true });
  await expect.poll(async () => c.app.evaluate(async ({ webContents }, id) =>
    await webContents.fromId(id)!.executeJavaScript('window.__label'), newId)).toBe('replace-backoff');
  const token = await c.app.evaluate(async ({ webContents }, id) =>
    await webContents.fromId(id)!.executeJavaScript('window.__loadToken'), newId);
  const late = await c.win.evaluate(async ({ tabId, webContentsId }) => window.api.browser.guestAttach({ tabId, webContentsId }),
    { tabId: id, webContentsId: oldId });
  expect(late).toMatchObject({ ok: false, reason: 'stale-generation' });
  // Retire the whole webview element, as a renderer remount would. wc.close()
  // alone leaves the crashed embedder element/target behind and is incomplete.
  await c.win.locator('webview[data-tab-id="' + id + '"]').evaluate(el => el.remove());
  await expect.poll(async () => (await c.events()).some(e => e.id === oldId && e.kind === 'destroyed')).toBe(true);
  await c.quietUntil(lastCrash.at + 3500, [oldId, newId]);
  expect(await c.app.evaluate(async ({ webContents }, id) =>
    await webContents.fromId(id)!.executeJavaScript('window.__loadToken'), newId)).toBe(token);
  expect((await c.tool(id, 'replace-backoff', newId)).token).toBe(token);
  c.evidence.replacement = { oldId, newId };
});
