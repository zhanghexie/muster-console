import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-snapshot-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const electron = path.join(temp, 'compiled/node_modules/electron');
  fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(electron, 'index.js'), "import { EventEmitter } from 'node:events'; export const ipcMain = new EventEmitter();\n");
  const { ipcMain } = await import(pathToFileURL(path.join(electron, 'index.js')));
  const { panelHost, readPanelSnapshot, openPanelFile, openPanelSettings, openPanelUtility, openPanelSession, openPanelGit, openPanelDiff, openPanelReview, openPanelBrowser, openPanelExtension, closePanelTab, closePanelCenter, focusPanelTab, focusPanelAxis, focusPanelCenter, splitPanel } = await import(pathToFileURL(compile('main/capabilities/hosts/panel.ts')));
  const { runAsAgentSession, runAsSchedulerTool, runAsAgentWorkspace } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const win = new EventEmitter(); win.isDestroyed = () => false;
  win.webContents = new EventEmitter(); win.webContents.isDestroyed = () => false;
  const sent = []; let notifySend;
  win.webContents.send = (channel, payload) => { sent.push({ channel, payload }); const notify = notifySend; notifySend = undefined; notify?.({ channel, payload }); };
  const session = { workspaceId: 'workspace', archived: false, name: 'Worker' };
  const peer = { workspaceId: 'workspace', archived: false, name: 'Peer', type: 'terminal' };
  const sessionToken = {};
  const workspacePath = path.join(temp, 'workspace');
  fs.mkdirSync(workspacePath);
  fs.writeFileSync(path.join(workspacePath, 'readme.txt'), 'fixture');
  const workspace = { id: 'workspace', name: 'Workspace', path: workspacePath, openedAt: 0, rootsRevision: 1,
    defaultRootId: 'root', controlRoot: workspacePath, roots: [{ id: 'root', path: workspacePath }] };
  const { sourcePathKey } = await import(pathToFileURL(compile('main/workspacePaths.ts')));
  const scope = { workspaceId: 'workspace', cwd: workspacePath, roots: [{ rootId: 'root', path: workspacePath }],
    controlPhysicalPath: sourcePathKey(workspacePath), readableDirectories: [{ path: workspacePath, physicalPath: sourcePathKey(workspacePath) }] };
  const ctx = { getWindow: () => win, resolveBubbleWorkspaceId: () => 'workspace',
    sessions: { get: id => id === 'worker' ? session : id === 'peer' ? peer : id === 'other' ? { workspaceId: 'other', name: 'Other' } : undefined,
      isChatRuntime: () => true,
      peek: id => id === 'worker' ? session : undefined, sessionScopeToken: id => id === 'worker' && !session.archived ? sessionToken : undefined,
      resolveSessionRef: ({ sessionId }) => ({ id: sessionId }) },
    agentSessions: { getWorkspaceContext: () => scope }, config: { get: () => ({ activeWorkspaceId: 'workspace', workspaces: [workspace] }) } };
  const snapshot = { workspaceId: 'workspace', axis: { page: 'terminal', virtualScreen: false, focusMode: false },
    center: { panes: [], focused: 0 }, right: { workspaceId: 'workspace', sessionId: 'worker', selectedTabId: null, tabs: [], editors: [] } };
  await assert.rejects(readPanelSnapshot(ctx), /authenticated workspace/);
  await runAsAgentSession('worker', async () => {
    assert.throws(() => panelHost['host.panel.open'](ctx, { kind: 'browser', browserId: 'browser-1', placement: 'center' }), /placement is not implemented/);
    const reviewMessage = { id: 'turn', role: 'assistant', turnChanges: { id: 'snapshot', state: 'ready', files: [{ path: 'readme.txt' }] } };
    const reviewEntry = { workspaceId: 'workspace', cwd: workspacePath, closed: false, messages: [reviewMessage] };
    ctx.agentSessions.entries = new Map([['worker', reviewEntry]]);
    const reviewTarget = { owner: { kind: 'gui', id: 'worker' }, messageId: 'turn', filePath: 'readme.txt' };
    await assert.rejects(openPanelReview(ctx, { ...reviewTarget, owner: { kind: 'gui', id: 'other' } }), /caller workspace/);
    await assert.rejects(openPanelReview(ctx, { ...reviewTarget, messageId: 'missing' }), /message is unavailable/);
    await assert.rejects(openPanelReview(ctx, { ...reviewTarget, filePath: '../private.txt' }), /file is unavailable/);
    const reviewSent = new Promise(resolve => { notifySend = resolve; });
    const review = openPanelReview(ctx, reviewTarget);
    const reviewRequest = await reviewSent;
    assert.equal(reviewRequest.channel, 'panel:open-content-request');
    assert.deepEqual(reviewRequest.payload.content, { kind: 'review', ...reviewTarget });
    ipcMain.emit(`panel:open-content:${reviewRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'review-1', existing: false, selected: false });
    assert.deepEqual(await review, { ok: true, tabId: 'review-1', existing: false, selected: false });
    const staleReviewSent = new Promise(resolve => { notifySend = resolve; });
    const staleReview = openPanelReview(ctx, reviewTarget);
    const staleReviewRequest = await staleReviewSent;
    reviewEntry.messages = [];
    ipcMain.emit(`panel:open-content:${staleReviewRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'review-1', existing: true, selected: false });
    assert.equal((await staleReview).outcome, 'unknown');
    reviewEntry.messages = [reviewMessage];
    const replacedReviewSent = new Promise(resolve => { notifySend = resolve; });
    const replacedReview = openPanelReview(ctx, reviewTarget);
    const replacedRequest = await replacedReviewSent;
    reviewMessage.turnChanges.id = 'replaced';
    ipcMain.emit(`panel:open-content:${replacedRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'review-1', existing: true, selected: false });
    assert.equal((await replacedReview).outcome, 'unknown');
    reviewMessage.turnChanges.id = 'snapshot';
    const pending = readPanelSnapshot(ctx);
    const request = sent.at(-1);
    assert.equal(request.channel, 'panel:snapshot-request');
    assert.equal(request.payload.workspaceId, 'workspace');
    let settled = false; void pending.then(() => { settled = true; });
    const channel = `panel:snapshot:${request.payload.requestId}`;
    ipcMain.emit(channel, { sender: {} }, { ok: true, snapshot });
    await Promise.resolve(); assert.equal(settled, false, 'another renderer cannot forge a panel reply');
    ipcMain.emit(channel, { sender: win.webContents }, { ok: true, snapshot });
    assert.deepEqual(await pending, { ok: true, snapshot });
    const visible = { workspaceId: 'workspace', rootId: 'root', relativePath: 'readme.txt' };
    const outside = path.join(temp, 'private.txt'); fs.writeFileSync(outside, 'private');
    fs.symlinkSync(temp, path.join(workspacePath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const scopedSnapshot = { ...snapshot, right: { ...snapshot.right,
      tabs: [
        { id: 'allowed', pinned: false, origin: 'user', content: { kind: 'file', path: 'readme.txt', fileRef: visible } },
        { id: 'outside', pinned: true, origin: 'user', content: { kind: 'file', path: outside, external: true } },
        { id: 'link', pinned: false, origin: 'user', content: { kind: 'file', path: 'escape/private.txt', fileRef: { ...visible, relativePath: 'escape/private.txt' } } },
        { id: 'diff', pinned: false, origin: 'user', content: { kind: 'diff', repoPath: workspacePath, filePath: '../private.txt', staged: false } },
        { id: 'url', pinned: false, origin: 'user', content: { kind: 'web', browserId: 'b', url: `file://${outside}`, title: 'private.txt' } }
      ], editors: [
        { workspaceId: 'workspace', path: 'readme.txt', fileRef: visible, active: false, editing: true, unsaved: false },
        { workspaceId: 'workspace', path: outside, active: true, editing: true, unsaved: true }
      ] } };
    const scoped = readPanelSnapshot(ctx), scopedRequest = sent.at(-1);
    ipcMain.emit(`panel:snapshot:${scopedRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: scopedSnapshot });
    const sanitized = (await scoped).snapshot;
    assert.equal(sanitized.right.tabs[0].content.path, 'readme.txt');
    for (const tab of sanitized.right.tabs.slice(1)) assert.deepEqual(tab.content, { kind: 'redacted' });
    assert.equal(sanitized.right.editors[0].path, 'readme.txt');
    assert.deepEqual(sanitized.right.editors[1], { workspaceId: 'workspace', path: '[outside caller read scope]', active: true, editing: true, unsaved: true });
    assert.equal(JSON.stringify(sanitized).includes(outside), false);
    const rightBrowser = { id: 'browser', pinned: false, origin: 'user', content: { kind: 'web', browserId: 'b', url: 'https://example.test', title: 'Browser' } };
    const rightFixture = { ...scopedSnapshot, right: { ...scopedSnapshot.right, selectedTabId: 'allowed', split: null,
      tabs: [scopedSnapshot.right.tabs[0], rightBrowser, scopedSnapshot.right.tabs[1]], editors: [] } };
    win.webContents.mainFrame = {};
    const respondToRightSnapshot = value => {
      const request = sent.at(-1);
      assert.equal(request.channel, 'panel:snapshot-request');
      ipcMain.emit(`panel:snapshot:${request.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: value });
    };
    const withRightSnapshot = async (call, value) => {
      const nextSend = new Promise(resolve => {
        // The lookup sends synchronously; arm the next listener before its reply.
        notifySend = resolve;
      });
      respondToRightSnapshot(value);
      return Promise.race([nextSend.then(request => ({ request })), call.then(result => ({ result }))]);
    };
    const rightArgs = { placement: 'right', layoutId: 'stack', tabIds: ['browser', 'allowed'], ratio: 0.65 };
    const arrange = panelHost['host.panel.split'](ctx, rightArgs);
    const { request: rightRequest } = await withRightSnapshot(arrange, rightFixture);
    assert.equal(rightRequest.channel, 'panel:right-layout-request');
    assert.equal(rightRequest.payload.reveal, true);
    assert.deepEqual(rightRequest.payload.change, {
      sessionId: 'worker', expected: { selectedTabId: 'allowed', split: null },
      next: { selectedTabId: 'allowed', split: { layoutId: 'stack', tabIds: ['browser', 'allowed'], ratio: 0.65 } },
      tabs: [rightFixture.right.tabs[0], rightBrowser].map(tab => ({ id: tab.id, content: JSON.stringify(tab.content) }))
    });
    const rightReply = { ok: true, placement: 'right', ...rightRequest.payload.change.next };
    const rightChannel = `panel:right-layout:${rightRequest.payload.requestId}`;
    ipcMain.emit(rightChannel, { sender: win.webContents, senderFrame: {} }, rightReply);
    assert.equal(ipcMain.listenerCount(rightChannel), 1, 'a subframe cannot confirm the layout');
    ipcMain.emit(rightChannel, { sender: win.webContents, senderFrame: win.webContents.mainFrame }, rightReply);
    assert.deepEqual(await arrange, rightReply);

    const openRightFixture = { ...rightFixture, right: { ...rightFixture.right, split: rightReply.split } };
    for (const slot of [0, undefined]) {
      const close = panelHost['host.panel.close'](ctx, { placement: 'right', slot });
      const { request } = await withRightSnapshot(close, openRightFixture);
      assert.equal(request.channel, 'panel:right-layout-request');
      assert.equal(request.payload.reveal, false);
      assert.deepEqual(request.payload.change.next, { selectedTabId: 'allowed', split: null });
      ipcMain.emit(`panel:right-layout:${request.payload.requestId}`, { sender: win.webContents, senderFrame: win.webContents.mainFrame },
        { ok: true, placement: 'right', ...request.payload.change.next });
      assert.equal((await close).ok, true);
    }
    const outsideLayout = panelHost['host.panel.split'](ctx, { ...rightArgs, tabIds: ['allowed', 'outside'] });
    respondToRightSnapshot(rightFixture);
    await assert.rejects(outsideLayout, /unavailable in the caller read scope/);
    const protectedSplit = { ...rightFixture, right: { ...rightFixture.right, split: { layoutId: 'halves', tabIds: ['allowed', 'outside'], ratio: 0.5 } } };
    const outsideClose = panelHost['host.panel.close'](ctx, { placement: 'right', slot: 1 });
    respondToRightSnapshot(protectedSplit);
    await assert.rejects(outsideClose, /unavailable in the caller read scope/);
    const badSlot = panelHost['host.panel.close'](ctx, { placement: 'right', slot: 2 });
    respondToRightSnapshot(openRightFixture);
    await assert.rejects(badSlot, /slot is unavailable/);
    await assert.rejects(panelHost['host.panel.split'](ctx, { ...rightArgs, workspaceId: 'other' }), /caller session read scope/);
    await assert.rejects(panelHost['host.panel.split'](ctx, { ...rightArgs, ratio: 0.1 }), /Invalid right split ratio/);
    const forgedReply = panelHost['host.panel.split'](ctx, rightArgs);
    const { request: forgedRequest } = await withRightSnapshot(forgedReply, rightFixture);
    ipcMain.emit(`panel:right-layout:${forgedRequest.payload.requestId}`, { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { ...rightReply, split: { ...rightReply.split, ratio: 0.5 } });
    assert.equal((await forgedReply).outcome, 'unknown');
    const narrower = path.join(workspacePath, 'allowed'); fs.mkdirSync(narrower);
    scope.readableDirectories = [{ path: narrower, physicalPath: sourcePathKey(narrower) }];
    const limited = readPanelSnapshot(ctx), limitedRequest = sent.at(-1);
    ipcMain.emit(`panel:snapshot:${limitedRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: scopedSnapshot });
    const limitedResult = (await limited).snapshot;
    assert.deepEqual(limitedResult.right.tabs[0].content, { kind: 'redacted' });
    assert.equal(limitedResult.right.editors[0].path, '[outside caller read scope]');
    scope.readableDirectories = [{ path: workspacePath, physicalPath: sourcePathKey(workspacePath) }];
    const centerFile = { sel: 'center-file:right-7', tabId: 'right-7', centerOnly: true, pinned: false,
      content: JSON.stringify({ kind: 'file', path: 'readme.txt', fileRef: visible }) };
    const fileSnapshot = { ...snapshot, center: { ...snapshot.center, panes: [{ kind: 'utility', sel: centerFile.sel }],
      fileViews: [centerFile], background: [{ id: 'center-file-ref', target: { kind: 'utility', sel: centerFile.sel } }] } };
    const readCenterFileSnapshot = async value => {
      const result = readPanelSnapshot(ctx), request = sent.at(-1);
      ipcMain.emit(`panel:snapshot:${request.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: value });
      return result;
    };
    assert.deepEqual((await readCenterFileSnapshot(fileSnapshot)).snapshot.center.fileViews, [centerFile]);
    await assert.rejects(readCenterFileSnapshot({ ...fileSnapshot, center: { ...fileSnapshot.center, fileViews: [] } }), /identity is unavailable/);
    await assert.rejects(readCenterFileSnapshot({ ...fileSnapshot, center: { ...fileSnapshot.center, fileViews: [centerFile, centerFile] } }), /Invalid center file snapshot/);
    const outsideFile = { ...centerFile, content: JSON.stringify({ kind: 'file', path: 'escape/private.txt', fileRef: { ...visible, relativePath: 'escape/private.txt' } }) };
    await assert.rejects(readCenterFileSnapshot({ ...fileSnapshot, center: { ...fileSnapshot.center, fileViews: [outsideFile] } }));
    const reviewSnapshot = { ...snapshot, right: { ...snapshot.right, tabs: [
      { id: 'review-ok', pinned: false, origin: 'agent', content: { kind: 'review', ...reviewTarget } },
      { id: 'review-outside', pinned: false, origin: 'user', content: { kind: 'review', ...reviewTarget, filePath: '../private.txt' } },
      { id: 'review-other', pinned: false, origin: 'user', content: { kind: 'review', owner: { kind: 'gui', id: 'other' } } }
    ] } };
    const reviewRead = readPanelSnapshot(ctx), reviewReadRequest = sent.at(-1);
    ipcMain.emit(`panel:snapshot:${reviewReadRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: reviewSnapshot });
    const reviewTabs = (await reviewRead).snapshot.right.tabs;
    assert.equal(reviewTabs[0].content.kind, 'review');
    assert.deepEqual(reviewTabs[1].content, { kind: 'redacted' });
    assert.deepEqual(reviewTabs[2].content, { kind: 'redacted' });
    let nativeTab = { id: 'browser-1', workspaceId: 'workspace', sessionId: 'peer', scope: 'session', url: 'https://example.test/', title: 'Example' };
    ctx.browser = { inspectExistingTab: id => id === 'browser-1' ? nativeTab : null };
    const browserSnapshot = { ...snapshot, right: { ...snapshot.right, tabs: [
      { id: 'web-1', pinned: false, origin: 'agent', content: { kind: 'web', browserId: 'browser-1', url: nativeTab.url, title: nativeTab.title } }
    ] } };
    await assert.rejects(openPanelBrowser(ctx, { browserId: 'missing' }), /caller workspace/);
    nativeTab.workspaceId = 'other';
    await assert.rejects(openPanelBrowser(ctx, { browserId: 'browser-1' }), /caller workspace/);
    nativeTab.workspaceId = 'workspace';
    const browserSent = new Promise(resolve => { notifySend = resolve; });
    const browserOpen = openPanelBrowser(ctx, { browserId: 'browser-1' });
    const browserRequest = await browserSent;
    ipcMain.emit(`panel:snapshot:${browserRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: browserSnapshot });
    assert.deepEqual(await browserOpen, { ok: true, tabId: 'web-1', existing: true, selected: false });
    const staleBrowserSent = new Promise(resolve => { notifySend = resolve; });
    const staleBrowser = openPanelBrowser(ctx, { browserId: 'browser-1' });
    const staleBrowserRequest = await staleBrowserSent;
    nativeTab = { ...nativeTab, url: 'https://changed.test/' };
    ipcMain.emit(`panel:snapshot:${staleBrowserRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: browserSnapshot });
    await assert.rejects(staleBrowser, /identity changed/);
    nativeTab = { ...nativeTab, url: 'https://example.test/' };
    const focusBrowserSent = new Promise(resolve => { notifySend = resolve; });
    const focusedBrowser = openPanelBrowser(ctx, { browserId: 'browser-1', focus: true });
    const firstBrowserSnapshot = await focusBrowserSent;
    const focusSnapshotSent = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${firstBrowserSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: browserSnapshot });
    const focusSnapshot = await focusSnapshotSent;
    const focusBrowserDispatch = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${focusSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: browserSnapshot });
    const focusBrowserRequest = await focusBrowserDispatch;
    assert.equal(focusBrowserRequest.channel, 'panel:focus-tab-request');
    ipcMain.emit(`panel:focus-tab:${focusBrowserRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, tabId: 'web-1', selected: true });
    assert.deepEqual(await focusedBrowser, { ok: true, tabId: 'web-1', existing: true, selected: true });
    nativeTab = { ...nativeTab, sessionId: 'worker' };
    const hiddenSent = new Promise(resolve => { notifySend = resolve; });
    const hidden = openPanelBrowser(ctx, { browserId: 'browser-1', focus: true });
    const hiddenRequest = await hiddenSent;
    assert.equal(hiddenRequest.channel, 'panel:open-content-request');
    assert.deepEqual(hiddenRequest.payload.content, { kind:'web', browserId:'browser-1', url:nativeTab.url, title:nativeTab.title, ownerSessionId:'worker' });
    ipcMain.emit(`panel:open-content:${hiddenRequest.payload.requestId}`, {sender:win.webContents}, {ok:true,tabId:'web-hidden',existing:true,selected:true});
    assert.deepEqual(await hidden, {ok:true,tabId:'web-hidden',existing:true,selected:true});
    nativeTab = { ...nativeTab, sessionId:'peer' };
    const unavailableSent = new Promise(resolve => { notifySend = resolve; });
    const unavailable = openPanelBrowser(ctx, { browserId:'browser-1',focus:true });
    const unavailableRequest = await unavailableSent;
    assert.equal(unavailableRequest.channel, 'panel:snapshot-request', 'another owner cannot promote a hidden tab');
    ipcMain.emit(`panel:snapshot:${unavailableRequest.payload.requestId}`, {sender:win.webContents}, {ok:true,snapshot});
    await assert.rejects(unavailable, /not visible/);
    const extNode = { id: 'extension-1', kind: 'extension', parentId: null, title: 'Extension', extensionId: 'ext', viewId: 'main', placement: 'tab' };
    let extRevision = 1;
    ctx.extensionSystem = { workbench: { peek: () => ({ workspaceId: 'workspace', sourceRootId: 'root', selectionRevision: 0, revision: extRevision, nodes: [extNode] }) } };
    const extSnapshot = { ...snapshot, right: { ...snapshot.right, tabs: [
      { id: 'ext-1', pinned: true, origin: 'user', content: { kind: 'extension', nodeId: 'extension-1', title: 'Extension' } }
    ] } };
    await assert.rejects(openPanelExtension(ctx, { nodeId: 'missing' }), /not available/);
    const extSent = new Promise(resolve => { notifySend = resolve; });
    const extOpen = openPanelExtension(ctx, { nodeId: 'extension-1' });
    const extRequest = await extSent;
    ipcMain.emit(`panel:snapshot:${extRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: extSnapshot });
    assert.deepEqual(await extOpen, { ok: true, tabId: 'ext-1', existing: true, selected: false });
    scope.readableDirectories = [{ path: narrower, physicalPath: sourcePathKey(narrower) }];
    await assert.rejects(openPanelExtension(ctx, { nodeId: 'extension-1' }), /outside the caller read scope/);
    await assert.rejects(focusPanelCenter(ctx, { target: { kind: 'utility', sel: 'nav:extension-1' } }), /unavailable in the caller read scope/);
    await assert.rejects(splitPanel(ctx, { panes: [{ kind: 'utility', sel: 'tasks' }, { kind: 'utility', sel: 'nav:extension-1' }], layoutId: 'halves' }), /unavailable in the caller read scope/);
    const privateCenterSent = new Promise(resolve => { notifySend = resolve; });
    const privateCenter = readPanelSnapshot(ctx);
    const privateCenterRequest = await privateCenterSent;
    ipcMain.emit(`panel:snapshot:${privateCenterRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...snapshot, center: { panes: [{ kind: 'utility', sel: 'nav:extension-1' }], focused: 0 } } });
    await assert.rejects(privateCenter, /unavailable in the caller read scope/);
    scope.readableDirectories = [{ path: workspacePath, physicalPath: sourcePathKey(workspacePath) }];
    const staleExtSent = new Promise(resolve => { notifySend = resolve; });
    const staleExt = openPanelExtension(ctx, { nodeId: 'extension-1' });
    const staleExtRequest = await staleExtSent;
    extRevision++;
    ipcMain.emit(`panel:snapshot:${staleExtRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: extSnapshot });
    await assert.rejects(staleExt, /identity changed/);
    extNode.placement = 'center';
    await assert.rejects(openPanelExtension(ctx, { nodeId: 'extension-1' }), /right tab/);
    const centerExtSent = new Promise(resolve => { notifySend = resolve; });
    const centerExt = openPanelExtension(ctx, { nodeId: 'extension-1', placement: 'center' });
    const centerExtRequest = await centerExtSent;
    assert.equal(centerExtRequest.payload.content.navigation.revision, extRevision);
    assert.equal(centerExtRequest.payload.content.navigation.node, JSON.stringify(extNode));
    ipcMain.emit(`panel:open-content:${centerExtRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-extension', existing: false, selected: false });
    assert.equal((await centerExt).tabId, 'center-extension');
    const staleCenterExtSent = new Promise(resolve => { notifySend = resolve; });
    const staleCenterExt = openPanelExtension(ctx, { nodeId: 'extension-1', placement: 'center' });
    const staleCenterExtRequest = await staleCenterExtSent;
    extRevision++;
    ipcMain.emit(`panel:open-content:${staleCenterExtRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-extension', existing: true, selected: false });
    assert.equal((await staleCenterExt).outcome, 'unknown');
    delete extNode.placement;
    const defaultCenterExtSent = new Promise(resolve => { notifySend = resolve; });
    const defaultCenterExt = openPanelExtension(ctx, { nodeId: 'extension-1', placement: 'center', focus: true });
    const defaultCenterExtRequest = await defaultCenterExtSent;
    ipcMain.emit(`panel:open-content:${defaultCenterExtRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-extension', existing: true, selected: true });
    assert.equal((await defaultCenterExt).selected, true);
    extNode.placement = 'tab';
    await assert.rejects(openPanelExtension(ctx, { nodeId: 'extension-1', placement: 'center', focus: true }), /moved to the center/);
    extNode.placement = 'window';
    await assert.rejects(openPanelExtension(ctx, { nodeId: 'extension-1', placement: 'center', focus: true }), /moved to the center/);
    extNode.placement = 'tab';
    const focusExtSent = new Promise(resolve => { notifySend = resolve; });
    const focusedExt = openPanelExtension(ctx, { nodeId: 'extension-1', focus: true });
    const firstExtSnapshot = await focusExtSent;
    const focusExtSnapshotSent = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${firstExtSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: extSnapshot });
    const focusExtSnapshot = await focusExtSnapshotSent;
    const focusExtDispatch = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${focusExtSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: extSnapshot });
    const focusExtRequest = await focusExtDispatch;
    assert.equal(focusExtRequest.channel, 'panel:focus-tab-request');
    ipcMain.emit(`panel:focus-tab:${focusExtRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, tabId: 'ext-1', selected: true });
    assert.deepEqual(await focusedExt, { ok: true, tabId: 'ext-1', existing: true, selected: true });
    const stale = readPanelSnapshot(ctx), next = sent.at(-1);
    session.archived = true;
    ipcMain.emit(`panel:snapshot:${next.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot });
    assert.match((await stale).error, /identity or workspace changed/);
    session.archived = false;
  });
  await runAsAgentWorkspace('workspace', () => runAsSchedulerTool(async () => {
    const pending = readPanelSnapshot(ctx), request = sent.at(-1);
    ipcMain.emit(`panel:snapshot:${request.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...snapshot, workspaceId: 'other' } });
    assert.match((await pending).error, /workspace changed/);
  }));
  ctx.git = { listRepos: async () => [{ path: workspacePath, name: 'workspace' }] };
  await runAsAgentWorkspace('workspace', () => runAsSchedulerTool(async () => {
    await assert.rejects(openPanelSettings(ctx, { focus: 'yes' }), /boolean/);
    const settingsSent = new Promise(resolve => { notifySend = resolve; });
    const settings = openPanelSettings(ctx, {});
    const settingsRequest = await settingsSent;
    assert.deepEqual(settingsRequest.payload.content, { kind: 'settings' });
    assert.equal(settingsRequest.payload.focus, false);
    ipcMain.emit(`panel:open-content:${settingsRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'settings', existing: false, selected: false });
    assert.deepEqual(await settings, { ok: true, tabId: 'settings', existing: false, selected: false });
    const rightSettingsSent = new Promise(resolve => { notifySend = resolve; });
    const rightSettings = openPanelSettings(ctx, { placement: 'right' });
    const rightSettingsRequest = await rightSettingsSent;
    assert.deepEqual(rightSettingsRequest.payload.content, { kind: 'settings', placement: 'right' });
    ipcMain.emit(`panel:open-content:${rightSettingsRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'right-settings', existing: false, selected: false });
    assert.deepEqual(await rightSettings, { ok: true, tabId: 'right-settings', existing: false, selected: false });
    const focusedSent = new Promise(resolve => { notifySend = resolve; });
    const focused = openPanelSettings(ctx, { focus: true });
    const focusedRequest = await focusedSent;
    assert.equal(focusedRequest.payload.focus, true);
    ipcMain.emit(`panel:open-content:${focusedRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'settings', existing: true, selected: true });
    assert.equal((await focused).selected, true);
    await assert.rejects(openPanelUtility(ctx, { sel: 'unknown' }), /not available/);
    await assert.rejects(openPanelUtility(ctx, { sel: 'settings' }), /not available/, 'settings requires its preparation and dirty-state bridge');
    await assert.rejects(openPanelSession(ctx, { sessionId: 'other' }), /caller workspace/);
    const utilitySent = new Promise(resolve => { notifySend = resolve; });
    const utility = openPanelUtility(ctx, { sel: 'tasks' });
    const utilityRequest = await utilitySent;
    assert.deepEqual(utilityRequest.payload.content, { kind: 'utility', sel: 'tasks', title: '定时任务' });
    assert.equal(utilityRequest.payload.focus, false);
    ipcMain.emit(`panel:open-content:${utilityRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'utility-1', existing: false, selected: false });
    assert.equal((await utility).tabId, 'utility-1');
    const centerSessionSent = new Promise(resolve => { notifySend = resolve; });
    const centerSession = openPanelSession(ctx, { sessionId: 'peer', placement: 'center' });
    const centerSessionRequest = await centerSessionSent;
    assert.deepEqual(centerSessionRequest.payload.content, { kind: 'session', sessionId: 'peer', title: 'Peer', placement: 'center' });
    ipcMain.emit(`panel:open-content:${centerSessionRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-session', existing: false, selected: false });
    assert.equal((await centerSession).tabId, 'center-session');
    peer.type = 'scheduled';
    await assert.rejects(openPanelSession(ctx, { sessionId: 'peer', placement: 'center' }), /cannot be placed/);
    peer.type = 'terminal';
    const backgroundSent = new Promise(resolve => { notifySend = resolve; });
    const backgroundUtility = openPanelUtility(ctx, { sel: 'tasks', placement: 'center' });
    const backgroundRequest = await backgroundSent;
    assert.deepEqual(backgroundRequest.payload.content, { kind: 'utility', sel: 'tasks', title: '定时任务', placement: 'center' });
    ipcMain.emit(`panel:open-content:${backgroundRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-utility', existing: false, selected: false });
    assert.equal((await backgroundUtility).tabId, 'center-utility');
    const sessionSent = new Promise(resolve => { notifySend = resolve; });
    const sessionOpen = openPanelSession(ctx, { sessionId: 'worker' });
    const sessionRequest = await sessionSent;
    assert.deepEqual(sessionRequest.payload.content, { kind: 'session', sessionId: 'worker', title: 'Worker' });
    assert.equal(sessionRequest.payload.focus, false);
    session.archived = true;
    ipcMain.emit(`panel:open-content:${sessionRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'session-1', existing: false, selected: false });
    assert.equal((await sessionOpen).outcome, 'unknown', 'session changes after dispatch require inspection');
    session.archived = false;
    const cancelController = new AbortController();
    const cancelSent = new Promise(resolve => { notifySend = resolve; });
    const cancelledSettings = openPanelSettings(ctx, { focus: true }, cancelController.signal);
    const cancelRequest = await cancelSent;
    cancelController.abort();
    assert.equal((await cancelledSettings).outcome, 'unknown');
    assert.deepEqual(sent.at(-1), { channel: 'panel:open-content-closed', payload: { requestId: cancelRequest.payload.requestId } });
    await assert.rejects(openPanelFile(ctx, { fileRef: { workspaceId: 'other', rootId: 'root', relativePath: 'readme.txt' } }), /outside the caller workspace/);
    await assert.rejects(openPanelFile(ctx, { fileRef: { workspaceId: 'workspace', rootId: 'root', relativePath: '../outside.txt' } }));
    const receive = new Promise(resolve => { notifySend = resolve; });
    const pending = openPanelFile(ctx, { fileRef: { workspaceId: 'workspace', rootId: 'root', relativePath: 'readme.txt' } });
    const request = await receive;
    assert.equal(request.channel, 'panel:open-content-request');
    assert.equal(request.payload.focus, false);
    assert.equal(request.payload.rootsRevision, 1);
    assert.equal(request.payload.content.fileRef.relativePath, 'readme.txt');
    const channel = `panel:open-content:${request.payload.requestId}`;
    ipcMain.emit(channel, { sender: win.webContents }, { ok: true, tabId: 'right-1', existing: false, selected: false });
    assert.deepEqual(await pending, { ok: true, tabId: 'right-1', existing: false, selected: false });
    const centerFileSent = new Promise(resolve => { notifySend = resolve; });
    const centerFileOpen = openPanelFile(ctx, { fileRef: { workspaceId: 'workspace', rootId: 'root', relativePath: 'readme.txt' }, placement: 'center' });
    const centerFileRequest = await centerFileSent;
    assert.equal(centerFileRequest.payload.content.placement, 'center');
    assert.equal(centerFileRequest.payload.content.fileRef.relativePath, 'readme.txt');
    ipcMain.emit(`panel:open-content:${centerFileRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-file-ref', existing: false, selected: false });
    assert.equal((await centerFileOpen).tabId, 'center-file-ref');
    const controller = new AbortController();
    const cancelledSend = new Promise(resolve => { notifySend = resolve; });
    const cancelled = openPanelFile(ctx, { fileRef: { workspaceId: 'workspace', rootId: 'root', relativePath: 'readme.txt' } }, controller.signal);
    await cancelledSend;
    controller.abort();
    assert.equal((await cancelled).outcome, 'unknown');
    fs.mkdirSync(path.join(workspacePath, 'not-a-repo'));
    await assert.rejects(openPanelGit(ctx, { repoPath: path.join(workspacePath, 'not-a-repo') }), /not registered/);
    await assert.rejects(openPanelGit(ctx, { repoPath: temp }), /outside the caller read scope/);
    const gitSent = new Promise(resolve => { notifySend = resolve; });
    const gitOpen = openPanelGit(ctx, { repoPath: workspacePath });
    const gitRequest = await gitSent;
    assert.deepEqual(gitRequest.payload.content, { kind: 'git', repoPath: workspacePath });
    ipcMain.emit(`panel:open-content:${gitRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'right-2', existing: false, selected: false });
    assert.equal((await gitOpen).tabId, 'right-2');
    await assert.rejects(openPanelDiff(ctx, { repoPath: workspacePath, filePath: '../private.txt', staged: false }), /outside/);
    await assert.rejects(openPanelDiff(ctx, { repoPath: workspacePath, filePath: 'escape/private.txt', staged: false }));
    await assert.rejects(openPanelDiff(ctx, { repoPath: workspacePath, filePath: 'readme.txt', staged: 'yes' }), /Invalid/);
    const diffSent = new Promise(resolve => { notifySend = resolve; });
    const diffOpen = openPanelDiff(ctx, { repoPath: workspacePath, filePath: 'readme.txt', staged: false });
    const diffRequest = await diffSent;
    assert.deepEqual(diffRequest.payload.content, { kind: 'diff', repoPath: workspacePath, filePath: 'readme.txt', staged: false });
    ipcMain.emit(`panel:open-content:${diffRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, tabId: 'right-diff', existing: false, selected: false });
    assert.equal((await diffOpen).tabId, 'right-diff');
    const actionSnapshot = { ...snapshot, right: { ...snapshot.right, tabs: [
      { id: 'right-1', pinned: false, origin: 'agent', content: { kind: 'file', path: 'readme.txt', fileRef: { workspaceId: 'workspace', rootId: 'root', relativePath: 'readme.txt' } } },
      { id: 'right-2', pinned: false, origin: 'agent', content: { kind: 'git', repoPath: workspacePath } },
      { id: 'private', pinned: false, origin: 'user', content: { kind: 'file', path: path.join(temp, 'private.txt'), external: true } }
    ] } };
    const replySnapshot = async requestPromise => {
      const request = await requestPromise;
      assert.equal(request.channel, 'panel:snapshot-request');
      const sentAction = new Promise(resolve => { notifySend = resolve; });
      ipcMain.emit(`panel:snapshot:${request.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: actionSnapshot });
      return sentAction;
    };
    await assert.rejects(closePanelTab(ctx, { tabId: '' }), /required/);
    const backgroundCloseSent = new Promise(resolve => { notifySend = resolve; });
    const backgroundClose = closePanelTab(ctx, { tabId: 'center-utility' });
    const backgroundCloseSnapshot = await backgroundCloseSent;
    const backgroundCloseDispatch = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${backgroundCloseSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, center: { ...actionSnapshot.center,
        background: [{ id: 'center-utility', target: { kind: 'utility', sel: 'tasks' } }] } } });
    const backgroundCloseRequest = await backgroundCloseDispatch;
    assert.equal(backgroundCloseRequest.payload.expectedContent, JSON.stringify({ kind: 'center-background', target: { kind: 'utility', sel: 'tasks' } }));
    ipcMain.emit(`panel:close-tab:${backgroundCloseRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-utility', closed: true });
    assert.deepEqual(await backgroundClose, { ok: true, tabId: 'center-utility', closed: true });
    const peerCloseSent = new Promise(resolve => { notifySend = resolve; });
    const peerClose = closePanelTab(ctx, { tabId: 'center-session' });
    const peerCloseSnapshot = await peerCloseSent;
    const peerCloseDispatch = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${peerCloseSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, center: { ...actionSnapshot.center,
        background: [{ id: 'center-session', target: { kind: 'session', sessionId: 'peer' } }] } } });
    const peerCloseRequest = await peerCloseDispatch;
    peer.archived = true;
    ipcMain.emit(`panel:close-tab:${peerCloseRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-session', closed: true });
    assert.equal((await peerClose).outcome, 'unknown');
    peer.archived = false;
    const backgroundFocusSent = new Promise(resolve => { notifySend = resolve; });
    const backgroundFocus = focusPanelTab(ctx, { tabId: 'center-utility' });
    const backgroundFocusSnapshot = await backgroundFocusSent;
    const backgroundFocusDispatch = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${backgroundFocusSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, center: { ...actionSnapshot.center,
        background: [{ id: 'center-utility', target: { kind: 'utility', sel: 'tasks' } }] } } });
    const backgroundFocusRequest = await backgroundFocusDispatch;
    assert.equal(backgroundFocusRequest.payload.expectedContent, JSON.stringify({ kind: 'center-background', target: { kind: 'utility', sel: 'tasks' } }));
    ipcMain.emit(`panel:focus-tab:${backgroundFocusRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'center-utility', selected: true });
    assert.deepEqual(await backgroundFocus, { ok: true, tabId: 'center-utility', selected: true });
    const invalidBackgroundSent = new Promise(resolve => { notifySend = resolve; });
    const invalidBackground = readPanelSnapshot(ctx);
    const invalidBackgroundRequest = await invalidBackgroundSent;
    ipcMain.emit(`panel:snapshot:${invalidBackgroundRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, center: { ...actionSnapshot.center,
        background: [{ id: 'outside', target: { kind: 'session', sessionId: 'other' } }] } } });
    await assert.rejects(invalidBackground, /unavailable/);
    const duplicateSent = new Promise(resolve => { notifySend = resolve; });
    const duplicateBackground = readPanelSnapshot(ctx);
    const duplicateRequest = await duplicateSent;
    ipcMain.emit(`panel:snapshot:${duplicateRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, center: { ...actionSnapshot.center, background: [
        { id: 'duplicate', target: { kind: 'utility', sel: 'tasks' } },
        { id: 'duplicate', target: { kind: 'utility', sel: 'memory' } }
      ] } } });
    await assert.rejects(duplicateBackground, /Invalid center background snapshot/);
    const dirtySettingsSent = new Promise(resolve => { notifySend = resolve; });
    const dirtySettings = closePanelTab(ctx, { tabId: 'settings' });
    const dirtySettingsRequest = await dirtySettingsSent;
    ipcMain.emit(`panel:snapshot:${dirtySettingsRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, settings: { prepared: true, visible: true, dirty: true } } });
    await assert.rejects(dirtySettings, /unsaved/);
    const dirtyRightSent = new Promise(resolve => { notifySend = resolve; });
    const dirtyRightSettings = closePanelTab(ctx, { tabId: 'right-settings' });
    const dirtyRightRequest = await dirtyRightSent;
    ipcMain.emit(`panel:snapshot:${dirtyRightRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, settings: { prepared: true, visible: true, dirty: true },
        right: { ...actionSnapshot.right, tabs: [...actionSnapshot.right.tabs,
          { id: 'right-settings', pinned: false, origin: 'agent', content: { kind: 'utility', sel: 'settings', title: '设置' } }] } } });
    await assert.rejects(dirtyRightSettings, /unsaved/);
    const settingsCloseSent = new Promise(resolve => { notifySend = resolve; });
    const settingsClose = closePanelTab(ctx, { tabId: 'settings' });
    const settingsCloseSnapshot = await settingsCloseSent;
    const settingsCloseDispatch = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${settingsCloseSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, settings: { prepared: true, visible: true, dirty: false } } });
    const settingsCloseRequest = await settingsCloseDispatch;
    assert.equal(settingsCloseRequest.payload.expectedContent, JSON.stringify({ kind: 'settings' }));
    ipcMain.emit(`panel:close-tab:${settingsCloseRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'settings', closed: true });
    assert.deepEqual(await settingsClose, { ok: true, tabId: 'settings', closed: true });
    const settingsFocusSent = new Promise(resolve => { notifySend = resolve; });
    const settingsFocus = focusPanelTab(ctx, { tabId: 'settings' });
    const settingsFocusSnapshot = await settingsFocusSent;
    const settingsFocusDispatch = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${settingsFocusSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...actionSnapshot, settings: { prepared: true, visible: false, dirty: false } } });
    const settingsFocusRequest = await settingsFocusDispatch;
    assert.equal(settingsFocusRequest.channel, 'panel:open-content-request');
    assert.equal(settingsFocusRequest.payload.focus, true);
    ipcMain.emit(`panel:open-content:${settingsFocusRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'settings', existing: true, selected: false });
    assert.equal((await settingsFocus).outcome, 'unknown');
    const deniedSent = new Promise(resolve => { notifySend = resolve; });
    const denied = focusPanelTab(ctx, { tabId: 'private' });
    const deniedSnapshot = await deniedSent;
    ipcMain.emit(`panel:snapshot:${deniedSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: actionSnapshot });
    await assert.rejects(denied, /caller read scope/);
    const closeSent = new Promise(resolve => { notifySend = resolve; });
    const close = closePanelTab(ctx, { tabId: 'right-2' });
    const closeRequest = await replySnapshot(closeSent);
    assert.equal(closeRequest.channel, 'panel:close-tab-request');
    assert.equal(closeRequest.payload.expectedContent, JSON.stringify(actionSnapshot.right.tabs[1].content));
    ipcMain.emit(`panel:close-tab:${closeRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, tabId: 'different', closed: true });
    assert.equal((await close).outcome, 'unknown');
    const cancelClose = new AbortController();
    const sentClose = new Promise(resolve => { notifySend = resolve; });
    const closeCancelled = closePanelTab(ctx, { tabId: 'right-2' }, cancelClose.signal);
    await replySnapshot(sentClose);
    cancelClose.abort();
    assert.equal((await closeCancelled).outcome, 'unknown');
    const focusSent = new Promise(resolve => { notifySend = resolve; });
    const focus = focusPanelTab(ctx, { tabId: 'right-1' });
    const focusRequest = await replySnapshot(focusSent);
    assert.equal(focusRequest.channel, 'panel:focus-tab-request');
    assert.equal(focusRequest.payload.expectedContent, JSON.stringify(actionSnapshot.right.tabs[0].content));
    ipcMain.emit(`panel:focus-tab:${focusRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, tabId: 'right-1', selected: true });
    assert.deepEqual(await focus, { ok: true, tabId: 'right-1', selected: true });
    await assert.rejects(focusPanelAxis(ctx, { page: 'unknown' }), /terminal or git/);
    const axisSent = new Promise(resolve => { notifySend = resolve; });
    const axis = focusPanelAxis(ctx, { page: 'git' });
    const axisRequest = await axisSent;
    assert.equal(axisRequest.channel, 'panel:focus-axis-request');
    ipcMain.emit(`panel:focus-axis:${axisRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, page: 'git' });
    assert.deepEqual(await axis, { ok: true, page: 'git' });
    const absentSent = new Promise(resolve => { notifySend = resolve; });
    const absentCenter = focusPanelCenter(ctx, { target: { kind: 'utility', sel: 'tasks' } });
    const absentRequest = await absentSent;
    ipcMain.emit(`panel:snapshot:${absentRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot });
    await assert.rejects(absentCenter, /not visible/);
    const blockedSent = new Promise(resolve => { notifySend = resolve; });
    const blockedCenter = focusPanelCenter(ctx, { target: { kind: 'utility', sel: 'tasks' } });
    const blockedSnapshot = await blockedSent;
    const blockedAxisSent = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${blockedSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...snapshot, center: { panes: [{ kind: 'utility', sel: 'tasks' }], focused: 0 } } });
    const blockedAxis = await blockedAxisSent;
    const focusCount = sent.filter(event => event.channel === 'panel:focus-center-request').length;
    ipcMain.emit(`panel:focus-axis:${blockedAxis.payload.requestId}`, { sender: win.webContents }, { ok: false, error: 'unsaved changes' });
    assert.deepEqual(await blockedCenter, { ok: false, error: 'unsaved changes' });
    assert.equal(sent.filter(event => event.channel === 'panel:focus-center-request').length, focusCount);
    const beginCenterFocus = async (snapshotSent, target, tabs = []) => {
      const snapshotRequest = await snapshotSent;
      assert.equal(snapshotRequest.channel, 'panel:snapshot-request');
      const nextAxis = new Promise(resolve => { notifySend = resolve; });
      ipcMain.emit(`panel:snapshot:${snapshotRequest.payload.requestId}`, { sender: win.webContents },
        { ok: true, snapshot: { ...snapshot, center: { panes: [target], focused: 0 }, right: { ...snapshot.right, tabs } } });
      const axisRequest = await nextAxis;
      assert.equal(axisRequest.channel, 'panel:focus-axis-request');
      assert.equal(axisRequest.payload.page, 'terminal');
      const nextFocus = new Promise(resolve => {
        const waitForFocus = event => { if (event.channel === 'panel:focus-center-request') resolve(event); else notifySend = waitForFocus; };
        notifySend = waitForFocus;
      });
      ipcMain.emit(`panel:focus-axis:${axisRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, page: 'terminal' });
      return await nextFocus;
    };
    const centerSent = new Promise(resolve => { notifySend = resolve; });
    const center = focusPanelCenter(ctx, { target: { kind: 'utility', sel: 'tasks' } });
    const centerRequest = await beginCenterFocus(centerSent, { kind: 'utility', sel: 'tasks' });
    assert.equal(centerRequest.channel, 'panel:focus-center-request');
    ipcMain.emit(`panel:focus-center:${centerRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, target: { kind: 'utility', sel: 'tasks' }, slot: 0 });
    assert.deepEqual(await center, { ok: true, target: { kind: 'utility', sel: 'tasks' }, slot: 0 });
    const taskTab = { id: 'right-tasks', pinned: false, origin: 'agent', content: { kind: 'utility', sel: 'tasks', title: 'Tasks' } };
    for (const deferredDock of [false, undefined]) {
      const dockedSent = new Promise(resolve => { notifySend = resolve; });
      const docked = focusPanelCenter(ctx, { target: { kind: 'utility', sel: 'tasks' } });
      const request = await dockedSent;
      ipcMain.emit(`panel:snapshot:${request.payload.requestId}`, { sender: win.webContents }, { ok: true,
        snapshot: { ...snapshot, center: { panes: [{ kind: 'utility', sel: 'tasks' }], focused: 0 }, right: { ...snapshot.right, tabs: [{ ...taskTab, deferredDock }] } } });
      await assert.rejects(docked, /may be docked/);
    }
    const deferredSent = new Promise(resolve => { notifySend = resolve; });
    const deferred = focusPanelCenter(ctx, { target: { kind: 'utility', sel: 'tasks' } });
    const deferredRequest = await beginCenterFocus(deferredSent, { kind: 'utility', sel: 'tasks' }, [{ ...taskTab, deferredDock: true }]);
    ipcMain.emit(`panel:focus-center:${deferredRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, target: { kind: 'utility', sel: 'tasks' }, slot: 0 });
    assert.equal((await deferred).ok, true);
    const panes = [{ kind: 'utility', sel: 'tasks' }, { kind: 'utility', sel: 'memory' }];
    {
      const target = { kind: 'utility', sel: 'center-file:right-7' };
      const binding = { sel: target.sel, tabId: 'right-7', centerOnly: true, pinned: false,
        content: JSON.stringify({ kind: 'file', path: 'readme.txt', fileRef: { workspaceId: 'workspace', rootId: 'root', relativePath: 'readme.txt' } }) };
      const filePanes = [panes[0], target];
      const fileSnapshot = { ...snapshot, center: { panes: filePanes, focused: 0, fileViews: [binding],
        background: [{ id: 'center-file-ref', target }] } };
      const tabSnapshotSent = new Promise(resolve => { notifySend = resolve; });
      const tabFocus = focusPanelTab(ctx, { tabId: 'center-file-ref' });
      const tabSnapshot = await tabSnapshotSent;
      const tabDispatch = new Promise(resolve => { notifySend = resolve; });
      ipcMain.emit(`panel:snapshot:${tabSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: fileSnapshot });
      const tabRequest = await tabDispatch;
      assert.equal(tabRequest.payload.expectedContent, JSON.stringify({ kind: 'center-background', target, file: binding }));
      ipcMain.emit(`panel:focus-tab:${tabRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, tabId: 'center-file-ref', selected: true });
      assert.equal((await tabFocus).selected, true);
      const pinnedSent = new Promise(resolve => { notifySend = resolve; });
      const pinnedFocus = focusPanelTab(ctx, { tabId: 'center-file-ref' });
      const pinnedRequest = await pinnedSent;
      ipcMain.emit(`panel:snapshot:${pinnedRequest.payload.requestId}`, { sender: win.webContents },
        { ok: true, snapshot: { ...fileSnapshot, center: { ...fileSnapshot.center, fileViews: [{ ...binding, pinned: true }] } } });
      await assert.rejects(pinnedFocus, /Pinned file/);
      const splitSnapshotSent = new Promise(resolve => { notifySend = resolve; });
      const split = splitPanel(ctx, { panes: filePanes, layoutId: 'halves' });
      const splitSnapshot = await splitSnapshotSent;
      const splitDispatch = new Promise(resolve => { notifySend = resolve; });
      ipcMain.emit(`panel:snapshot:${splitSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: fileSnapshot });
      const splitRequest = await splitDispatch;
      assert.deepEqual(splitRequest.payload.files, [binding]);
      ipcMain.emit(`panel:split:${splitRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, panes: filePanes, layoutId: 'halves' });
      assert.equal((await split).ok, true);
      const closeSnapshotSent = new Promise(resolve => { notifySend = resolve; });
      const close = closePanelCenter(ctx, { slot: 1 });
      const closeSnapshot = await closeSnapshotSent;
      const closeDispatch = new Promise(resolve => { notifySend = resolve; });
      ipcMain.emit(`panel:snapshot:${closeSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: fileSnapshot });
      const closeRequest = await closeDispatch;
      assert.deepEqual(closeRequest.payload.files, [binding]);
      ipcMain.emit(`panel:close-center:${closeRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, target, closed: true });
      assert.equal((await close).ok, true);
      const focusSnapshotSent = new Promise(resolve => { notifySend = resolve; });
      const focus = focusPanelCenter(ctx, { target });
      const focusSnapshot = await focusSnapshotSent;
      const axisSent = new Promise(resolve => { notifySend = resolve; });
      ipcMain.emit(`panel:snapshot:${focusSnapshot.payload.requestId}`, { sender: win.webContents }, { ok: true, snapshot: fileSnapshot });
      const axis = await axisSent;
      const focusSent = new Promise(resolve => {
        const waitForFocus = event => { if (event.channel === 'panel:focus-center-request') resolve(event); else notifySend = waitForFocus; };
        notifySend = waitForFocus;
      });
      ipcMain.emit(`panel:focus-axis:${axis.payload.requestId}`, { sender: win.webContents }, { ok: true, page: 'terminal' });
      const focusRequest = await focusSent;
      assert.deepEqual(focusRequest.payload.file, binding);
      ipcMain.emit(`panel:focus-center:${focusRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, target, slot: 1 });
      assert.equal((await focus).ok, true);
    }
    const extNode = { id: 'extension-1', kind: 'extension', parentId: null, title: 'Extension', extensionId: 'ext', viewId: 'main', placement: 'center' };
    let extRevision = 5;
    ctx.extensionSystem = { workbench: { peek: () => ({ workspaceId: 'workspace', sourceRootId: 'root', selectionRevision: 0, revision: extRevision, nodes: [extNode] }) } };
    const navFocusSent = new Promise(resolve => { notifySend = resolve; });
    const navFocus = focusPanelCenter(ctx, { target: { kind: 'utility', sel: 'nav:extension-1' } });
    const navFocusRequest = await beginCenterFocus(navFocusSent, { kind: 'utility', sel: 'nav:extension-1' });
    assert.equal(navFocusRequest.payload.navigation.node, JSON.stringify(extNode));
    ipcMain.emit(`panel:focus-center:${navFocusRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, target: { kind: 'utility', sel: 'nav:extension-1' }, slot: 0 });
    assert.equal((await navFocus).ok, true);
    const changedFocusSent = new Promise(resolve => { notifySend = resolve; });
    const changedFocus = focusPanelCenter(ctx, { target: { kind: 'utility', sel: 'nav:extension-1' } });
    const changedFocusRequest = await beginCenterFocus(changedFocusSent, { kind: 'utility', sel: 'nav:extension-1' });
    extRevision++;
    ipcMain.emit(`panel:focus-center:${changedFocusRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, target: { kind: 'utility', sel: 'nav:extension-1' }, slot: 0 });
    assert.equal((await changedFocus).outcome, 'unknown');
    {
      const backgroundTarget = { kind: 'utility', sel: 'nav:extension-1' };
      const backgroundNavigation = { sourceRootId: 'root', selectionRevision: 0, revision: extRevision, node: JSON.stringify(extNode) };
      const backgroundSnapshot = { ...snapshot, center: { ...snapshot.center,
        background: [{ id: 'center-extension', target: backgroundTarget, navigation: backgroundNavigation }] } };
      const backgroundFocusSent = new Promise(resolve => { notifySend = resolve; });
      const backgroundFocus = focusPanelTab(ctx, { tabId: 'center-extension' });
      const backgroundFocusSnapshot = await backgroundFocusSent;
      const backgroundFocusDispatch = new Promise(resolve => { notifySend = resolve; });
      ipcMain.emit(`panel:snapshot:${backgroundFocusSnapshot.payload.requestId}`, { sender: win.webContents },
        { ok: true, snapshot: backgroundSnapshot });
      const backgroundFocusRequest = await backgroundFocusDispatch;
      assert.equal(backgroundFocusRequest.payload.expectedContent,
        JSON.stringify({ kind: 'center-background', target: backgroundTarget, navigation: backgroundNavigation }));
      ipcMain.emit(`panel:focus-tab:${backgroundFocusRequest.payload.requestId}`, { sender: win.webContents },
        { ok: true, tabId: 'center-extension', selected: true });
      assert.equal((await backgroundFocus).selected, true);
      const backgroundCloseSent = new Promise(resolve => { notifySend = resolve; });
      const backgroundClose = closePanelTab(ctx, { tabId: 'center-extension' });
      const backgroundCloseSnapshot = await backgroundCloseSent;
      const backgroundCloseDispatch = new Promise(resolve => { notifySend = resolve; });
      ipcMain.emit(`panel:snapshot:${backgroundCloseSnapshot.payload.requestId}`, { sender: win.webContents },
        { ok: true, snapshot: backgroundSnapshot });
      const backgroundCloseRequest = await backgroundCloseDispatch;
      extRevision++;
      ipcMain.emit(`panel:close-tab:${backgroundCloseRequest.payload.requestId}`, { sender: win.webContents },
        { ok: true, tabId: 'center-extension', closed: true });
      assert.equal((await backgroundClose).outcome, 'unknown', 'navigation changes during dispatch require inspection');
      const staleBackgroundSent = new Promise(resolve => { notifySend = resolve; });
      const staleBackground = focusPanelTab(ctx, { tabId: 'center-extension' });
      const staleBackgroundSnapshot = await staleBackgroundSent;
      ipcMain.emit(`panel:snapshot:${staleBackgroundSnapshot.payload.requestId}`, { sender: win.webContents },
        { ok: true, snapshot: backgroundSnapshot });
      await assert.rejects(staleBackground, /navigation changed/);
    }
    const navPanes = [panes[0], { kind: 'utility', sel: 'nav:extension-1' }];
    const navSplitSent = new Promise(resolve => { notifySend = resolve; });
    const navSplit = splitPanel(ctx, { panes: navPanes, layoutId: 'halves' });
    const navSplitRequest = await navSplitSent;
    assert.equal(navSplitRequest.payload.navigation[0].node, JSON.stringify(extNode));
    ipcMain.emit(`panel:split:${navSplitRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, panes: navPanes, layoutId: 'halves' });
    assert.equal((await navSplit).ok, true);
    const navSnapshotSent = new Promise(resolve => { notifySend = resolve; });
    const navClose = closePanelCenter(ctx, { slot: 1 });
    const navSnapshot = await navSnapshotSent;
    const navCloseSent = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${navSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...snapshot, center: { panes: [panes[0], { kind: 'utility', sel: 'nav:extension-1' }], focused: 0 } } });
    const navCloseRequest = await navCloseSent;
    assert.equal(navCloseRequest.payload.navigation[0].node, JSON.stringify(extNode));
    extRevision++;
    ipcMain.emit(`panel:close-center:${navCloseRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, target: navPanes[1], closed: true });
    assert.equal((await navClose).outcome, 'unknown');
    await assert.rejects(splitPanel(ctx, { panes: [panes[0], panes[0]], layoutId: 'halves' }), /Duplicate/);
    const splitSent = new Promise(resolve => { notifySend = resolve; });
    const split = splitPanel(ctx, { panes, layoutId: 'halves' });
    const splitRequest = await splitSent;
    assert.equal(splitRequest.channel, 'panel:split-request');
    ipcMain.emit(`panel:split:${splitRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, panes, layoutId: 'halves' });
    assert.deepEqual(await split, { ok: true, panes, layoutId: 'halves' });
    const snapshotSent = new Promise(resolve => { notifySend = resolve; });
    const closing = closePanelCenter(ctx, { target: panes[1] });
    const closeSnapshot = await snapshotSent;
    assert.equal(closeSnapshot.channel, 'panel:snapshot-request');
    const centerCloseSent = new Promise(resolve => { notifySend = resolve; });
    ipcMain.emit(`panel:snapshot:${closeSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...snapshot, center: { panes, focused: 0 } } });
    const centerCloseRequest = await centerCloseSent;
    assert.equal(centerCloseRequest.channel, 'panel:close-center-request');
    assert.equal(centerCloseRequest.payload.slot, 1); assert.deepEqual(centerCloseRequest.payload.panes, panes);
    ipcMain.emit(`panel:close-center:${centerCloseRequest.payload.requestId}`, { sender: win.webContents }, { ok: true, target: panes[1], closed: true });
    assert.deepEqual(await closing, { ok: true, target: panes[1], closed: true });
    await assert.rejects(closePanelCenter(ctx, { slot: 0, target: panes[0] }), /exactly one/);
    const staleSnapshotSent = new Promise(resolve => { notifySend = resolve; });
    const staleClose = closePanelCenter(ctx, { slot: 0 });
    const staleSnapshot = await staleSnapshotSent;
    const staleCloseSent = new Promise(resolve => { notifySend = resolve; });
    const sessionPanes = [{ kind: 'session', sessionId: 'worker' }, panes[1]];
    ipcMain.emit(`panel:snapshot:${staleSnapshot.payload.requestId}`, { sender: win.webContents },
      { ok: true, snapshot: { ...snapshot, center: { panes: sessionPanes, focused: 0 } } });
    const staleRequest = await staleCloseSent;
    session.archived = true;
    ipcMain.emit(`panel:close-center:${staleRequest.payload.requestId}`, { sender: win.webContents },
      { ok: true, target: sessionPanes[0], closed: true });
    assert.equal((await staleClose).outcome, 'unknown');
    session.archived = false;
  }));
  assert.equal(ipcMain.eventNames().length, 0);
  console.log('panel snapshot bridge: actor scope, renderer identity and stale caller passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
