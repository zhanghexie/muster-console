import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-widget-state-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temporary, 'compiled'));
  const { IPC_EVENT_CHANNELS } = await import(pathToFileURL(compile('shared/ipcEvents.ts')).href);
  for (const event of ['uiWidget:changed', 'uiWidget:updated', 'uiWidget:draft']) assert.ok(IPC_EVENT_CHANNELS.includes(event), `real preload must allow ${event}`);
  const { UiWidgetStore, replaceUiWidgetFile } = await import(pathToFileURL(compile('main/uiWidgetStore.ts')).href);
  const { buildExternalFileUrl } = await import(pathToFileURL(compile('shared/filePreview.ts')).href);
  const pendingFile = path.join(temporary, 'replace.tmp'), destination = path.join(temporary, 'replace.json');
  fs.writeFileSync(pendingFile, 'complete JSON'); let replaces = 0;
  await replaceUiWidgetFile(pendingFile, destination, async (from, to) => {
    if (++replaces < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    fs.renameSync(from, to);
  });
  assert.equal(replaces, 3); assert.equal(fs.readFileSync(destination, 'utf8'), 'complete JSON');
  const userData = path.join(temporary, 'data');
  const artifact = path.join(userData, 'agent-sessions', 'session-a', 'ui', '01-form.inline.html');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, `<meta name="muster-ui" content='{"v":2,"title":"预算"}'>`);
  const store = new UiWidgetStore(userData);
  assert.equal((await store.read(artifact)).state.revision, 0);
  await Promise.all([
    store.writeState(artifact, { modelContent: { budget: 7 }, privateContent: { sort: 'cost' } }),
    store.writeState(artifact, { presentation: { collapsed: true } })
  ]);
  const reloaded = await new UiWidgetStore(userData).read(artifact);
  assert.deepEqual(reloaded.state.modelContent, { budget: 7 });
  assert.deepEqual(reloaded.state.privateContent, { sort: 'cost' });
  assert.equal(reloaded.state.presentation.collapsed, true);
  assert.equal(reloaded.state.revision, 2);
  assert.equal(reloaded.title, '预算');
  await Promise.all([
    store.writeState(artifact, { valueChanges: { budget: { value: 90, private: false } } }),
    store.writeState(artifact, { valueChanges: { selected: { value: 'concurrent-choice', private: false } } })
  ]);
  assert.deepEqual((await store.read(artifact)).state.modelContent, { budget: 90, selected: 'concurrent-choice' }, 'parallel surfaces merge changed keys instead of overwriting each other');
  const compact = JSON.parse(fs.readFileSync(artifact + '.state.json', 'utf8'));
  assert.equal(compact.state.privateContent.values.budget, undefined, 'public values are not duplicated on disk');
  assert.equal((await store.read(artifact)).state.privateContent.values.budget, 90, 'compact files restore public values for existing runtime consumers');
  await store.writeState(artifact, { defaults: { budget: { value: 80, private: false }, confidence: { value: 70, private: false }, secret: { value: 'private-default', private: true } } });
  assert.deepEqual((await store.read(artifact)).state.modelContent, { budget: 90, selected: 'concurrent-choice', confidence: 70 }, 'default registration publishes visible public parameters without overwriting peer values or private defaults');
  await store.writeState(artifact, { modelContent: { budget: 7 }, privateContent: { sort: 'cost' } });
  await store.writeReceipt(artifact, { status: 'degraded', visible: true, error: '表达式错误' });
  assert.equal((await store.read(artifact)).receipt.status, 'degraded');
  await store.writeReceipt(artifact, { status: 'degraded', visible: false });
  assert.equal((await store.read(artifact)).receipt.error, '表达式错误', 'visibility receipts retain the original runtime diagnostic');
  await store.writeReceipt(artifact, { status: 'rendered', visible: true });
  assert.equal((await store.read(artifact)).receipt.error, undefined, 'a successful render clears an old error');
  await store.writeReceipt(artifact, { status: 'degraded', visible: true, diagnostics: [{ code: 'expression_character', message: 'bad expression', id: 'metric', attribute: 'expr', expression: 'n @ 2', position: 3 }] });
  await store.writeReceipt(artifact, { status: 'degraded', visible: false });
  assert.equal((await store.read(artifact)).receipt.diagnostics[0].id, 'metric', 'visibility-only receipts preserve actionable diagnostics');
  await store.writeReceipt(artifact, { status: 'rendered', visible: true });
  assert.equal((await store.read(artifact)).receipt.diagnostics, undefined, 'successful recovery clears prior diagnostics');
  await store.writeReceipt(artifact, { status: 'failed', visible: true, error: 'HOST_EXPECTED_ERROR（行 7:3）' });
  await store.writeReceipt(artifact, { status: 'failed', visible: false });
  assert.equal((await store.read(artifact)).receipt.error, 'HOST_EXPECTED_ERROR（行 7:3）');
  await store.writeReceipt(artifact, { status: 'rendered', visible: true }, 'guest:1');
  assert.equal((await new UiWidgetStore(userData).read(artifact)).receipt.visible, false,
    'a persisted receipt alone cannot prove visibility in a new host process');
  await store.writeReceipt(artifact, { status: 'mounted', visible: false }, 'card:1');
  assert.deepEqual({ status: (await store.read(artifact)).receipt.status, visible: (await store.read(artifact)).receipt.visible },
    { status: 'rendered', visible: true }, 'a hidden card cannot overwrite another visible presentation');
  await store.writeReceipt(artifact, { status: 'degraded', visible: true, error: 'card error' }, 'card:1');
  assert.equal((await store.read(artifact)).receipt.error, 'card error', 'the latest visible presentation reports its actual failure');
  await store.releaseReceipt(artifact, 'card:1');
  assert.equal((await store.read(artifact)).receipt.status, 'rendered', 'closing one surface retains another visible surface');
  const persistReceipt = store.persist.bind(store);
  store.persist = async () => { throw new Error('fixture receipt persistence failed'); };
  await assert.rejects(store.releaseReceipt(artifact, 'guest:1'), /persistence failed/);
  store.persist = persistReceipt;
  assert.equal((await store.read(artifact)).receipt.visible, false, 'last visible surface release clears visibility');
  const removedArtifact = path.join(path.dirname(artifact), '03-removed.inline.html');
  fs.writeFileSync(removedArtifact, '<html>removed</html>');
  await store.writeReceipt(removedArtifact, { status: 'rendered', visible: true }, 'removed-card');
  fs.unlinkSync(removedArtifact);
  await store.releaseReceipt(removedArtifact, 'removed-card');
  assert.equal(store.receipts.size, 1, 'released deleted artifacts do not retain live receipt entries');
  assert.equal(fs.existsSync(removedArtifact), false, 'release must not recreate a removed artifact');
  assert.deepEqual((await store.read(artifact)).state.modelContent, { budget: 7 });
  const updated = await store.updateArtifact(artifact, { title: '新版预算', html: '<ma-input name="budget" label="预算" value="2"></ma-input>' });
  assert.equal(updated.artifactVersion, 2);
  assert.deepEqual(updated.state.modelContent, { budget: 7 });
  assert.equal(updated.state.presentation.collapsed, true);
  assert.equal(updated.receipt.status, 'generated');
  await assert.rejects(store.updateArtifact(artifact, { mode: 'browser', title: '不可换方式', html: 'x' }), /展示方式/);
  const legacy = path.join(path.dirname(artifact), '02-old.inline.html');
  const legacyHtml = `<html data-theme="light"><meta name="muster-ui" content='{"v":1,"title":"历史内容","preset":"kv","mode":"inline"}'><body class="ma-artifact"><figure><script type="application/json" class="ma-data">{"entries":[{"k":"历史","v":7}]}</script></figure></body></html>`;
  fs.writeFileSync(legacy, legacyHtml);
  assert.equal((await store.read(legacy)).artifactVersion, 1);
  assert.equal(fs.readFileSync(legacy, 'utf8'), legacyHtml, 'reading an old artifact never converts or rewrites it');
  const { uiWidgetTurnContext } = await import(pathToFileURL(compile('main/uiWidgetContext.ts')).href);
  const context = await uiWidgetTurnContext(userData, 'session-a');
  assert.ok(context.includes('"budget":7'));
  assert.ok(!context.includes('privateContent') && !context.includes('"sort":"cost"'), 'private restoration is excluded from model context');
  await assert.rejects(store.writeState(artifact, { modelContent: { bad: Infinity } }), /JSON/);
  await assert.rejects(store.writeState(artifact, { privateContent: '字'.repeat(100000) }), /256 KiB/);
  await assert.rejects(store.writeState(artifact, { modelContent: JSON.parse('{"__proto__":{}}') }), /JSON/);
  await assert.rejects(store.writeState(artifact, { presentation: { collapsed: 'yes' } }), /布尔/);
  await assert.rejects(store.writeState(path.join(temporary, 'other.inline.html'), {}), /会话目录/);
  const other = path.join(userData, 'agent-sessions', 'session-b', 'ui', '01-form.inline.html');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, '<html>separate</html>');
  assert.equal((await store.read(other)).state.modelContent, null);
  const readStored = store.readStored.bind(store);
  let reached = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  store.readStored = async file => { const result = await readStored(file); reached = true; await gate; return result; };
  const lateWrite = store.writeState(other, { modelContent: { late: true } });
  while (!reached) await new Promise(resolve => setTimeout(resolve, 1));
  fs.rmSync(path.dirname(other), { recursive: true }); release();
  await assert.rejects(lateWrite);
  assert.equal(fs.existsSync(path.dirname(other)), false, 'late writes must not recreate a removed session UI directory');
  store.readStored = readStored;
  // Production guests are native webviews. A host/unrelated window with the same URL remains rejected.
  const handlers = new Map(), clipboardWrites = [], createdTabs = [], mailSends = [], terminalWrites = [];
  let pasteSupported = true;
  let backgroundSource = false;
  const fixtureKey = '__uiWidgetStateIpcFixture';
  const previousFixture = globalThis[fixtureKey];
  const contents = (id, type, url, destroyed = false) => Object.assign(new EventEmitter(), {
    id, messages: [], getType: () => type, getURL: () => url, isDestroyed: () => destroyed,
    send(channel, value) { this.messages.push({ channel, value }); }
  });
  const url = buildExternalFileUrl(artifact);
  const host = contents(1, 'window', url);
  const managed = contents(101, 'webview', url), managedPeer = contents(102, 'webview', url);
  const legacyGuest = contents(103, 'webview', url), unmanaged = contents(104, 'window', url);
  const remote = contents(105, 'webview', 'https://fixture.invalid/remote');
  const dead = contents(106, 'webview', url, true);
  const otherPath = path.join(userData, 'agent-sessions', 'session-c', 'ui', '01-other.browser.html');
  fs.mkdirSync(path.dirname(otherPath), { recursive: true }); fs.writeFileSync(otherPath, '<html>other</html>');
  const otherPage = contents(107, 'webview', buildExternalFileUrl(otherPath));
  const all = [host, managed, managedPeer, legacyGuest, unmanaged, remote, dead, otherPage];
  const owned = new Set([101, 102, 105, 106, 107]);
  globalThis[fixtureKey] = {
    app: { getPath: () => userData },
    mailSends,
    clipboard: { writeText: text => clipboardWrites.push(text) },
    webContents: { getAllWebContents: () => all },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
  };
  try {
    const ipcBundle = path.join(temporary, 'ui-widget-ipc.cjs');
    await build({ entryPoints: [path.join(process.cwd(), 'src/main/ipc/uiWidgets.ts')], outfile: ipcBundle,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'ui-widget-ipc-leaves', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'ui-widget-fixture' }));
        builder.onResolve({ filter: /messages\/assignment$/ }, () => ({ path: 'mail', namespace: 'ui-widget-fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'ui-widget-fixture' }, args => ({ contents: args.path === 'mail'
          ? `export const sendSessionMail = async (_ctx, args) => { globalThis.${fixtureKey}.mailSends.push(args); return { stored: true }; };`
          : `const f=globalThis.${fixtureKey}; export const app=f.app, clipboard=f.clipboard, webContents=f.webContents, ipcMain=f.ipcMain;`, loader: 'js' }));
      } }] });
    const { registerUiWidgetIpc } = createRequire(import.meta.url)(ipcBundle);
    registerUiWidgetIpc({
      getWindow: () => ({ webContents: host }),
      browser: {
        shouldOpenInBackground: id => owned.has(id) && backgroundSource,
        ownerForContents: id => owned.has(id) ? { sessionId: 'session-a', workspaceId: 'workspace-a', scope: 'workspace', openerId: 'parent-tab' } : null,
        createTab: (...args) => { createdTabs.push(args); return `new-${createdTabs.length}`; }
      },
      sessions: { get: () => ({ workspaceId: 'workspace-a', runtime: 'fixture-cli' }), isChatRuntime: () => false, pasteInput: async () => pasteSupported },
      pty: { captureWriter: () => ({ write: (sessionId, text) => { terminalWrites.push({ sessionId, text }); return true; } }) },
      ui: { confirm: async () => ({ confirmed: true }) }
    });
    const invoke = (channel, sender, ...args) => handlers.get(channel)({ sender }, ...args);
    const schedulerId = 'orchestrator:12345678-1234-1234-1234-123456789abc';
    const schedulerArtifact = path.join(userData, 'agent-sessions', schedulerId.replace(':', '.'), 'ui', '01-scheduler.inline.html');
    fs.mkdirSync(path.dirname(schedulerArtifact), { recursive: true });
    fs.copyFileSync(artifact, schedulerArtifact);
    assert.equal((await invoke('uiWidget:list', host, schedulerId)).length, 1);
    const schedulerDraft = await invoke('uiWidget:action', host, schedulerArtifact, { type: 'followup', text: 'scheduler draft' });
    assert.equal(schedulerDraft.sessionId, schedulerId, 'actions return logical identity, never the storage directory alias');
    assert.deepEqual((await invoke('uiWidget:list', host, 'session-a')).map(item => item.path), [artifact, legacy].map(file => file.replace(/\\/g, '/')));
    const draft = await invoke('uiWidget:session-action', host, artifact, { type: 'followup', text: 'CLI draft' });
    assert.equal(draft.ok, true);
    assert.equal(draft.text, 'CLI draft'); assert.equal(draft.sessionId, 'session-a');
    assert.deepEqual(host.messages, []);
    assert.deepEqual(terminalWrites, []);
    pasteSupported = false;
    const copied = await invoke('uiWidget:session-action', host, artifact, { type: 'followup', text: 'CLI copy' });
    assert.equal(copied.ok, true);
    assert.equal(copied.text, 'CLI copy'); assert.deepEqual(host.messages, []);
    assert.deepEqual(clipboardWrites, []);
    await invoke('uiWidget:guest-action', managed, { type: 'followup', text: 'CLI guest draft' });
    assert.deepEqual(host.messages.splice(0), [{ channel: 'uiWidget:draft', value: { sessionId: 'session-a', text: 'CLI guest draft' } }]);
    assert.equal((await invoke('uiWidget:guest-read', managed)).path, artifact.replace(/\\/g, '/'));
    assert.equal((await invoke('uiWidget:guest-read', legacyGuest)).path, artifact.replace(/\\/g, '/'), 'matching native webviews remain connected');
    const saved = await invoke('uiWidget:guest-save', managed, { valueChanges: { bridgeOwned: { value: 'durable', private: false } } });
    assert.equal(saved.state.modelContent.bridgeOwned, 'durable');
    for (const allowed of [host, managed, managedPeer, legacyGuest]) {
      assert.equal(allowed.messages.length, 1, 'one update reaches the host and each matching webview');
      assert.equal(allowed.messages[0].channel, 'uiWidget:changed');
    }
    for (const denied of [unmanaged, remote, dead, otherPage]) assert.equal(denied.messages.length, 0,
      'state publications must not reach unrelated, unowned or destroyed windows');
    await invoke('uiWidget:guest-receipt', managed, { status: 'rendered', visible: true });
    assert.equal((await invoke('uiWidget:guest-read', managed)).receipt.status, 'rendered');
    await invoke('uiWidget:receipt', host, artifact, { status: 'mounted', visible: false }, 'card-a');
    assert.deepEqual({ status: (await invoke('uiWidget:read', host, artifact)).receipt.status,
      visible: (await invoke('uiWidget:read', host, artifact)).receipt.visible }, { status: 'rendered', visible: true });
    managed.emit('did-start-navigation', {}, 'about:blank', false, true);
    assert.equal((await invoke('uiWidget:read', host, artifact)).receipt.visible, false, 'navigation retires only that guest source');
    await invoke('uiWidget:guest-receipt', managed, { status: 'rendered', visible: true });
    await invoke('uiWidget:release-receipt', host, artifact, 'card-a');
    managed.emit('destroyed');
    assert.equal((await invoke('uiWidget:read', host, artifact)).receipt.visible, false, 'destroying the guest clears its visible receipt');
    assert.deepEqual(await invoke('uiWidget:guest-action', managed, { type: 'copy', text: 'managed clipboard' }), { ok: true, type: 'copy' });
    assert.deepEqual(clipboardWrites, ['managed clipboard']);
    const followup = await invoke('uiWidget:guest-action', managed, { type: 'followup', mode: 'send', text: 'mailbox followup' });
    assert.equal(followup.ok, true);
    assert.deepEqual(mailSends, [{ sessionId: 'session-a', text: 'mailbox followup' }], 'confirmed followup uses the shared mailbox');
    backgroundSource = true;
    const aiOpen = invoke('uiWidget:guest-action', managed, { type: 'openUrl', url: 'https://example.com/ai' });
    await Promise.resolve(); // Let the authorized IPC handler start before its first storage await.
    // The real store awaits filesystem containment/state before dispatching the action.
    // A source change during that await must not change the initiating AI's intent.
    backgroundSource = false;
    await aiOpen;
    assert.deepEqual(createdTabs.at(-1), ['https://example.com/ai', { sessionId: 'session-a', workspaceId: 'workspace-a', scope: 'workspace', openerId: 'parent-tab' }, { background: true }],
      'AI widget actions open a background tab even if the input source changes while reading state');
    const userOpen = invoke('uiWidget:guest-action', managed, { type: 'openUrl', url: 'https://example.com/user' });
    await Promise.resolve();
    backgroundSource = true;
    await userOpen;
    assert.deepEqual(createdTabs.at(-1), ['https://example.com/user', { sessionId: 'session-a', workspaceId: 'workspace-a', scope: 'workspace', openerId: 'parent-tab' }, { background: false }],
      'explicit user actions may show their new tab, regardless of a later source change');
    await invoke('uiWidget:session-action', host, artifact, { type: 'openUrl', url: 'https://example.com/session' });
    assert.deepEqual(createdTabs.at(-1), ['https://example.com/session', { sessionId: 'session-a', workspaceId: 'workspace-a', scope: 'session' }, { background: false }]);
    const previousError = console.error;
    console.error = () => {}; // Expected transport rejections are asserted below.
    try {
      for (const denied of [host, unmanaged, remote, dead]) {
        const rejection = denied === dead ? /IPC caller is no longer connected/ : /未连接宿主/;
        await assert.rejects(invoke('uiWidget:guest-read', denied), rejection);
        await assert.rejects(invoke('uiWidget:guest-save', denied, { modelContent: { forged: true } }), rejection);
      }
    } finally { console.error = previousError; }
    assert.equal((await invoke('uiWidget:guest-read', managed)).state.modelContent.forged, undefined);
  } finally {
    if (previousFixture === undefined) delete globalThis[fixtureKey]; else globalThis[fixtureKey] = previousFixture;
  }
  fs.rmSync(path.dirname(artifact), { recursive: true });
  await assert.rejects(store.read(artifact));
  console.log('ui-widget-state: save/restore/concurrent merge/receipt/isolation/invalid state checks passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
