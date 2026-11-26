/** Production BrowserAgentTools regression: authoritative guest identity, lazy readiness,
 * background semantic isolation, per-page mutation ordering and navigation failure propagation.
 * Only Electron/Playwright/CDP transport leaves are fixtures; no running app or browser needed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'browser-agent-tools-identity-'));
const require = createRequire(import.meta.url);
const globalKey = '__browserAgentToolsIdentityFixture';
const previousFixture = globalThis[globalKey];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok ${passed} - ${name}`); };
const queueFile = path.join(tmp, 'page-queue.cjs');
await build({ entryPoints: [path.join(root, 'src/main/browser/pageOperationQueue.ts')], outfile: queueFile,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { BrowserPageOperationQueue } = require(queueFile);
const helpFile = path.join(tmp, 'browser-help.cjs');
await build({ entryPoints: [path.join(root, 'src/main/browser/browserHelp.ts')], outfile: helpFile,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { browserToolHelp } = require(helpFile);

function fixture() {
  const events = [], focusStarted = deferred();
  const f = {
    events, focusStarted, pages: [], openSessions: 0, connected: 0,
    known: ['A', 'B'], guestAvailable: true, guestDestroyed: false, currentGuestId: 42,
    guestGate: null, focusGate: null, actionGate: null, navigationGate: null,
    probeError: null, probeGate: null, actionError: null, focusError: null, navigationError: null, nativeTargetId: 'target-B', targetQueryError: null,
    activeId: 'B', selectorError: null, mouseMoveErrorAt: null, mouseMoves: 0
  };
  const recordAction = async (name, value) => {
    events.push({ event: 'action', name, value });
    if (f.actionError) throw f.actionError;
    if (f.actionGate) await f.actionGate.promise;
  };
  const nativeAction = name => {
    events.push({ event: 'native-api', name });
    throw new Error(`Forbidden native action: ${name}`);
  };
  const context = {
    pages: () => f.pages,
    cookies: async () => [{ name: 'fixture', value: 'value' }],
    addCookies: async list => { events.push({ event: 'add-cookies', cookies: list }); },
    clearCookies: async () => { events.push({ event: 'clear-cookies' }); },
    async newCDPSession(page) {
      events.push({ event: 'attach-session', target: page.target });
      if (page.attachError) throw page.attachError;
      f.openSessions++;
      return {
        async send(method) {
          assert.equal(method, 'Target.getTargetInfo');
          if (page.targetError) throw page.targetError;
          return { targetInfo: { targetId: page.target } };
        },
        async detach() {
          f.openSessions--;
          events.push({ event: 'detach-session', target: page.target });
          page.onDetach?.();
          if (page.detachError) throw page.detachError;
        }
      };
    }
  };
  const page = (id, marker, extra = {}) => ({
    target: `target-${id}`, marker,
    // The same URL and deliberately incorrect markers would fool the old mapper.
    url: () => 'https://same.test/', context: () => context,
    on: () => {},
    evaluate: async (expression, arg) => {
      if (expression === '0') {
        events.push({ event: 'probe', id });
        if (f.probeError) throw f.probeError;
        if (f.probeGate) await f.probeGate.promise;
        return 0;
      }
      if (expression === 'window.__maBrowserTab') return marker;
      if (expression?.name === 'performSemanticCoordinateClick') {
        await recordAction('coordinate-click', arg);
        return f.coordinateResult ?? { ok: true };
      }
      await recordAction(typeof expression === 'function' ? 'scroll' : 'storage', id);
      return 'stored-value';
    },
    evaluateHandle: async () => {
      const state = {
        geometry: { width: 800, height: 600, visibleWidth: 800, visibleHeight: 600, viewportScale: 1, scale: 1 },
        scroll: point => point, position: () => ({ x: 0, y: 0 }), restore: () => {}
      };
      return { evaluate: async (fn, arg) => fn(state, arg), dispose: async () => {} };
    },
    ariaSnapshot: async () => { await recordAction('snapshot', id); return '- textbox "Input" [ref=e1]'; },
    screenshot: async () => { await recordAction('screenshot', id); return Buffer.from('fixture-png'); },
    waitForSelector: async () => recordAction('wait', id),
    locator: selector => ({
      elementHandle: async () => ({
        ownerFrame: async () => ({ url: () => 'https://frame.test/' }),
        evaluate: async () => !f.uploadDetached,
        setInputFiles: async (files, options) => { events.push({ event: 'set-input-files', selector, files, options }); await recordAction('upload', id); },
        dispose: async () => {}
      }),
      evaluate: async (_fn, request, options) => {
        events.push({ event: 'semantic-locator', selector, options });
        if (f.opensFileChooser && request.action === 'click') f.fileChooserBlocked = true;
        await recordAction(request.action, request.action === 'fill' ? { id, text: request.text } : id);
        return f.semanticResult ?? { ok: true };
      },
      count: async () => {
        events.push({ event: 'selector-check', selector });
        if (f.selectorError) throw f.selectorError;
        return 1;
      },
      boundingBox: async () => ({ x: 10, y: 20, width: 30, height: 40 }),
      click: async () => nativeAction('locator.click'),
      fill: async () => nativeAction('locator.fill'),
      selectOption: async () => nativeAction('locator.selectOption'),
      hover: async () => nativeAction('locator.hover'),
      dragTo: async () => nativeAction('locator.dragTo')
    }),
    mouse: {
      move: async (x, y) => {
        nativeAction('mouse.move');
      },
      down: async () => nativeAction('mouse.down'),
      up: async () => nativeAction('mouse.up')
    },
    keyboard: { press: async () => nativeAction('keyboard.press') },
    ...extra
  });
  f.pages = [page('A', 'B'), page('B', 'A')];
  f.makePage = page;
  f.browser = { isConnected: () => true, contexts: () => [context],
    close: async () => { events.push({ event: 'disconnect' }); f.probeError = null; f.onDisconnect?.(); } };
  f.guest = {
    id: 42,
    isDestroyed: () => f.guestDestroyed,
    getOrCreateDevToolsTargetId: () => {
      events.push({ event: 'guest-target' });
      if (f.targetQueryError) throw f.targetQueryError;
      return f.nativeTargetId;
    }
  };
  f.tabs = {
    runOperation: (() => { const queue = new BrowserPageOperationQueue(); return (id, op) => queue.run(id, op); })(),
    createTab: (_url, owner, options) => { const id = `new-${f.known.length}`; f.known.push(id); events.push({ event: 'open', id, owner, options }); return id; },
    snapshot: () => ({ activeId: f.activeId, tabs: f.known.map(id => ({ id, url: 'https://same.test/' })) }),
    activate: id => { f.activeId = id; events.push({ event: 'activate', id }); },
    ensureGuest: async id => {
      events.push({ event: 'ensure-guest', id });
      if (f.guestGate) await f.guestGate.promise;
      events.push({ event: 'guest-ready', id });
      return f.guestAvailable ? f.guest : null;
    },
    cdpPort: async () => 1,
    isCurrentGuest: (id, guestId) => f.known.includes(id) && f.guestAvailable && !f.guestDestroyed && f.currentGuestId === guestId,
    guestFocus: id => events.push({ event: 'legacy-focus', id }),
    setAgentBusy: (id, busy) => events.push({ event: 'busy', id, busy }),
    fileChooserNotice: () => { if (!f.fileChooserBlocked) return null; f.fileChooserBlocked = false; return '请在前台手动选择文件'; },
    requestGuestFocus: () => { throw new Error('must never request host focus'); },
    prepareAgentInput: async (id) => {
      events.push({ event: 'prepare-input', id }); focusStarted.resolve();
      if (f.focusError) throw f.focusError;
      if (f.focusGate) await f.focusGate.promise;
      events.push({ event: 'input-ready', id });
    },
    pendingDialogs: () => [], consoleEntries: () => [],
    navigate: async (id, input) => {
      events.push({ event: 'navigate', id, input });
      if (f.navigationGate) await f.navigationGate.promise;
      if (f.navigationError) throw f.navigationError;
    }
  };
  f.window = { webContents: { send: (channel, value) => events.push({ event: 'status', channel, value }) } };
  globalThis[globalKey] = f;
  return f;
}

try {
  const output = path.join(tmp, 'agent-tools.cjs');
  await build({
    entryPoints: [path.join(root, 'src/main/browser/agentTools.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'agent-tool-transport-leaves', setup(bundler) {
      bundler.onResolve({ filter: /^playwright-core$/ }, () => ({ path: 'playwright', namespace: 'fixture' }));
      bundler.onResolve({ filter: /\/cdpTypeProxy$/ }, args => args.importer.endsWith('agentTools.ts') ? ({ path: 'proxy', namespace: 'fixture' }) : null);
      bundler.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'playwright'
        ? `export const chromium={connectOverCDP:async()=>{const f=globalThis.${globalKey};f.connected++;f.events.push({event:'connect'});return f.browser;}};`
        : `export async function startCdpTypeProxy(){return {port:1,stats:()=>({}),close:async()=>{}};}` }));
    } }]
  });
  const { BrowserAgentTools } = require(output);
  const make = f => new BrowserAgentTools(f.tabs, () => f.window, tmp);

  await check('target identity wins over forged markers and duplicate URLs; all sessions detach', async () => {
    const f = fixture(), tool = make(f);
    f.pages.unshift(f.makePage('host', 'B', { detachError: new Error('already detached') }));
    f.pages.unshift(f.makePage('closed', 'B', { targetError: new Error('Target closed') }));
    assert.deepEqual(await tool.click('B', '#button'), { ok: true, mode: 'semantic', trusted: false });
    assert.equal(f.events.find(e => e.event === 'action').value, 'B');
    assert.equal(f.openSessions, 0);
    assert.equal(f.events.filter(e => e.event === 'attach-session').length, f.events.filter(e => e.event === 'detach-session').length);
  });
  await check('mount failure rejects before CDP connection or wrong-page action', async () => {
    const f = fixture(), tool = make(f); f.guestAvailable = false;
    await assert.rejects(tool.snapshot('B'), /尚未挂载/);
    assert.equal(f.connected, 0); assert.equal(f.events.some(e => e.event === 'action'), false);
    assert.equal(f.events.some(e => e.event === 'busy' && e.busy), false);
    assert.equal(f.events.some(e => e.event === 'focus-request'), false);
  });
  await check('guest without CDP identity fails closed before action', async () => {
    const f = fixture(), tool = make(f); f.nativeTargetId = '';
    await assert.rejects(tool.snapshot('B'), /CDP 身份/);
    assert.equal(f.events.some(e => e.event === 'action'), false);
  });
  await check('native target identity query failure is explicit and never guesses a page', async () => {
    const f = fixture(), tool = make(f); f.targetQueryError = new Error('Target unavailable');
    await assert.rejects(tool.snapshot('B'), /CDP 身份查询失败.*Target unavailable/);
    assert.equal(f.connected, 0); assert.equal(f.events.some(e => e.event === 'action'), false);
  });
  await check('no matching authoritative target never falls back to marker or URL', async () => {
    const f = fixture(), tool = make(f); f.pages = [f.makePage('A', 'B')];
    await assert.rejects(tool.snapshot('B'), /CDP 未发现目标 target-B.*tabId=B.*已发现 1 个目标/);
    assert.equal(f.events.some(e => e.event === 'action'), false); assert.equal(f.openSessions, 0);
  });
  await check('failed CDP target queries retain the transport error in readiness diagnostics', async () => {
    const f = fixture(), tool = make(f);
    f.pages = [f.makePage('B', 'B', { targetError: new Error('Session detached by renderer') })];
    await assert.rejects(tool.snapshot('B'), /Target 查询错误：Session detached by renderer/);
    assert.equal(f.events.some(e => e.event === 'action'), false);
    assert.equal(f.openSessions, 0);
  });
  await check('a hanging script probe reports its stage and is never blindly reconnected', async () => {
    const f = fixture(), tool = make(f); f.probeGate = deferred();
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 8000 ? 0 : ms, ...args);
    try { await assert.rejects(tool.snapshot('B'), /页面脚本探测超时.*8000ms.*CDP 已连接/); }
    finally { globalThis.setTimeout = originalTimeout; }
    assert.equal(f.connected, 1);
    assert.equal(f.events.some(e => e.event === 'action' || e.event === 'disconnect'), false);
  });
  await check('retained old guest cannot be returned after binding changes during session cleanup', async () => {
    const f = fixture(), tool = make(f);
    f.pages[1].onDetach = () => { f.currentGuestId = 43; };
    await assert.rejects(tool.snapshot('B'), /重新挂载/);
    assert.equal(f.guestDestroyed, false);
    assert.equal(f.events.some(e => e.event === 'action'), false); assert.equal(f.openSessions, 0);
  });
  await check('readonly snapshot, screenshot, wait and storage never request focus', async () => {
    const f = fixture(), tool = make(f);
    await tool.snapshot('B'); await tool.screenshot('B');
    await tool.waitFor('B', { selector: '#ready' }); await tool.storage('B', { action: 'get', kind: 'local', key: 'draft' });
    assert.equal(f.events.some(e => e.event === 'focus-request' || e.event === 'legacy-focus'), false);
    assert.equal(f.events.filter(e => e.event === 'action').length, 4);
    assert.equal(f.openSessions, 0);
  });
  await check('lazy page resolves before busy; semantic fill prepares only target guard', async () => {
    const f = fixture(), tool = make(f); f.guestGate = deferred(); f.focusGate = deferred();
    const pending = tool.fill('B', '#input', 'draft');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.events.some(e => e.event === 'busy' && e.busy), false);
    assert.equal(f.events.some(e => e.event === 'prepare-input'), false);
    f.guestGate.resolve(); await f.focusStarted.promise;
    assert.equal(f.events.some(e => e.event === 'action'), false);
    assert.equal(f.events.some(e => e.event === 'busy' && e.busy), false);
    f.focusGate.resolve(); await pending;
    const names = f.events.map(e => e.event);
    assert.ok(names.indexOf('guest-ready') < names.indexOf('input-ready'));
    assert.ok(names.indexOf('input-ready') < names.indexOf('probe'));
    assert.ok(names.indexOf('probe') < names.indexOf('busy'));
    assert.ok(f.events.findIndex(e => e.event === 'input-ready') < f.events.findIndex(e => e.event === 'action'));
    assert.equal(f.events.filter(e => e.event === 'busy').at(-1).busy, false);
  });
  await check('supported actions use only semantic evaluation after target guard; errors propagate', async () => {
    const operations = [tool => tool.click('B', '#button'), tool => tool.fill('B', '#input', 'value'),
      tool => tool.selectOption('B', '#select', 'value'), tool => tool.scroll('B', 'down')];
    for (const run of operations) {
      const f = fixture(), tool = make(f);
      await run(tool);
      assert.ok(f.events.findIndex(e => e.event === 'input-ready') < f.events.findIndex(e => e.event === 'action'));
      assert.equal(f.events.some(e => e.event === 'activate' || e.event === 'focus-request'), false);
      assert.equal(f.events.some(e => e.event === 'native-api'), false);
    }
    const f = fixture(), tool = make(f); f.focusError = new Error('background input unavailable');
    await assert.rejects(tool.fill('B', '#input', 'value'), /background input unavailable/);
    assert.equal(f.events.some(e => e.event === 'action'), false);
    assert.equal(f.events.filter(e => e.event === 'busy').at(-1).busy, false);
    assert.equal(f.events.filter(e => e.event === 'status').at(-1).value.active, false);
  });
  await check('activate prepares background target by default and switches foreground when foreground:true is passed', async () => {
    const f = fixture(), tool = make(f); f.activeId = 'A'; f.guestGate = deferred();
    let settled = false;
    const pending = tool.activate('B').then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.activeId, 'A');
    f.guestGate.resolve(); assert.deepEqual(await pending, { ok: true, background: true });
    assert.equal(f.events.some(e => e.event === 'activate' || e.event === 'prepare-input' || e.event === 'focus-request'), false);
    assert.deepEqual(await tool.activate('B', undefined, { foreground: true }), { ok: true, background: false, foreground: true });
    assert.equal(f.activeId, 'B');
    await assert.rejects(tool.activate('missing'), /不存在/);
    assert.equal(f.events.some(e => e.event === 'action'), false);
  });
  await check('file assignment uses the selected target without focus and reports upload unverified', async () => {
    const f = fixture(), tool = make(f);
    const fileA = path.join(tmp, 'prepared-a.txt'), fileB = path.join(tmp, 'prepared-b.txt');
    fs.writeFileSync(fileA, 'a'); fs.writeFileSync(fileB, 'b');
    const digest = value => createHash('sha256').update(value).digest('hex');
    let destination;
    const result = await tool.upload('B', 'f3e13', [fileA, fileB], [digest('a'), digest('b')], () => {}, async value => { destination = value; });
    assert.deepEqual(destination, { documentUrl: 'https://same.test/', frameUrl: 'https://frame.test/' });
    assert.equal(result.assignment, 'completed'); assert.equal(result.upload, 'unverified');
    assert.deepEqual(f.events.find(e => e.event === 'set-input-files'), { event: 'set-input-files', selector: 'aria-ref=f3e13', files: [
      { name: 'prepared-a.txt', mimeType: '', buffer: Buffer.from('a') }, { name: 'prepared-b.txt', mimeType: '', buffer: Buffer.from('b') }
    ], options: { timeout: 8000 } });
    assert.equal(f.events.some(e => e.event === 'native-api' || e.event === 'activate' || e.event === 'focus-request'), false);
    await assert.rejects(tool.upload('B', '#upload', [], [], () => { throw new Error('scope changed'); }, async () => {}), /scope changed/);
    assert.equal(f.events.filter(e => e.event === 'set-input-files').length, 1);
    await assert.rejects(tool.upload('B', '#upload', [fileA], [digest('a')], () => {}, async () => { throw new Error('denied'); }), /denied/);
    assert.equal(f.events.filter(e => e.event === 'set-input-files').length, 1, 'denied authorization cannot dispatch');
    await assert.rejects(tool.upload('B', '#upload', [fileA], [digest('a')], () => {}, async () => { f.uploadDetached = true; }), /target changed/);
    f.uploadDetached = false;
    assert.equal(f.events.filter(e => e.event === 'set-input-files').length, 1, 'detached target cannot receive the files');
    f.actionError = new Error('transport disconnected');
    await assert.rejects(tool.upload('B', '#upload', [fileA], [digest('a')], () => {}, async () => { fs.writeFileSync(fileA, 'changed'); }), /snapshot changed/);
    fs.writeFileSync(fileA, 'a');
    const unknown = await tool.upload('B', '#upload', [fileA], [digest('a')], () => {}, async () => {});
    assert.equal(unknown.assignment, 'unknown'); assert.match(unknown.note, /inspect the page before retrying/);
    assert.equal(f.events.filter(e => e.event === 'set-input-files').length, 2, 'unknown writes are never replayed');
  });
  await check('semantic pressKey/hover/drag/evaluate run without native input', async () => {
    const f = fixture(), tool = make(f);
    assert.deepEqual(await tool.hover('B', '#button'), { ok: true, mode: 'semantic', trusted: false });
    assert.deepEqual(await tool.pressKey('B', 'Control+a', '#input'), { ok: true, mode: 'semantic', trusted: false });
    assert.deepEqual(await tool.pressKey('B', 'Enter'), { ok: true, mode: 'semantic', trusted: false });
    assert.Match ?? assert.equal((await tool.drag('B', '#source', '330.5,300')).ok, true);
    assert.deepEqual((await tool.drag('B', '10.5,20.25', '330.5,300')).to, { x: 330.5, y: 300 });
    assert.equal((await tool.evaluate('B', 'window.focus()')).ok, true);
    assert.equal(f.events.some(e => e.event === 'native-api' || e.event === 'activate' || e.event === 'focus-request'), false);
  });
  await check('agent help states upload capability boundary and semantic DOM modes for interactive tools', async () => {
    const f = fixture();
    assert.match(browserToolHelp('browser.upload').summary, /unverified/i);
    for (const name of ['click', 'fill', 'selectOption', 'scroll', 'pressKey', 'hover', 'drag']) {
      assert.match(browserToolHelp(`browser.${name}`).summary, /DOM|semantic/i);
    }
    assert.match(browserToolHelp('browser.evaluate').summary, /userGesture:false/);
    assert.equal(f.events.length, 0);
  });
  await check('semantic refs keep Playwright resolution and unsupported elements never fall back to native input', async () => {
    const f = fixture(), tool = make(f);
    await tool.click('B', 'e12');
    assert.deepEqual(f.events.find(e => e.event === 'semantic-locator'), { event: 'semantic-locator', selector: 'aria-ref=e12', options: { timeout: 8000 } });
    f.semanticResult = { ok: false, code: 'capability_unsupported', error: 'canvas requires native input' };
    await assert.rejects(tool.click('B', '#canvas'), /capability_unsupported.*canvas/);
    assert.equal(f.events.some(e => e.event === 'native-api' || e.event === 'activate' || e.event === 'focus-request'), false);
    assert.deepEqual(await tool.click('B', '120.5,240'), { ok: true, mode: 'semantic', trusted: false });
    assert.deepEqual(f.events.find(e => e.name === 'coordinate-click').value, { x: 120.5, y: 240 });
    await assert.rejects(tool.click('B', '1e999,2'), /有限数字/);
    f.coordinateResult = { ok: false, code: 'semantic_action_failed', error: 'miss' };
    await assert.rejects(tool.click('B', '-.5,+3e2'), /semantic_action_failed.*miss/);
  });
  await check('frame-prefixed refs (fNeM) from post-navigation/iframe snapshots resolve via aria-ref, never raw CSS', async () => {
    // 回归（2026-10-14 实测）：页面导航后 snapshot 的 ref 带 f{seq} 帧前缀；旧实现只认
    // /^e\d+$/，把 f3e13 当 CSS 选择器传 locator 导致 8s 超时。Playwright 选择器引擎原生
    // 支持 aria-ref=f3e13 按 frame seq 跳帧解析，必须同样包成 aria-ref=。
    const f = fixture(), tool = make(f);
    await tool.click('B', 'f3e13');
    assert.deepEqual(f.events.find(e => e.event === 'semantic-locator'), { event: 'semantic-locator', selector: 'aria-ref=f3e13', options: { timeout: 8000 } });
    f.events.length = 0;
    await tool.fill('B', 'f12e5', 'draft');
    assert.deepEqual(f.events.find(e => e.event === 'semantic-locator'), { event: 'semantic-locator', selector: 'aria-ref=f12e5', options: { timeout: 8000 } });
    f.events.length = 0;
    await tool.selectOption('B', 'f0e7', 'opt');
    assert.deepEqual(f.events.find(e => e.event === 'semantic-locator'), { event: 'semantic-locator', selector: 'aria-ref=f0e7', options: { timeout: 8000 } });
  });
  await check('input preparation cannot dispatch into a superseded but still live page', async () => {
    const f = fixture(), tool = make(f); f.focusGate = deferred();
    const pending = tool.fill('B', '#input', 'draft'); await f.focusStarted.promise;
    f.currentGuestId = 43; f.focusGate.resolve();
    await assert.rejects(pending, /重新挂载/);
    assert.equal(f.guestDestroyed, false); assert.equal(f.events.some(e => e.event === 'action'), false);
    assert.equal(f.events.filter(e => e.event === 'busy').at(-1).busy, false);
  });
  await check('concurrent same-tab operations keep guest busy until the final action completes', async () => {
    const f = fixture(), tool = make(f); f.actionGate = deferred();
    const first = tool.click('B', '#button');
    await new Promise(resolve => setImmediate(resolve));
    const gate = f.actionGate; f.actionGate = null;
    await tool.waitFor('B', { selector: '#ready' });
    assert.equal(f.events.some(e => e.event === 'busy' && !e.busy), false);
    assert.equal(f.events.some(e => e.event === 'status' && !e.value.active), false);
    gate.resolve(); await first;
    assert.equal(f.events.filter(e => e.event === 'busy').at(-1).busy, false);
    assert.equal(f.events.filter(e => e.event === 'status').at(-1).value.active, false);
  });
  await check('navigate waits for service acknowledgement and propagates real load failure', async () => {
    const f = fixture(), tool = make(f); f.navigationGate = deferred();
    let resolved = false;
    const pending = tool.navigate('B', 'https://new.test/').then(() => { resolved = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
    f.navigationGate.resolve(); await pending; assert.equal(resolved, true);
    f.navigationGate = null; f.navigationError = new Error('ERR_CONNECTION_REFUSED');
    await assert.rejects(tool.navigate('B', 'https://unavailable.test/'), /ERR_CONNECTION_REFUSED/);
  });
  await check('a blocked native chooser hint directs manual selection without toggling interception', async () => {
    const f = fixture(), tool = make(f); f.opensFileChooser = true;
    assert.match((await tool.click('B', '#upload')).note, /手动选择/);
    assert.equal(f.fileChooserBlocked, false);
    f.actionError = new Error('fixture interrupted');
    await assert.rejects(tool.click('B', '#upload'), /fixture interrupted/);
    f.actionError = null;
    assert.match((await tool.snapshot('B')).note, /手动选择/);
  });
  await check('mutations share a page lane across tools while waits can observe an in-flight action', async () => {
    const f = fixture(), tool = make(f); f.actionGate = deferred();
    const first = tool.click('B', '#submit');
    await new Promise(resolve => setImmediate(resolve));
    const gate = f.actionGate; f.actionGate = null;
    const second = tool.fill('B', '#input', 'after');
    const third = tool.navigate('B', 'https://next.test/');
    await tool.waitFor('B', { selector: '#ready' });
    assert.equal(f.events.some(e => e.name === 'fill' || e.event === 'navigate'), false);
    gate.resolve(); await Promise.all([first, second, third]);
    const ordered = f.events.filter(e => e.name === 'click' || e.name === 'fill' || e.event === 'navigate');
    assert.deepEqual(ordered.map(e => e.name ?? e.event), ['click', 'fill', 'navigate']);
    f.actionError = new Error('fixture failure');
    await assert.rejects(tool.fill('B', '#input', 'bad'), /fixture failure/);
    f.actionError = null; await tool.fill('B', '#input', 'recovered');
  });
  await check('private selected tabs follow authenticated actor and never the viewed tab', async () => {
    const f = fixture(), tool = make(f);
    const one = { workspaceId: 'ws', sessionId: 'one' }, two = { workspaceId: 'ws', sessionId: 'two' };
    const a = tool.open('https://one.test/', one).id, b = tool.open('https://two.test/', two).id;
    assert.equal(f.activeId, 'B');
    assert.deepEqual(f.events.filter(e => e.event === 'open').map(e => e.options), [{ background: true }, { background: true }]);
    f.events.length = 0; f.activeId = 'A';
    await tool.cookies(undefined, { action: 'get' }, one);
    assert.equal(f.events.find(e => e.event === 'ensure-guest').id, a);
    f.events.length = 0;
    await tool.cookies(undefined, { action: 'get' }, two);
    assert.equal(f.events.find(e => e.event === 'ensure-guest').id, b);
    await tool.activate('A', one); f.events.length = 0;
    await tool.cookies(undefined, { action: 'get' }, one);
    assert.equal(f.events.find(e => e.event === 'ensure-guest').id, 'A');
    await assert.rejects(tool.cookies(undefined, { action: 'get' }, { workspaceId: 'ws', sessionId: 'other' }), /当前 AI 尚未选择/);
    assert.equal(f.events.some(e => e.event === 'activate'), false);
  });
  await check('cookie set normalizes domain-only and url+domain pairs to the playwright addCookies contract', async () => {
    // 回归（2026-10-14 实测）：playwright rewriteCookies 要求 url 或 domain+path 成对；
    // domain-only 直接透传会被断言拒绝且报错文案误导。工具契约只要求 url 或 domain，
    // 归一化责任在宿主：url 优先剔除多余 domain/path；domain 定位缺省 path='/'。
    const f = fixture(), tool = make(f);
    await tool.cookies('B', { action: 'set', cookies: [
      { name: 'a', value: '1', domain: 'example.com' },
      { name: 'b', value: '2', domain: 'example.com', path: '' },
      { name: 'c', value: '3', url: 'https://example.com/x', domain: 'other.test', path: '/p' },
      { name: 'd', value: '4', domain: 'example.com', path: '/sub', httpOnly: true }
    ] });
    assert.deepEqual(f.events.find(e => e.event === 'add-cookies').cookies, [
      { name: 'a', value: '1', domain: 'example.com', path: '/' },
      { name: 'b', value: '2', domain: 'example.com', path: '/' },
      { name: 'c', value: '3', url: 'https://example.com/x' },
      { name: 'd', value: '4', domain: 'example.com', path: '/sub', httpOnly: true }
    ]);
    await assert.rejects(tool.cookies('B', { action: 'set', cookies: [{ name: 'x', value: '1' }] }), /缺少 url 或 domain/);
    await assert.rejects(tool.cookies('B', { action: 'set', cookies: [{ name: 'x' }] }), /name \+ value/);
    assert.equal(f.events.filter(e => e.event === 'add-cookies').length, 1);
    assert.deepEqual(await tool.cookies('B', { action: 'clear' }), { ok: true });
    assert.equal(f.events.filter(e => e.event === 'clear-cookies').length, 1);
  });
  await check('a dispatched action is never replayed after Target closed or crashed', async () => {
    for (const error of ['Target closed', 'Target crashed']) {
      for (const run of [tool => tool.click('B', '#submit'), tool => tool.fill('B', '#input', 'draft')]) {
        const f = fixture(), tool = make(f); f.actionError = new Error(error);
        await assert.rejects(run(tool), new RegExp(error));
        assert.equal(f.events.filter(e => e.event === 'action').length, 1, 'side effect must run at most once');
        assert.equal(f.connected, 1, 'execution errors must not trigger connection retry');
        assert.equal(f.events.filter(e => e.event === 'busy').at(-1).busy, false);
      }
    }
  });
  await check('a dead session is reconnected during the harmless probe before dispatch', async () => {
    const f = fixture(), tool = make(f); f.probeError = new Error('Target crashed');
    await tool.click('B', '#submit');
    assert.equal(f.connected, 2);
    assert.equal(f.events.filter(e => e.event === 'disconnect').length, 1);
    assert.equal(f.events.filter(e => e.event === 'probe').length, 2);
    assert.equal(f.events.filter(e => e.event === 'action').length, 1);
    assert.equal(f.events.filter(e => e.event === 'prepare-input').length, 2);
  });
  await check('concurrent dead-session probes disconnect the old connection only once', async () => {
    const f = fixture(), tool = make(f); f.probeError = new Error('Target crashed');
    await Promise.all([tool.snapshot('B'), tool.snapshot('B')]);
    assert.equal(f.connected, 2);
    assert.equal(f.events.filter(e => e.event === 'disconnect').length, 1);
    assert.equal(f.events.filter(e => e.event === 'action').length, 2);
  });
  await check('a harmless reconnect cannot rebind an already started action to a replacement page', async () => {
    const f = fixture(), tool = make(f); f.probeError = new Error('Target crashed');
    f.onDisconnect = () => { f.currentGuestId = 43; f.guest = { ...f.guest, id: 43 }; };
    await assert.rejects(tool.fill('B', '#input', 'never delivered'), /重新挂载/);
    assert.equal(f.events.some(e => e.event === 'action'), false);
    assert.equal(f.events.filter(e => e.event === 'prepare-input').length, 1);
  });
  await check('pure waitFor(timeMs) does not depend on guest readiness while invalid tabId still rejects', async () => {
    const f = fixture(), tool = make(f);
    f.guestAvailable = false;
    const res = await tool.waitFor('B', { timeMs: 100 });
    assert.deepEqual(res, { ok: true, met: 'time' });
    assert.equal(f.events.some(e => e.event === 'ensure-guest'), false);
    await assert.rejects(tool.waitFor('missing', { timeMs: 100 }), /不存在/);
  });
  await check('semantic click triggering synchronous JS dialog resolves immediately via waitForDialog with pendingDialogs', async () => {
    const f = fixture(), tool = make(f);
    const dialogArrival = deferred();
    const queuedDialogs = [];
    f.tabs.pendingDialogs = () => queuedDialogs;
    f.tabs.waitForDialog = () => ({
      promise: dialogArrival.promise,
      cancel: () => {}
    });
    // Simulate sendSync blocking locator.evaluate while enqueuing dialog on main process
    f.actionGate = deferred();
    const clickPromise = tool.click('B', 'e12');
    await new Promise(resolve => setImmediate(resolve));
    queuedDialogs.push({ id: 'dg1', type: 'alert', message: 'Hello from onclick', defaultValue: '' });
    dialogArrival.resolve();
    const result = await clickPromise;
    assert.equal(result.ok, true);
    assert.deepEqual(result.pendingDialogs, [{ id: 'dg1', type: 'alert', message: 'Hello from onclick', defaultValue: '' }]);
    assert.match(result.note, /JS 弹窗/);
    assert.deepEqual(tool.dialogList('B'), {
      ok: true,
      dialogs: [{ id: 'dg1', type: 'alert', message: 'Hello from onclick', defaultValue: '' }]
    });
  });
  await check('stale ref errors clearly distinguish frame-prefixed fNeM and main-frame eN from CSS selectors', async () => {
    const f = fixture(), tool = make(f);
    f.actionError = new Error("locator.evaluate: Timeout 8000ms exceeded. waiting for locator('aria-ref=f4e59')");
    await assert.rejects(
      tool.click('B', 'f4e59'),
      /元素引用 ref "f4e59" 已失效.*iframe.*browser\.snapshot/
    );
    f.actionError = new Error("locator.evaluate: Timeout 8000ms exceeded. waiting for locator('aria-ref=e59')");
    await assert.rejects(
      tool.click('B', 'e59'),
      /元素引用 ref "e59" 已失效.*browser\.snapshot/
    );
    f.actionError = new Error("locator.evaluate: Timeout 8000ms exceeded. waiting for locator('#missing')");
    await assert.rejects(
      tool.click('B', '#missing'),
      err => !/元素引用 ref/.test(err.message) && /#missing/.test(err.message)
    );
  });
  await check('snapshot supports selector/interactiveOnly/offset/maxChars and auto-slices large pages under 12KB', async () => {
    const f = fixture(), tool = make(f);
    const hugeLines = Array.from({ length: 1200 }, (_, i) =>
      i % 10 === 0 ? `- button "Action ${i}" [ref=e${i}]` : `- paragraph: Static text block number ${i} with padding content to exceed 12KB easily`
    ).join('\n');
    f.pages = [f.makePage('B', 'A', {
      ariaSnapshot: async () => hugeLines
    })];
    const full = await tool.snapshot('B');
    assert.equal(full.truncated, true);
    assert.ok(full.snapshot.length <= 9000);
    assert.equal(full.totalChars, hugeLines.length);
    assert.ok(typeof full.nextOffset === 'number' && full.nextOffset > 0);
    assert.match(full.note, /selector.*interactiveOnly.*offset/);

    const interactive = await tool.snapshot('B', { interactiveOnly: true });
    assert.ok(interactive.snapshot.includes('[ref=e0]'));
    assert.ok(!interactive.snapshot.includes('Static text block'));

    const shot = await tool.screenshot('B');
    assert.equal(shot.ok, true);
    assert.equal(typeof shot.path, 'string');
    assert.equal(shot.path, shot.previewPath);
    f.actionError = new Error('page.screenshot: Timeout 30000ms exceeded');
    await assert.rejects(tool.screenshot('B', { fullPage: true }), error => {
      assert.match(error.message, /Timeout 30000ms/);
      assert.match(error.message, /screenshot tab=B fullPage=true; CDP pending:/);
      return true;
    });
    f.actionError = null;
  });
  await check('evaluate suppresses focus/blur across async await boundaries and same-origin iframes, then restores after completion', async () => {
    const vm = await import('node:vm');
    const f = fixture(), tool = make(f);
    let winFocused = 0, htmlFocused = 0, iframeWinFocused = 0, iframeHtmlFocused = 0, dynamicIframeHtmlFocused = 0;
    const fakeHtmlProto = { focus: () => { htmlFocused++; }, blur: () => {} };
    const fakeSvgProto = { focus: () => { htmlFocused++; }, blur: () => {} };
    const iframeHtmlProto = { focus: () => { iframeHtmlFocused++; }, blur: () => {} };
    const dynamicHtmlProto = { focus: () => { dynamicIframeHtmlFocused++; }, blur: () => {} };
    const iframeWin = {
      focus: () => { iframeWinFocused++; },
      blur: () => {},
      HTMLElement: { prototype: iframeHtmlProto }
    };
    iframeWin.document = { defaultView: iframeWin, querySelectorAll: () => [] };
    const dynamicWin = {
      focus: () => { dynamicIframeHtmlFocused++; },
      blur: () => {},
      HTMLElement: { prototype: dynamicHtmlProto }
    };
    dynamicWin.document = { defaultView: dynamicWin, querySelectorAll: () => [] };
    const fakeIframeEl = { contentWindow: iframeWin, contentDocument: iframeWin.document };
    const dynamicIframeProto = {};
    Object.defineProperty(dynamicIframeProto, 'contentWindow', {
      configurable: true,
      enumerable: true,
      get() { return dynamicWin; }
    });
    const sandbox = {
      focus: () => { winFocused++; },
      blur: () => {},
      HTMLElement: { prototype: fakeHtmlProto },
      SVGElement: { prototype: fakeSvgProto },
      HTMLIFrameElement: { prototype: dynamicIframeProto },
      frames: [iframeWin],
      document: {
        querySelectorAll: () => [fakeIframeEl]
      },
      dynamicIframe: Object.create(dynamicIframeProto),
      setTimeout
    };
    sandbox.window = sandbox;
    f.pages = [f.makePage('B', 'A', {
      evaluate: async (expression) => {
        if (expression === '0') return 0;
        return await vm.runInNewContext(expression, sandbox);
      }
    })];
    const res = await tool.evaluate(
      'B',
      '(async () => { await new Promise(r => setTimeout(r, 20)); window.focus(); HTMLElement.prototype.focus(); SVGElement.prototype.focus(); window.frames[0].focus(); window.frames[0].HTMLElement.prototype.focus(); dynamicIframe.contentWindow.HTMLElement.prototype.focus(); return "async-ok"; })()'
    );
    assert.equal(res.ok, true);
    assert.equal(res.value, 'async-ok');
    assert.equal(winFocused, 0, 'window.focus after await must be suppressed');
    assert.equal(htmlFocused, 0, 'HTMLElement/SVGElement.prototype.focus after await must be suppressed');
    assert.equal(iframeWinFocused, 0, 'existing iframe window.focus must be suppressed');
    assert.equal(iframeHtmlFocused, 0, 'existing iframe HTMLElement.prototype.focus must be suppressed');
    assert.equal(dynamicIframeHtmlFocused, 0, 'dynamically accessed iframe HTMLElement.prototype.focus must be suppressed');
    // Verify focus methods are restored after evaluate settles
    sandbox.window.focus();
    fakeHtmlProto.focus();
    iframeWin.focus();
    iframeHtmlProto.focus();
    dynamicHtmlProto.focus();
    assert.equal(winFocused, 1);
    assert.equal(htmlFocused, 1);
    assert.equal(iframeWinFocused, 1);
    assert.equal(iframeHtmlFocused, 1);
    assert.equal(dynamicIframeHtmlFocused, 1);
  });
  await check('iframe ref drag dispatches through frame-aware semantic locators and forwards dragData on fallback dropTarget', async () => {
    const f = fixture(), tool = make(f);
    f.semanticResult = { ok: true, targetHit: false, dragData: { 'text/plain': 'card-42' } };
    await tool.drag('B', 'f3e13', 'f4e14');
    const locCalls = f.events.filter(e => e.event === 'semantic-locator');
    assert.deepEqual(locCalls.map(e => e.selector), ['aria-ref=f4e14', 'aria-ref=f3e13', 'aria-ref=f4e14']);
    const actions = f.events.filter(e => e.event === 'action');
    assert.equal(actions[0].name, 'markDragTarget');
    assert.equal(actions[1].name, 'drag');
    assert.equal(actions[2].name, 'dropTarget');
  });
  console.log(`browser-agent-tools-identity: ${passed} regression cases passed`);
} finally {
  if (previousFixture === undefined) delete globalThis[globalKey]; else globalThis[globalKey] = previousFixture;
  // Resolved mkdtemp path remains inside the task's explicit temporary directory.
  assert.equal(path.dirname(path.resolve(tmp)), path.join(root, '.tmp'));
  assert.ok(path.basename(tmp).startsWith('browser-agent-tools-identity-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
