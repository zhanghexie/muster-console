/** Actual BrowserTabService source; only Electron transport and guest events are fixtures.
 * Covers cold mount replay, first-navigation ownership, document readiness, generation
 * guards, native guest mounting, page queues and foreground input isolation. Native
 * behavior is separately covered by browser-webview-regression.spec.ts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'browser-tab-lifecycle-'));
const key = '__browserTabLifecycleFixture';
const previous = globalThis[key];
const guests = new Map();
let unexpectedWindows = 0;
const fileDialogs = [];
let dialogHandler = async () => ({ canceled: true, filePaths: [] });
const ipcMain = new EventEmitter();
const browserSession = new EventEmitter();
let browserUserAgent;
browserSession.setUserAgent = value => { browserUserAgent = value; };
browserSession.protocol = { handle: () => {} };
globalThis[key] = {
  app: { getPath: () => tmp, getName: () => 'MetaAgent' }, ipcMain,
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, resize: () => ({ toDataURL: () => 'data:image/png;base64,ZmFrZQ==' }) }) },
  dialog: { showOpenDialog: (parent, options) => {
    fileDialogs.push({ parent, options }); return dialogHandler(parent, options);
  } },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  session: { fromPartition: () => browserSession, defaultSession: { getUserAgent: () => 'Mozilla/5.0 MetaAgent/1.2 Chrome/150 Electron/43.7 Safari/537' } },
  webContents: { fromId: id => guests.get(id) }
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const rejectsSoon = async (promise, pattern) => {
  let timer;
  try {
    await assert.rejects(Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Queue cancellation was not delivered')), 250);
    })]), pattern);
  } finally { clearTimeout(timer); }
};
let sequence = 10, passed = 0, service;

class Guest extends EventEmitter {
  constructor(type = 'webview') {
    super(); this.id = ++sequence; this.hostWebContents = { id: 101 };
    this.type = type;
    this.mainFrame = { framesInSubtree: [] }; this.mainFrame.framesInSubtree = [this.mainFrame];
    if (type !== 'webview') this.hostWebContents = undefined;
    this.reloads = 0; this.loads = []; this.url = 'about:blank'; this.scripts = []; this.commands = []; this.sentMessages = []; this.autoLoad = true;
    this.loadGates = [];
    this.navigationHistory = {
      canGoBack: () => false, canGoForward: () => false, getActiveIndex: () => 0,
      getAllEntries: () => [{ url: this.url, title: this.url }],
      getEntryAtIndex: index => index === 0 ? { url: this.url, title: this.url } : null
    };
    this.debugger = new EventEmitter(); this.debugger.attached = false;
    this.debugger.isAttached = () => this.debugger.attached;
    this.debugger.attach = () => { this.debugger.attached = true; };
    this.debugger.detach = () => { this.debugger.attached = false; this.debugger.emit('detach'); };
    this.debugger.sendCommand = async (method, params) => {
      this.commands.push({ method, params }); return this.onCommand?.(method, params) ?? {};
    };
    guests.set(this.id, this);
  }
  getType() { return this.type; }
  getOSProcessId() { return this.processId ?? (100000 + this.id); }
  isLoadingMainFrame() { return !!this.mainLoading; }
  isDestroyed() { return !!this.destroyed; }
  getURL() { return this.url; }
  getTitle() { return this.url; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  executeJavaScript(script) { this.scripts.push(script); return Promise.resolve(0); }
  send(channel, payload) { this.sentMessages.push({ channel, payload }); }
  loadURL(url) {
    this.loads.push(url);
    this.emit('did-start-navigation', {}, url, false, true);
    const gate = deferred(); this.loadGates.push(gate);
    if (this.autoLoad) { this.commit(url); gate.resolve(); }
    return gate.promise;
  }
  commit(url) { this.url = url; this.emit('did-navigate', {}, url); this.emit('dom-ready'); }
  reload() { this.reloads++; }
  focus() { this.focusCalls = (this.focusCalls ?? 0) + 1; }
  setBackgroundThrottling(value) { this.backgroundThrottling = value; }
  setFrameRate(value) { this.frameRate = value; }
  invalidate() { this.invalidations = (this.invalidations ?? 0) + 1; }
  close() { this.destroyed = true; this.emit('destroyed'); }
}
// Tab operations must never quietly restore offscreen windows or image relay.
globalThis[key].BrowserWindow = class {
  constructor() { unexpectedWindows++; throw new Error('Tabs must mount native renderer-owned webviews'); }
};

try {
  const output = path.join(tmp, 'tabs.cjs');
  await build({ entryPoints: [path.join(root, 'src/main/browser/tabs.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'electron-transport-fixture', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
        `const s=globalThis.${key}; export const BrowserWindow=s.BrowserWindow,app=s.app,dialog=s.dialog,ipcMain=s.ipcMain,nativeImage=s.nativeImage,session=s.session,webContents=s.webContents,protocol=s.protocol;` }));
    } }] });
  const { BrowserTabService, browserSession: getBrowserSession } = createRequire(import.meta.url)(output);
  function setup(saved) {
    let configData = saved ? { browser: { tabs: saved } } : {};
    const sent = [];
    const state = { sent, onSend: () => {}, visible: true, focused: true, focusCalls: 0 };
    const win = { id: 1, isDestroyed: () => false, isVisible: () => state.visible, isFocused: () => state.focused,
      focus: () => { state.focusCalls++; }, webContents: { id: 101, isDestroyed: () => false,
      focus: () => { state.focusCalls++; },
      send: (channel, payload) => { sent.push({ channel, payload }); state.onSend(channel, payload); } } };
    service = new BrowserTabService(() => win, { get: () => configData, update: patch => { configData = { ...configData, ...patch }; } });
    state.svc = service;
    return state;
  }
  function mountOnRequest(fixture) {
    const mounted = new Map();
    fixture.onSend = (channel, payload) => {
      if (channel !== 'browser:mount-request') return;
      let guest = mounted.get(payload.tabId);
      if (!guest || guest.isDestroyed()) { guest = new Guest(); mounted.set(payload.tabId, guest); }
      assert.equal(fixture.svc.guestAttach(payload.tabId, guest.id).ok, true);
    };
    return mounted;
  }
  const physicalMouse = (guest, type = 'mouseDown') => guest.emit('before-mouse-event', {}, { type, button: 'left' });
  const physicalKey = (guest, type = 'keyDown') => guest.emit('before-input-event', {}, { type, key: 'Enter' });
  const chooser = (guest, backendNodeId = 17, mode = 'selectSingle') =>
    guest.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId, mode });
  async function nativePage(url = 'https://native.test/') {
    const fixture = setup(); mountOnRequest(fixture);
    const id = fixture.svc.createTab(url), guest = await fixture.svc.ensureGuest(id);
    return Object.assign(fixture, { id, guest });
  }
  const check = async (name, fn) => {
    try { await fn(); passed++; console.log(`ok ${passed} - ${name}`); }
    finally {
      service?.stop(); service = null; guests.clear(); fileDialogs.length = 0;
      dialogHandler = async () => ({ canceled: true, filePaths: [] }); ipcMain.removeAllListeners();
      // Each case owns a fresh service; its shared session fixture must not keep
      // download listeners from the preceding case alive.
      browserSession.removeAllListeners('will-download');
    }
  };

  await check('native Escape is relayed only from the current foreground guest and never from stale or background guests', async () => {
    const f = await nativePage();
    const escape = (type = 'keyDown') => f.guest.emit('before-input-event', {}, { type, key: 'Escape' });
    const delivered = () => f.sent.filter(message => message.channel === 'browser:escape');
    escape(); assert.deepEqual(delivered(), [{ channel: 'browser:escape', payload: { tabId: f.id } }]);
    escape('keyUp'); assert.equal(delivered().length, 1);
    await f.svc.runOperation(f.id, () => escape()); assert.equal(delivered().length, 1);
    f.focused = false; escape(); assert.equal(delivered().length, 1); f.focused = true;
    f.svc.createTab('https://other.test/'); escape(); assert.equal(delivered().length, 1);
    f.svc.activate(f.id);
    f.svc.guestDetach(f.id, f.guest.id);
    escape(); assert.equal(delivered().length, 1);
  });

  await check('native clicks relay the clicked guest without changing native activation', async () => {
    const f = await nativePage(), other = f.svc.createTab('https://other.test/');
    const delivered = () => f.sent.filter(event => event.channel === 'browser:guest-click');
    physicalMouse(f.guest, 'mouseUp'); assert.equal(delivered().length, 0);
    physicalMouse(f.guest);
    assert.deepEqual(delivered(), [{ channel: 'browser:guest-click', payload: { tabId: f.id } }]);
    assert.equal(f.svc.restore().activeId, other);
    await f.svc.runOperation(f.id, () => physicalMouse(f.guest)); assert.equal(delivered().length, 1);
    f.focused = false; physicalMouse(f.guest); assert.equal(delivered().length, 1); f.focused = true;
    f.svc.guestDetach(f.id, f.guest.id);
    physicalMouse(f.guest); assert.equal(delivered().length, 1);
  });

  await check('shared browser session preserves the real engine user agent while removing the product token', () => {
    assert.equal(getBrowserSession(), browserSession);
    assert.equal(browserUserAgent, 'Mozilla/5.0 Chrome/150 Electron/43.7 Safari/537');
  });

  await check('an Electron-named app preserves its Electron token', () => {
    const nodeRequire = createRequire(import.meta.url);
    const originalName = globalThis[key].app.getName;
    const originalUserAgent = globalThis[key].session.defaultSession.getUserAgent;
    try {
      globalThis[key].app.getName = () => 'Electron';
      globalThis[key].session.defaultSession.getUserAgent = () => 'Mozilla/5.0 Chrome/150 Electron/43.7 Safari/537';
      delete nodeRequire.cache[nodeRequire.resolve(output)];
      nodeRequire(output).browserSession();
      assert.equal(browserUserAgent, 'Mozilla/5.0 Chrome/150 Electron/43.7 Safari/537');
    } finally {
      globalThis[key].app.getName = originalName;
      globalThis[key].session.defaultSession.getUserAgent = originalUserAgent;
    }
  });

  await check('the real user agent preserves Windows, macOS and Linux platform tokens', () => {
    const nodeRequire = createRequire(import.meta.url);
    const originalName = globalThis[key].app.getName;
    const originalUserAgent = globalThis[key].session.defaultSession.getUserAgent;
    try {
      globalThis[key].app.getName = () => 'Meta Agent';
      for (const platform of ['Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7', 'X11; Linux x86_64']) {
        globalThis[key].session.defaultSession.getUserAgent = () =>
          `Mozilla/5.0 (${platform}) MetaAgent/1.2 Chrome/150 Electron/43.7 Safari/537`;
        delete nodeRequire.cache[nodeRequire.resolve(output)];
        nodeRequire(output).browserSession();
        assert.equal(browserUserAgent,
          `Mozilla/5.0 (${platform}) Chrome/150 Electron/43.7 Safari/537`);
      }
    } finally {
      globalThis[key].app.getName = originalName;
      globalThis[key].session.defaultSession.getUserAgent = originalUserAgent;
    }
  });

  await check('the cleaned ASCII product token is stripped from the web page UA', () => {
    // 身份名 `Muster Console` 在 UA 里是 `MusterConsole/…`（见 test/user-agent-ascii.mjs），
    // 中文展示名「集序」只走界面词条，网页区两种令牌都不得看到。
    const nodeRequire = createRequire(import.meta.url);
    const originalName = globalThis[key].app.getName;
    const originalUserAgent = globalThis[key].session.defaultSession.getUserAgent;
    try {
      globalThis[key].app.getName = () => 'Muster Console';
      globalThis[key].session.defaultSession.getUserAgent = () =>
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MusterConsole/0.1.34 Chrome/150 Electron/43.7 Safari/537';
      delete nodeRequire.cache[nodeRequire.resolve(output)];
      nodeRequire(output).browserSession();
      assert.equal(browserUserAgent, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150 Electron/43.7 Safari/537');
    } finally {
      globalThis[key].app.getName = originalName;
      globalThis[key].session.defaultSession.getUserAgent = originalUserAgent;
    }
  });

  await check('CLI UI page reuses restored session tabs and never mounts a browser guest', async () => {
    const owner = { workspaceId: 'ws', sessionId: 'cli' };
    const f = setup({ urls: ['muster-ui://session/cli'], activeIdx: 0, owners: [owner] });
    const id = f.svc.openUiSession('cli', 'ws');
    assert.equal(f.svc.snapshot().tabs.length, 1);
    assert.equal(f.svc.openUiSession('cli', 'ws'), id);
    await assert.rejects(f.svc.ensureGuest(id), /capability_unsupported/);
    const other = f.svc.openUiSession('other', 'ws');
    assert.notEqual(other, id);
    f.svc.closeTab(id);
    assert.notEqual(f.svc.openUiSession('cli', 'ws'), id);
    assert.equal(f.svc.snapshot().tabs.length, 2);
  });

  await check('new tab pages stay internal until navigating to a real guest', async () => {
    const f = setup();
    const home = 'muster-home://new/test-home';
    const id = f.svc.createTab(home, { workspaceId: 'ws', sessionId: 'chat' });
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).title, '新建标签页');
    assert.equal(f.svc.guestAttach(id, new Guest().id).reason, 'internal-page');
    await assert.rejects(f.svc.ensureGuest(id), /capability_unsupported/);
    await f.svc.nav(id, 'refresh');
    const mounted = mountOnRequest(f);
    await f.svc.navigate(id, 'https://example.test/');
    assert.deepEqual(mounted.get(id).loads, ['https://example.test/']);
    const background = f.svc.createTab('https://other.test/', { workspaceId: 'ws', sessionId: 'chat' }, { background: true });
    assert.equal(f.svc.snapshot().activeId, id);
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === background).openInBackground, true);
  });

  await check('an empty user browser restores to a new tab page', async () => {
    const f = setup();
    const tab = f.svc.restore().tabs[0];
    assert.match(tab.url, /^muster-home:\/\/new\//);
    await assert.rejects(f.svc.ensureGuest(tab.id), /capability_unsupported/);
  });

  await check('bookmark icons are cached from the visited origin without credentials or redirects', async () => {
    const { svc, id, guest } = await nativePage('https://native.test/page');
    const requests = [];
    browserSession.fetch = async (url, options) => { requests.push({ url, options }); return new Response(new Uint8Array([1, 2, 3])); };
    guest.emit('page-favicon-updated', {}, ['https://native.test/favicon.png']);
    assert.equal(await svc.bookmarkFavicon(id), 'data:image/png;base64,ZmFrZQ==');
    assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.redirect, 'manual');
    guest.emit('page-favicon-updated', {}, ['https://other.test/icon.png']);
    assert.equal(await svc.bookmarkFavicon(id), null); assert.equal(requests.length, 1);
  });

  await check('bookmark icon fetch rejects redirects and oversized responses and ignores stale tabs', async () => {
    const { svc, id, guest } = await nativePage('https://native.test/page');
    guest.emit('page-favicon-updated', {}, ['https://native.test/favicon.png']);
    browserSession.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://other.test/icon.png' } });
    await assert.rejects(svc.bookmarkFavicon(id), /icon request failed/);
    browserSession.fetch = async () => new Response(new Uint8Array(256 * 1024 + 1));
    await assert.rejects(svc.bookmarkFavicon(id), /icon is too large/);
    const pending = deferred();
    browserSession.fetch = () => pending.promise;
    const result = svc.bookmarkFavicon(id);
    guest.commit('https://native.test/another-page');
    pending.resolve(new Response(new Uint8Array([1, 2, 3])));
    assert.equal(await result, null);
  });

  await check('lazy background shells share one renderer mount and preserve foreground selection', async () => {
    const f = setup({ urls: ['https://saved.test/'], activeIdx: 0 });
    const restored = f.svc.restore().tabs[0], id = f.svc.createTab('https://background.test/', {}, { background: true });
    assert.equal(f.svc.snapshot().activeId, restored.id);
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).openInBackground, true);
    assert.equal(guests.size, 0, 'restore/create only register shells');
    const mounted = mountOnRequest(f), [one, two] = await Promise.all([f.svc.ensureGuest(id), f.svc.ensureGuest(id)]);
    assert.equal(one, two); assert.equal(mounted.size, 1);
    assert.equal(one.getType(), 'webview'); assert.equal(one.hostWebContents.id, 101);
    assert.deepEqual(one.loads, ['https://background.test/']);
    assert.equal(f.sent.filter(event => event.channel === 'browser:mount-request').length, 1);
    assert.ok(!f.sent.some(event => event.channel === 'browser:focus-request'));
    assert.equal(f.svc.snapshot().activeId, restored.id); assert.equal(unexpectedWindows, 0);
  });
  await check('preparation is single-flight and cached per debugger session without foreground focus', async () => {
    const f = await nativePage();
    const second = f.svc.createTab('https://same.test/', {}, { background: true }), guest = await f.svc.ensureGuest(second);
    assert.notEqual(f.guest.id, guest.id); guest.commands.length = 0;
    await Promise.all([f.svc.prepareAgentInput(second), f.svc.prepareAgentInput(second)]);
    await f.svc.prepareAgentInput(second);
    for (const method of ['Page.enable', 'Network.enable', 'Page.setInterceptFileChooserDialog', 'Emulation.setFocusEmulationEnabled']) {
      assert.equal(guest.commands.filter(command => command.method === method).length, 1, method);
    }
    assert.deepEqual(guest.commands.at(-1), { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } });
    guest.debugger.detach(); await f.svc.prepareAgentInput(second);
    assert.equal(guest.commands.filter(command => command.method === 'Page.enable').length, 2);
    assert.equal(guest.focusCalls ?? 0, 0); assert.equal(f.focusCalls, 0);
    assert.equal(f.svc.snapshot().activeId, f.id);
    assert.ok(!f.sent.some(event => event.channel === 'browser:focus-request'));
  });
  await check('failed preparation is retried without replaying page actions', async () => {
    const { svc, id, guest } = await nativePage(); let attempts = 0;
    guest.onCommand = method => { if (method === 'Page.setInterceptFileChooserDialog' && ++attempts === 1) throw new Error('transient preparation'); };
    await assert.rejects(svc.prepareAgentInput(id), /transient preparation/); await svc.prepareAgentInput(id);
    assert.equal(attempts, 2); assert.ok(!guest.commands.some(command => command.method.startsWith('Input.')));
  });
  await check('native tabs expose no preview streaming or renderer input relay', async () => {
    const { svc, id, guest, sent } = await nativePage();
    assert.equal(typeof svc.executionPreview, 'undefined'); assert.equal(typeof svc.executionInput, 'undefined');
    assert.equal(guest.listenerCount('paint'), 0);
    guest.emit('paint', {}, {}, { toDataURL: () => assert.fail('native pages must not encode preview frames') });
    svc.setAgentBusy(id, true); svc.setAgentBusy(id, false);
    assert.ok(!sent.some(event => event.channel === 'browser:execution-frame'));
    assert.equal(svc.tabLive(id), true); assert.equal(unexpectedWindows, 0);
  });
  await check('agent and delayed file choosers stay intercepted and consume their hint once', async () => {
    const { svc, id, guest } = await nativePage(); await svc.prepareAgentInput(id);
    assert.ok(guest.commands.some(command => command.method === 'Page.setInterceptFileChooserDialog' && command.params.enabled));
    physicalMouse(guest); await svc.runOperation(id, () => chooser(guest));
    assert.equal(fileDialogs.length, 0, 'agent work clears earlier human intent');
    assert.match(svc.fileChooserNotice(id), /capability_unsupported/); assert.equal(svc.fileChooserNotice(id), null);
    chooser(guest); assert.equal(fileDialogs.length, 0); assert.match(svc.fileChooserNotice(id), /capability_unsupported/);
    assert.equal(svc.shouldOpenInBackground(guest.id), true);
  });
  await check('one foreground physical click uploads with the host dialog and cannot grant a second picker', async () => {
    const { svc, id, guest } = await nativePage(); await svc.prepareAgentInput(id);
    const selection = deferred(); dialogHandler = () => selection.promise;
    physicalMouse(guest); chooser(guest, 19, 'selectMultiple'); await tick();
    assert.equal(fileDialogs.length, 1); assert.equal(fileDialogs[0].parent.id, 1);
    assert.deepEqual(fileDialogs[0].options.properties, ['openFile', 'multiSelections']);
    chooser(guest); assert.equal(fileDialogs.length, 1);
    selection.resolve({ canceled: false, filePaths: ['C:\\uploads\\one.txt', 'C:\\uploads\\two.txt'] }); await tick();
    assert.deepEqual(guest.commands.find(command => command.method === 'DOM.setFileInputFiles').params,
      { backendNodeId: 19, files: ['C:\\uploads\\one.txt', 'C:\\uploads\\two.txt'] });
    physicalKey(guest); assert.equal(svc.shouldOpenInBackground(guest.id), false);
  });
  for (const condition of ['mouseUp', 'mouseMove', 'keyUp', 'expired', 'hidden-host', 'unfocused-host', 'other-tab']) {
    await check(condition + ' cannot grant native file chooser intent', async () => {
      const f = await nativePage(); await f.svc.prepareAgentInput(f.id); const originalNow = Date.now;
      try {
        if (condition === 'mouseUp' || condition === 'mouseMove') physicalMouse(f.guest, condition);
        else if (condition === 'keyUp') physicalKey(f.guest, condition);
        else {
          physicalMouse(f.guest);
          if (condition === 'expired') { const future = Date.now() + 2100; Date.now = () => future; }
          if (condition === 'hidden-host') f.visible = false;
          if (condition === 'unfocused-host') f.focused = false;
          if (condition === 'other-tab') f.svc.createTab('https://front.test/');
        }
        chooser(f.guest); assert.equal(fileDialogs.length, 0);
      } finally { Date.now = originalNow; }
    });
  }
  await check('agent execution refuses even a physical-event fixture dispatched inside its operation', async () => {
    const { svc, id, guest } = await nativePage(); await svc.prepareAgentInput(id);
    await svc.runOperation(id, () => { physicalMouse(guest); chooser(guest); });
    assert.equal(fileDialogs.length, 0); chooser(guest); assert.equal(fileDialogs.length, 0);
  });
  for (const lifecycle of ['close', 'replace', 'navigate']) {
    await check(lifecycle + ' rejects late native file selections and old-guest chooser events', async () => {
      const { svc, id, guest } = await nativePage(); await svc.prepareAgentInput(id);
      const selection = deferred(); dialogHandler = () => selection.promise;
      physicalKey(guest); chooser(guest, 23); await tick(); assert.equal(fileDialogs.length, 1);
      let replacement;
      if (lifecycle === 'close') svc.closeTab(id);
      else if (lifecycle === 'replace') { replacement = new Guest(); assert.equal(svc.guestAttach(id, replacement.id).ok, true); await tick(); }
      else await svc.navigate(id, 'https://another-document.test/');
      chooser(guest); assert.equal(fileDialogs.length, 1);
      selection.resolve({ canceled: false, filePaths: ['C:\\uploads\\late.txt'] }); await tick();
      assert.ok(!guest.commands.some(command => command.method === 'DOM.setFileInputFiles'));
      assert.ok(!replacement?.commands.some(command => command.method === 'DOM.setFileInputFiles'));
    });
  }
  await check('first navigation is single-owned; AI popups inherit ownership and leave the user selection intact', async () => {
    const f = setup(), owner = { workspaceId: 'project-b', sessionId: 'chat-b' }; mountOnRequest(f);
    const id = f.svc.createTab('https://old.test/', owner); await f.svc.navigate(id, 'https://new.test/');
    const guest = await f.svc.ensureGuest(id); assert.deepEqual(guest.loads, ['https://new.test/']);
    await f.svc.runOperation(id, () => guest.openHandler({ url: 'https://popup.test/', disposition: 'new-window' }));
    const child = f.svc.snapshot().tabs.find(tab => tab.url === 'https://popup.test/');
    assert.equal(child.workspaceId, owner.workspaceId); assert.equal(child.sessionId, owner.sessionId);
    assert.equal(child.openInBackground, true); assert.equal(f.svc.snapshot().activeId, id);
    assert.equal(guests.size, 1, 'popup remains a shell instead of cloning a live document');
    physicalKey(guest); guest.openHandler({ url: 'https://user-popup.test/', disposition: 'new-window' });
    const userChild = f.svc.snapshot().tabs.find(tab => tab.url === 'https://user-popup.test/');
    assert.equal(userChild.openInBackground, false); assert.equal(f.svc.snapshot().activeId, userChild.id);
  });
  await check('popup-style window.open rides a user gesture into a native popup; script popups stay tabs', async () => {
    const f = setup(); mountOnRequest(f);
    const id = f.svc.createTab('https://oauth.test/'); await f.svc.navigate(id, 'https://oauth.test/');
    const guest = await f.svc.ensureGuest(id);
    // 无手势的弹窗形态（脚本定时器弹窗）：维持既有转标签行为，不开原生窗口
    const denied = guest.openHandler({ url: 'https://spam.test/ad', disposition: 'new-window', features: 'width=360,height=240' });
    assert.equal(denied.action, 'deny');
    assert.ok(f.svc.snapshot().tabs.some(tab => tab.url === 'https://spam.test/ad'));
    // 用户手势后的 OAuth 弹窗（微信扫码形态：window.open 带窗口特征）：放行原生窗口，不建标签
    f.svc.activate(id); physicalMouse(guest);
    const allowed = guest.openHandler({ url: 'https://account.test/login/wechat', disposition: 'new-window', features: 'width=600,height=700,top=100,left=100' });
    assert.equal(allowed.action, 'allow');
    assert.ok(!f.svc.snapshot().tabs.some(tab => tab.url === 'https://account.test/login/wechat'));
    // 手势 + 无窗口特征的 window.open（普通新窗口语义）：仍走内置标签（既有体验不变）
    physicalKey(guest);
    const featureless = guest.openHandler({ url: 'https://plain.test/', disposition: 'new-window', features: '' });
    assert.equal(featureless.action, 'deny');
    assert.ok(f.svc.snapshot().tabs.some(tab => tab.url === 'https://plain.test/'));
    // 手势门控按标签隔离：从未有过手势的标签（脚本弹窗源头）拿不到原生窗口
    const spamTab = f.svc.snapshot().tabs.find(tab => tab.url === 'https://spam.test/ad');
    f.svc.activate(spamTab.id);
    const spamGuest = await f.svc.ensureGuest(spamTab.id);
    assert.equal(spamGuest.openHandler({ url: 'https://spam2.test/', disposition: 'new-window', features: 'width=300,height=200' }).action, 'deny');
  });
  await check('same-page FIFO preserves order while another page progresses; failure releases its lane', async () => {
    const f = await nativePage(), second = f.svc.createTab('https://two.test/', {}, { background: true });
    await f.svc.ensureGuest(second); const gate = deferred(), started = deferred(), events = [];
    const active = f.svc.runOperation(f.id, () => { events.push('a:start'); started.resolve(); return gate.promise; });
    const failed = assert.rejects(active, /first failed/); await started.promise;
    const next = f.svc.runOperation(f.id, () => events.push('a:next'));
    await f.svc.runOperation(second, () => events.push('b:independent'));
    assert.deepEqual(events, ['a:start', 'b:independent']); gate.reject(new Error('first failed')); await failed; await next;
    assert.deepEqual(events, ['a:start', 'b:independent', 'a:next']);
  });
  await check('closing a native tab cancels queued actions and leaves DOM teardown to the renderer', async () => {
    const { svc, id, guest } = await nativePage(); const gate = deferred(), started = deferred();
    const active = svc.runOperation(id, () => { started.resolve(); return gate.promise; }); await started.promise;
    let executed = false; const pending = svc.runOperation(id, () => { executed = true; }), cancelled = rejectsSoon(pending, /关闭|取消/);
    svc.closeTab(id); await cancelled;
    assert.equal(guest.isDestroyed(), false, 'an eager main close races the webview DOM teardown');
    assert.equal(guest.debugger.isAttached(), false); assert.equal(svc.tabLive(id), false); assert.equal(await svc.ensureGuest(id), null);
    guest.close(); gate.resolve('original-finished'); assert.equal(await active, 'original-finished');
    assert.equal(executed, false); await assert.rejects(svc.runOperation(id, () => {}), /关闭|换代/);
  });
  await check('destroyed guests cancel queued actions; replacement rejects stale events and retired attach', async () => {
    const { svc, id, guest: old } = await nativePage(); const gate = deferred(), started = deferred();
    const active = svc.runOperation(id, () => { started.resolve(); return gate.promise; }); await started.promise;
    let replayed = false; const pending = svc.runOperation(id, () => { replayed = true; }), cancelled = rejectsSoon(pending, /卸载|取消/);
    old.close(); await cancelled; const next = await svc.ensureGuest(id);
    assert.notEqual(old.id, next.id); assert.deepEqual(next.loads, ['https://native.test/']);
    assert.equal(svc.isCurrentGuest(id, old.id), false); assert.equal(svc.isCurrentGuest(id, next.id), true);
    old.url = 'https://stale.test/'; old.emit('did-navigate', {}, old.url); old.emit('console-message', { level: 'error', message: 'stale' });
    assert.equal(svc.snapshot().tabs.find(tab => tab.id === id).url, 'https://native.test/');
    assert.equal(svc.consoleEntries(id).length, 0); assert.equal(svc.guestAttach(id, old.id).ok, false);
    gate.resolve(); await active; assert.equal(replayed, false);
  });
  await check('viewport metrics survive native guest replacement and reset without creating a window', async () => {
    const { svc, id, guest: old } = await nativePage(); await svc.setViewport(id, 450, 720);
    old.close(); const next = await svc.ensureGuest(id); await tick();
    const metrics = next.commands.find(command => command.method === 'Emulation.setDeviceMetricsOverride');
    assert.equal(metrics.params.width, 450); assert.equal(metrics.params.height, 720);
    await svc.resetViewport(id); assert.equal(next.commands.at(-1).method, 'Emulation.clearDeviceMetricsOverride');
    assert.equal(unexpectedWindows, 0);
  });
  await check('a stale viewport ACK rejects after guest replacement without writing replacement metadata', async () => {
    const { svc, id, guest: old } = await nativePage(), ack = deferred(), started = deferred();
    old.onCommand = method => {
      if (method === 'Emulation.setDeviceMetricsOverride') { started.resolve(); return ack.promise; }
      return {};
    };
    const setting = svc.setViewport(id, 390, 844), rejected = assert.rejects(setting, /换代|取消/);
    await started.promise;
    const next = new Guest(); assert.equal(svc.guestAttach(id, next.id).ok, true); await tick();
    ack.resolve({}); await rejected;
    assert.equal(svc.tabs.get(id).viewportOverride, null, 'old ACK cannot record metrics for the new guest');
    assert.ok(!next.commands.some(command => command.method === 'Emulation.setDeviceMetricsOverride'));
    await svc.setViewport(id, 480, 800);
    assert.deepEqual(svc.tabs.get(id).viewportOverride, { width: 480, height: 800 });
    assert.equal(next.commands.find(command => command.method === 'Emulation.setDeviceMetricsOverride').params.width, 480);
  });
  await check('a stale reset ACK rejects without clearing viewport metadata reapplied to a replacement guest', async () => {
    const { svc, id, guest: old } = await nativePage(); await svc.setViewport(id, 450, 720);
    const ack = deferred(), started = deferred();
    old.onCommand = method => {
      if (method === 'Emulation.clearDeviceMetricsOverride') { started.resolve(); return ack.promise; }
      return {};
    };
    const resetting = svc.resetViewport(id), rejected = assert.rejects(resetting, /换代|取消/);
    await started.promise;
    const next = new Guest(); assert.equal(svc.guestAttach(id, next.id).ok, true); await tick();
    ack.resolve({}); await rejected;
    assert.deepEqual(svc.tabs.get(id).viewportOverride, { width: 450, height: 720 });
    assert.equal(next.commands.find(command => command.method === 'Emulation.setDeviceMetricsOverride').params.width, 450);
    assert.ok(!next.commands.some(command => command.method === 'Emulation.clearDeviceMetricsOverride'));
    await svc.resetViewport(id); assert.equal(svc.tabs.get(id).viewportOverride, null);
    assert.equal(next.commands.at(-1).method, 'Emulation.clearDeviceMetricsOverride');
  });
  await check('a failed viewport reset preserves the applied metrics and reports the protocol error', async () => {
    const { svc, id, guest } = await nativePage(); await svc.setViewport(id, 450, 720);
    guest.onCommand = method => {
      if (method === 'Emulation.clearDeviceMetricsOverride') throw new Error('metrics session unavailable');
      return {};
    };
    await assert.rejects(svc.resetViewport(id), /视口恢复失败.*metrics session unavailable/);
    assert.deepEqual(svc.tabs.get(id).viewportOverride, { width: 450, height: 720 });
    guest.onCommand = null; await svc.resetViewport(id); assert.equal(svc.tabs.get(id).viewportOverride, null);
  });
  await check('shutdown closes native guests and cancels queued page mutations', async () => {
    const { svc, id, guest } = await nativePage(), second = svc.createTab('https://two.test/', {}, { background: true });
    const other = await svc.ensureGuest(second), gate = deferred(), started = deferred();
    const active = svc.runOperation(id, () => { started.resolve(); return gate.promise; }); await started.promise;
    const pending = svc.runOperation(id, () => {}), cancelled = rejectsSoon(pending, /关闭|取消/);
    svc.stop(); await cancelled; assert.equal(guest.isDestroyed(), true); assert.equal(other.isDestroyed(), true);
    assert.equal(unexpectedWindows, 0); gate.resolve(); await active;
  });

  await check('tool creation before renderer restore neither duplicates saved shells nor creates an extra blank', async () => {
    const { svc } = setup({ urls: ['https://saved.test/'], activeIdx: 0 });
    const id = svc.createTab('https://tool.test/');
    assert.deepEqual(svc.restore().tabs.map(tab => tab.url), ['https://saved.test/', 'https://tool.test/']);
    assert.equal(svc.snapshot().activeId, id);
    svc.restore(); assert.equal(svc.snapshot().tabs.length, 2);
  });
  await check('inspecting an existing tab never restores or creates a default tab', async () => {
    const { svc, sent } = setup({ urls: ['https://saved.test/'], activeIdx: 0 });
    assert.equal(svc.inspectExistingTab('bt1'), null);
    assert.equal(sent.length, 0);
    const restored = svc.restore().tabs;
    assert.equal(restored.length, 1);
    assert.equal(svc.inspectExistingTab(restored[0].id).url, 'https://saved.test/');
    const current = svc.snapshot();
    svc.inspectExistingTab('missing');
    assert.deepEqual(svc.snapshot(), current);
  });
  await check('mediation identity invalidates on navigation, process and ownership changes', async () => {
    const fixture = setup(); mountOnRequest(fixture);
    const url = 'https://example.test/path?secret=do-not-expose';
    const id = fixture.svc.createTab(url, { workspaceId: 'project-a', sessionId: 'chat-a', scope: 'session' }, { background: true });
    const guest = await fixture.svc.ensureGuest(id);
    guest.mainFrame.framesInSubtree = [{}]; // Electron may expose a different wrapper for the same frame.
    const first = fixture.svc.captureMediationTarget(id);
    assert.equal(first.target.appId, 'browser:https://example.test');
    assert.equal(JSON.stringify(first.target).includes('do-not-expose'), false);
    assert.equal(first.isCurrent(), true);
    const frame = {};
    guest.emit('frame-created', {}, { frame }); guest.mainFrame.framesInSubtree.push(frame);
    assert.equal(first.isCurrent(), false);
    assert.throws(() => fixture.svc.captureMediationTarget(id), /subframes/);
    guest.mainFrame.framesInSubtree.pop();
    assert.equal(first.isCurrent(), false, 'a transient subframe must not revive an earlier target');
    const beforeNavigation = fixture.svc.captureMediationTarget(id);
    guest.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: true });
    assert.equal(beforeNavigation.isCurrent(), false, 'same-document navigation also invalidates the old target');
    assert.throws(() => fixture.svc.captureMediationTarget(id), /navigating/);
    guest.emit('did-navigate-in-page', {}, url, true);
    const sameDocument = fixture.svc.captureMediationTarget(id);
    guest.emit('did-start-navigation', {}, url, false, true);
    assert.equal(sameDocument.isCurrent(), false, 'same-URL reload invalidates the old document');
    assert.throws(() => fixture.svc.captureMediationTarget(id), /navigating/);
    guest.emit('dom-ready');
    const next = fixture.svc.captureMediationTarget(id);
    assert.equal(next.target.surfaceId, first.target.surfaceId);
    assert.notEqual(next.target.surfaceGeneration, first.target.surfaceGeneration);
    guest.processId = guest.getOSProcessId() + 1;
    assert.equal(next.isCurrent(), false, 'guest process changes invalidate the target');
    const processChanged = fixture.svc.captureMediationTarget(id);
    fixture.svc.setOwner(id, { workspaceId: 'project-b', sessionId: 'chat-b', scope: 'session' });
    assert.equal(processChanged.isCurrent(), false, 'ownership changes invalidate the target');
  });
  await check('browser tab owners survive restore and popup children inherit their parent', async () => {
    const owner = { workspaceId: 'project-a', sessionId: 'chat-a' };
    const { svc } = setup({ urls: ['https://saved.test/'], owners: [owner], activeIdx: 0 });
    const restored = svc.restore().tabs[0];
    assert.equal(restored.workspaceId, owner.workspaceId); assert.equal(restored.sessionId, owner.sessionId);
    const id = svc.createTab('https://new.test/', { workspaceId: 'project-b', sessionId: 'chat-b' });
    assert.equal(svc.snapshot().tabs.find(tab => tab.id === id).workspaceId, 'project-b');
    const guest = new Guest(); svc.guestAttach(id, guest.id); await tick();
    guest.openHandler({ url: 'https://popup.test/', disposition: 'new-window' });
    const child = svc.snapshot().tabs.find(tab => tab.url === 'https://popup.test/');
    assert.equal(child.workspaceId, 'project-b'); assert.equal(child.sessionId, 'chat-b');
  });
  await check('popup inherits the latest workspace or session owner after pin changes', async () => {
    const { svc } = setup();
    const id = svc.createTab('https://owner.test/', { workspaceId: 'project-a', sessionId: 'chat-a', scope: 'workspace' });
    const guest = new Guest(); svc.guestAttach(id, guest.id); await tick();
    guest.openHandler({ url: 'https://shared-child.test/', disposition: 'new-window' });
    const shared = svc.snapshot().tabs.find(tab => tab.url === 'https://shared-child.test/');
    assert.equal(shared.scope, 'workspace'); assert.equal(shared.openerId, id);
    assert.equal(svc.setOwner(id, { workspaceId: 'project-a', sessionId: 'chat-b', scope: 'session' }), true);
    guest.openHandler({ url: 'https://session-child.test/', disposition: 'new-window' });
    const sessionChild = svc.snapshot().tabs.find(tab => tab.url === 'https://session-child.test/');
    assert.equal(sessionChild.scope, 'session'); assert.equal(sessionChild.sessionId, 'chat-b'); assert.equal(sessionChild.openerId, id);
  });
  await check('cold mount replays the inventory when the first consumer is absent; concurrent requests share a guest', async () => {
    const f = setup(), id = f.svc.createTab('https://cold.test/'), guest = new Guest();
    let requests = 0;
    f.onSend = (channel, payload) => {
      if (channel === 'browser:mount-request' && payload.tabId === id && ++requests === 2) {
        assert.equal(f.sent.at(-2).channel, 'browser:tabs');
        assert.equal(f.svc.guestAttach(id, guest.id).ok, true);
      }
    };
    const both = await Promise.all([f.svc.ensureGuest(id), f.svc.ensureGuest(id)]);
    assert.deepEqual(both, [guest, guest]); assert.equal(requests, 2);
    assert.deepEqual(guest.loads, ['https://cold.test/']);
  });
  await check('first navigate of an unmounted shell performs one load; duplicate attach retains listeners and buffers', async () => {
    const f = setup(), id = f.svc.createTab('https://old.test/'), guest = new Guest();
    f.onSend = (channel, payload) => { if (channel === 'browser:mount-request' && payload.tabId === id) f.svc.guestAttach(id, guest.id); };
    await f.svc.navigate(id, 'https://new.test/');
    assert.deepEqual(guest.loads, ['https://new.test/']);
    guest.emit('console-message', { level: 'info', message: 'keep-console' });
    assert.equal(f.svc.guestAttach(id, guest.id).ok, true);
    assert.equal(guest.listenerCount('console-message'), 1);
    assert.equal(f.svc.consoleEntries(id)[0].text, 'keep-console');
    assert.equal(guest.loads.length, 1);
  });
  await check('dom-ready releases observation without waiting for hanging subresources', async () => {
    const f = setup(), id = f.svc.createTab('https://ready.test/'), guest = new Guest(); guest.autoLoad = false;
    f.svc.guestAttach(id, guest.id); await tick();
    let ready = false;
    const waiting = f.svc.ensureGuest(id).then(wc => { ready = true; return wc; });
    await tick(); assert.equal(ready, false);
    guest.commit('https://ready.test/');
    assert.equal(await waiting, guest);
    guest.loadGates[0].resolve(); await tick();
  });
  await check('old document dom-ready cannot release or overwrite a newer navigation', async () => {
    const f = setup(), id = f.svc.createTab('about:blank'), guest = new Guest(); guest.autoLoad = false;
    f.svc.guestAttach(id, guest.id);
    const first = f.svc.navigate(id, 'https://old.test/');
    const firstResult = first.then(() => null, error => error);
    await tick();
    const second = f.svc.navigate(id, 'https://latest.test/'); await tick();
    let ready = false;
    const waiting = f.svc.ensureGuest(id).then(wc => { ready = true; return wc; });
    guest.commit('https://old.test/'); await tick();
    assert.equal(ready, false);
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).url, 'https://latest.test/');
    guest.commit('https://latest.test/'); assert.equal(await waiting, guest);
    guest.loadGates[1].resolve(); await second;
    guest.loadGates[0].resolve(); assert.match(String(await firstResult), /替代/);
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).url, 'https://latest.test/');
  });
  await check('guest replacement rejects stale callbacks, reports and an in-flight guest preparation', async () => {
    const f = setup(), id = f.svc.createTab('about:blank'), old = new Guest(), next = new Guest();
    f.svc.guestAttach(id, old.id);
    const preparation = deferred();
    old.onCommand = method => method === 'Page.setInterceptFileChooserDialog' ? preparation.promise : {};
    const preparing = f.svc.prepareAgentInput(id), rejected = assert.rejects(preparing, /换代/);
    await tick(); f.svc.guestAttach(id, next.id); preparation.resolve({}); await rejected;
    old.url = 'https://stale.test/'; old.emit('did-navigate', {}, old.url);
    old.emit('console-message', { level: 'info', message: 'stale' });
    old.debugger.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'stale', request: { url: old.url } });
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).url, 'about:blank');
    assert.equal(f.svc.consoleEntries(id).length, 0);
    assert.equal(f.svc.guestAttach(id, old.id).ok, false);
    assert.equal(f.svc.isCurrentGuest(id, next.id), true);
  });
  await check('native guest replacement cancels queued mutations before they can target the new guest', async () => {
    const f = setup(), id = f.svc.createTab('about:blank'), old = new Guest(), next = new Guest();
    f.svc.guestAttach(id, old.id);
    const gate = deferred(), started = deferred();
    const active = f.svc.runOperation(id, () => { started.resolve(); return gate.promise; });
    await started.promise;
    let executed = false;
    const pending = f.svc.runOperation(id, () => { executed = true; });
    const cancelled = rejectsSoon(pending, /换代|取消/);
    f.svc.guestAttach(id, next.id);
    await cancelled;
    gate.resolve(); await active;
    assert.equal(executed, false);
  });
  await check('old foreground-focus APIs fail closed and never send a renderer request', async () => {
    const f = setup(), id = f.svc.createTab('about:blank'), guest = new Guest(); f.svc.guestAttach(id, guest.id);
    await assert.rejects(f.svc.requestGuestFocus(id), /capability_unsupported/);
    assert.ok(!f.sent.some(event => event.channel === 'browser:focus-request'));
    assert.equal(guest.focusCalls ?? 0, 0); assert.equal(f.focusCalls, 0);
    assert.equal(typeof f.svc.guestFocus, 'undefined');
    const request = { requestId: 'stale', tabId: id, webContentsId: guest.id };
    assert.equal(f.svc.ackGuestFocus({ ...request, focused: true }, 999), false);
    assert.equal(f.svc.ackGuestFocus({ ...request, webContentsId: 999, focused: true }, 101), false);
    assert.equal(f.svc.ackGuestFocus({ ...request, focused: true }, 101), false);
  });
  await check('legacy reveal requests do not mount, activate, or reveal a cold background tab', async () => {
    const f = setup(), foreground = f.svc.createTab('https://user.test/');
    const id = f.svc.createTab('https://background.test/', {}, { background: true }), sent = f.sent.length;
    await assert.rejects(f.svc.requestGuestFocus(id, true), /capability_unsupported/);
    assert.equal(f.sent.length, sent); assert.equal(guests.size, 0);
    assert.equal(f.svc.snapshot().activeId, foreground); assert.equal(f.focusCalls, 0);
  });
  await check('wheel preserves CSS viewport hit coordinates and both axes; invalid input is rejected', async () => {
    const f = setup(), id = f.svc.createTab('about:blank'), guest = new Guest(); f.svc.guestAttach(id, guest.id);
    assert.equal(await f.svc.wheelForward(id, { tabId: id, x: 140, y: 160, deltaX: 260, deltaY: 320 }), true);
    assert.deepEqual(guest.commands.at(-1), { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 140, y: 160, deltaX: 260, deltaY: 320 } });
    const count = guest.commands.length;
    assert.equal(await f.svc.wheelForward(id, { tabId: id, x: NaN, y: 0, deltaX: 0, deltaY: 1 }), false);
    assert.equal(guest.commands.length, count);
  });
  await check('give-up survives guest replacement; Retry loads the saved URL instead of blank', async () => {
    const f = setup(), id = f.svc.createTab('https://crash.test/'), old = new Guest();
    f.svc.guestAttach(id, old.id); await tick();
    for (let n = 0; n < 5; n++) old.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).crashed, true);
    const replacement = new Guest(); replacement.url = '';
    f.svc.guestAttach(id, replacement.id); await tick();
    assert.deepEqual(replacement.loads, [], 'replacement must respect the exhausted recovery budget');
    await assert.rejects(f.svc.ensureGuest(id), /崩溃/);
    assert.equal(await f.svc.retryCrash(id), true);
    assert.deepEqual(replacement.loads, ['https://crash.test/']);
    assert.equal(replacement.reloads, 0, 'reloading about:blank would not restore the page');
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).crashed, false);
  });
  await check('explicit navigation clears give-up and starts a new crash budget', async () => {
    const f = setup(), id = f.svc.createTab('https://crash.test/'), guest = new Guest();
    f.svc.guestAttach(id, guest.id); await tick();
    for (let n = 0; n < 5; n++) guest.emit('render-process-gone', {}, { reason: 'crashed' });
    await f.svc.navigate(id, 'https://new.test/');
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).crashed, false);
    guest.emit('render-process-gone', {}, { reason: 'crashed' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(guest.reloads, 1, 'new navigation must receive the initial immediate retry');
  });
  await check('explicit navigation cancels the previous document recovery timer', async () => {
    const f = setup(), id = f.svc.createTab('https://crash.test/'), guest = new Guest();
    f.svc.guestAttach(id, guest.id); await tick();
    for (let n = 0; n < 3; n++) guest.emit('render-process-gone', {}, { reason: 'crashed' });
    await f.svc.navigate(id, 'https://new.test/');
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal(guest.reloads, 0, 'old backoff must not reload the new document');
    assert.deepEqual(guest.loads, ['https://crash.test/', 'https://new.test/']);
  });
  await check('toolbar refresh explicitly retries give-up on the original guest and preserves its URL', async () => {
    const f = setup(), id = f.svc.createTab('https://crash.test/'), guest = new Guest();
    f.svc.guestAttach(id, guest.id); await tick();
    for (let n = 0; n < 5; n++) guest.emit('render-process-gone', {}, { reason: 'crashed' });
    await f.svc.nav(id, 'refresh');
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).crashed, false);
    assert.equal(guest.reloads, 1);
    assert.deepEqual(guest.loads, ['https://crash.test/'], 'original guest must reload without replacing history');
  });
  for (const method of ['nav', 'navActive']) {
    for (const dir of ['back', 'forward']) {
      await check(method + ' ' + dir + ' leaves give-up through an explicit history navigation', async () => {
        const f = setup(), id = f.svc.createTab('https://crash.test/'), guest = new Guest();
        f.svc.guestAttach(id, guest.id); await tick();
        guest.navigationHistory = { ...guest.navigationHistory, canGoBack: () => true, canGoForward: () => true,
          goBack: () => guest.commit('https://back.test/'), goForward: () => guest.commit('https://forward.test/') };
        for (let n = 0; n < 5; n++) guest.emit('render-process-gone', {}, { reason: 'crashed' });
        if (method === 'nav') await f.svc.nav(id, dir); else await f.svc.navActive(dir);
        assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).crashed, false);
        assert.equal(guest.url, 'https://' + dir + '.test/');
      });
    }
  }
  await check('panel replay navigates to a different native position at the same URL without loadURL', async () => {
    const f = setup(), url = 'https://history.test/';
    const owner = { workspaceId: 'ws', sessionId: 'chat', scope: 'session' };
    const id = f.svc.createTab(url, owner), guest = new Guest();
    const entries = [{ url, title: 'First', pageState: 'first' }, { url, title: 'Second', pageState: 'second' }];
    let index = 0, length = 1;
    guest.navigationHistory = {
      ...guest.navigationHistory,
      getActiveIndex: () => index,
      getAllEntries: () => entries.slice(0, length),
      getEntryAtIndex: index => index < length ? entries[index] : null,
      goToIndex: next => {
        index = next;
        guest.emit('did-navigate-in-page', {}, url, true);
      }
    };
    f.svc.guestAttach(id, guest.id);
    await tick();
    const home = f.svc.restore().tabs.find(tab => tab.id === id);
    assert.ok(home.panelHistoryKey);
    assert.equal(f.svc.snapshot().tabs.find(tab => tab.id === id).panelHistoryKey, undefined);
    length = 2;
    guest.navigationHistory.goToIndex(1);
    const detail = f.svc.restore().tabs.find(tab => tab.id === id);
    assert.notEqual(detail.panelHistoryKey, home.panelHistoryKey);
    const restored = await f.svc.replayPanelHistory({ ...owner, browserId: id, requestId: 'replay',
      url, historyKey: home.panelHistoryKey });
    assert.equal(restored.id, id);
    assert.equal(index, 0);
    assert.equal(restored.panelHistoryKey, home.panelHistoryKey);
    assert.equal(restored.panelHistoryUserNavigation, false);
    entries[1] = { ...entries[1], pageState: 'updated while traversing' };
    const forward = await f.svc.replayPanelHistory({ ...owner, browserId: id, requestId: 'forward',
      url, historyKey: detail.panelHistoryKey });
    assert.equal(forward.id, id);
    assert.equal(index, 1);
    assert.deepEqual(guest.loads, [url]);
  });
  await check('did-fail-load and loadURL failures enter terminal error state while toolbar refresh/back/forward still recover', async () => {
    const f = setup(), id = f.svc.createTab('https://unreachable.herokuapp.test/'), guest = new Guest();
    guest.autoLoad = false;
    f.svc.guestAttach(id, guest.id);
    await tick();
    const waiting = f.svc.ensureGuest(id);
    guest.emit('did-fail-load', {}, -118, 'ERR_CONNECTION_TIMED_OUT', 'https://unreachable.herokuapp.test/', true);
    guest.loadGates[0].reject(new Error('ERR_CONNECTION_TIMED_OUT (-118)'));
    await assert.rejects(waiting, /页面加载失败.*ERR_CONNECTION_TIMED_OUT/);
    // Subsequent ensureGuest calls must immediately report the failure reason without waiting 8s
    await assert.rejects(f.svc.ensureGuest(id), /页面加载失败.*ERR_CONNECTION_TIMED_OUT/);

    // Toolbar refresh must still reach guest.reload() and clear the terminal failure state
    await f.svc.nav(id, 'refresh');
    assert.equal(guest.reloads, 1);
    assert.equal(await f.svc.ensureGuest(id), guest);

    // Simulate another DNS failure and verify back/forward also work after load failure
    guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://unreachable.herokuapp.test/', true);
    await assert.rejects(f.svc.ensureGuest(id), /ERR_NAME_NOT_RESOLVED/);
    let wentBack = 0, wentForward = 0;
    guest.navigationHistory = {
      ...guest.navigationHistory,
      canGoBack: () => true,
      canGoForward: () => true,
      goBack: () => { wentBack++; guest.commit('https://prev.test/'); },
      goForward: () => { wentForward++; guest.commit('https://next.test/'); }
    };
    await f.svc.nav(id, 'back');
    assert.equal(wentBack, 1);
    assert.equal(await f.svc.ensureGuest(id), guest);

    guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://next.test/', true);
    await f.svc.nav(id, 'forward');
    assert.equal(wentForward, 1);
    assert.equal(await f.svc.ensureGuest(id), guest);
  });
  await check('manual preload dialogs wait for a reply, preserve empty input, and clean up on navigation', async () => {
    const { svc, id, guest } = await nativePage();
    const watch = svc.waitForDialog(id);
    const evt = { sender: { id: guest.id }, returnValue: undefined };
    ipcMain.emit('browser:js-dialog', evt, { type: 'prompt', message: 'sync-prompt', defaultValue: 'answer' });
    await watch.promise; watch.cancel();
    const list = svc.pendingDialogs(id);
    assert.equal(list.length, 1);
    assert.equal(list[0].message, 'sync-prompt');
    assert.equal(evt.returnValue, undefined);
    assert.equal(await svc.dialogAnswer(id, list[0].id, true, ''), true);
    assert.deepEqual(evt.returnValue, { accepted: true, value: '' });
    assert.equal(await svc.dialogAnswer(id, list[0].id, true), false);
    const old = { sender: { id: guest.id }, returnValue: undefined };
    ipcMain.emit('browser:js-dialog', old, { type: 'confirm' });
    await svc.navigate(id, 'https://native.test/next');
    assert.deepEqual(old.returnValue, { accepted: false, value: null });
    assert.deepEqual(svc.pendingDialogs(id), []);
  });
  await check('externally closed native dialogs expire and an unsuccessful CDP reply is reported', async () => {
    const { svc, id, guest } = await nativePage();
    guest.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'native' });
    const [dialog] = svc.pendingDialogs(id);
    guest.debugger.emit('message', {}, 'Page.javascriptDialogClosed', {});
    assert.equal(await svc.dialogAnswer(id, dialog.id, true), false);
    guest.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'native' });
    guest.onCommand = method => {
      if (method === 'Page.handleJavaScriptDialog') throw new Error('No dialog is showing');
    };
    await assert.rejects(svc.dialogAnswer(id, '', true), /No dialog is showing/);
    assert.deepEqual(svc.pendingDialogs(id), []);
  });
  await check('guest pointer movement is scoped to one debugger and carries no pressed buttons', async () => {
    const { svc, id, guest } = await nativePage();
    await svc.moveGuestPointer(id, { x: 10.5, y: 42 });
    assert.deepEqual(guest.commands.at(-1), {
      method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10.5, y: 42, button: 'none', buttons: 0 }
    });
    const move = deferred();
    guest.onCommand = () => move.promise;
    const pending = svc.moveGuestPointer(id, { x: 10.5, y: 42 });
    svc.guestDetach(id, guest.id);
    move.resolve();
    await assert.rejects(pending, /关闭或换代/);
    await assert.rejects(svc.moveGuestPointer(id, { x: 10.5, y: 42 }), /尚未挂载/);
  });
  console.log(`browser-tab-lifecycle: ${passed} regression cases passed`);
} finally {
  service?.stop();
  if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
  assert.equal(path.dirname(path.resolve(tmp)), path.join(root, '.tmp'));
  assert.ok(path.basename(tmp).startsWith('browser-tab-lifecycle-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
