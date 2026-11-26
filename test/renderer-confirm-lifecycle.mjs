import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, getEventListeners } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

// Red: original requestRendererOnce leaves cancelled/window-invalid requests pending and
// leaks IPC listeners after send/map errors; the original UiBridge serializes no cancellation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-confirm-'));
const compile = createSharedCompiler(root, tmp);
const electronDir = path.join(tmp, 'node_modules/electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', exports: './index.js' }));
fs.writeFileSync(path.join(electronDir, 'index.js'), `
import { EventEmitter } from 'node:events';
export const ipcMain = new EventEmitter();
export const nativeImage = {};
export const Notification = {};
`);

try {
  const { ipcMain } = await import(pathToFileURL(path.join(electronDir, 'index.js')).href);
  const { requestRendererOnce } = await import(pathToFileURL(compile('main/ipc/rendererRequest.ts')).href);
  const { UiBridge } = await import(pathToFileURL(compile('main/uiBridge.ts')).href);
  const { IPC_EVENT_CHANNELS } = await import(pathToFileURL(compile('shared/ipcEvents.ts')).href);
  assert.ok(IPC_EVENT_CHANNELS.includes('ui:confirmClosed'), 'desktop and Web relay allow closure events');

  function windowFixture() {
    const win = new EventEmitter();
    win.isDestroyed = () => false;
    win.webContents = new EventEmitter();
    win.webContents.mainFrame = {};
    win.webContents.isDestroyed = () => false;
    win.sent = [];
    win.webContents.send = (channel, payload) => win.sent.push({ channel, payload });
    return win;
  }
  const options = {
    requestChannel: 'ui:confirm', prefix: 'ui:confirm', payload: {}, timeoutMs: 20,
    closedChannel: 'ui:confirmClosed', onTimeout: () => false, map: (p) => p === true
  };
  const assertClean = (win) => {
    assert.equal(ipcMain.eventNames().length, 0, 'no pending response listener');
    assert.equal(win.eventNames().length, 0, 'no window lifecycle listener');
    assert.equal(win.webContents.eventNames().length, 0, 'no renderer lifecycle listener');
  };
  const requestId = (win) => win.sent.find((p) => p.channel === 'ui:confirm').payload.requestId;
  const closed = (win, id) => assert.deepEqual(win.sent.filter((p) => p.channel === 'ui:confirmClosed').map((p) => p.payload), [{ requestId: id }]);

  {
    const win = windowFixture();
    const pending = requestRendererOnce(win, { ...options, requireSource: true });
    const id = requestId(win);
    let resolved = false;
    void pending.then(() => { resolved = true; });
    ipcMain.emit(`ui:confirm:${id}`, { sender: {} }, true);
    await Promise.resolve();
    assert.equal(resolved, false, 'another renderer cannot forge the reply');
    ipcMain.emit(`ui:confirm:${id}`, { sender: win.webContents }, true);
    assert.equal(await pending, true);
    assertClean(win);
  }

  {
    const win = windowFixture(), ui = new UiBridge(() => win, () => 'workspace');
    const pending = ui.confirmWithReceipt('确认', '内容');
    await Promise.resolve();
    const id = requestId(win);
    ipcMain.emit(`ui:confirm:${id}`, {}, { confirmed: true, kind: 'allowOnce', approvalId: 'forged' });
    const receipt = await pending;
    assert.equal(receipt.approvalId, id, 'the receipt id comes from the host request, not the renderer payload');
    closed(win, id); assertClean(win);
  }
  {
    const win = windowFixture(), ui = new UiBridge(() => win, () => 'workspace');
    const pending = ui.confirmWithReceipt('本机确认', '私有画面', { localOnly: true });
    await Promise.resolve();
    const id = requestId(win);
    assert.equal(win.sent[0].payload.localOnly, true);
    let resolved = false; void pending.then(() => { resolved = true; });
    ipcMain.emit(`ui:confirm:${id}`, { sender: {} }, true);
    assert.doesNotThrow(() => ipcMain.emit(`ui:confirm:${id}`, null, true), 'Web relay uses a null event');
    ipcMain.emit(`ui:confirm:${id}`, { sender: win.webContents, senderFrame: {} }, true);
    await Promise.resolve();
    assert.equal(resolved, false, 'remote or other renderers cannot approve local-only confirmation');
    ipcMain.emit(`ui:confirm:${id}`, { sender: win.webContents, senderFrame: win.webContents.mainFrame }, true);
    assert.equal((await pending).approvalId, id);
    closed(win, id); assertClean(win);
  }
  {
    const win = windowFixture(), ui = new UiBridge(() => win, () => 'workspace');
    const pending = ui.confirmWithReceipt('确认', '内容');
    await Promise.resolve();
    const id = requestId(win);
    ipcMain.emit(`ui:confirm:${id}`, {}, { confirmed: true, kind: 'deny', approvalId: 'forged' });
    assert.equal((await pending).approvalId, undefined, 'contradictory denial is not an approval receipt');
    closed(win, id); assertClean(win);
  }
  {
    const win = windowFixture(), ui = new UiBridge(() => win, () => 'workspace'), controller = new AbortController();
    const pending = ui.confirmWithReceipt('确认', '内容', { signal: controller.signal });
    await Promise.resolve();
    const id = requestId(win); controller.abort();
    assert.equal((await pending).approvalId, undefined, 'cancelled confirmation never produces an approval receipt');
    closed(win, id); assertClean(win);
  }
  {
    const win = windowFixture(), controller = new AbortController();
    const pending = requestRendererOnce(win, { ...options, signal: controller.signal });
    const id = requestId(win);
    controller.abort();
    assert.equal(await pending, false);
    closed(win, id);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assertClean(win);
    const next = requestRendererOnce(win, options);
    let resolved = false;
    void next.then(() => { resolved = true; });
    ipcMain.emit(`ui:confirm:${id}`, {}, true);
    await Promise.resolve();
    assert.equal(resolved, false, 'late approval for old request cannot approve next');
    ipcMain.emit(`ui:confirm:${requestId({ sent: win.sent.slice(2) })}`, {}, true);
    assert.equal(await next, true);
    assertClean(win);
  }
  {
    const win = windowFixture(), controller = new AbortController();
    controller.abort();
    assert.equal(await requestRendererOnce(win, { ...options, signal: controller.signal }), false);
    assert.equal(win.sent.length, 0, 'already cancelled request is never shown');
    assertClean(win);
  }
  {
    const win = windowFixture(), controller = new AbortController();
    const pending = requestRendererOnce(win, { ...options, signal: controller.signal });
    const channel = `ui:confirm:${requestId(win)}`;
    const unrelated = () => {};
    ipcMain.on(channel, unrelated);
    controller.abort();
    assert.equal(await pending, false);
    assert.deepEqual(ipcMain.listeners(channel), [unrelated], 'cleanup owns only its own listener');
    ipcMain.removeListener(channel, unrelated);
    assertClean(win);
  }
  {
    const win = windowFixture();
    const pending = requestRendererOnce(win, options);
    const id = requestId(win);
    assert.equal(await pending, false);
    closed(win, id);
    assertClean(win);
  }
  for (const event of ['closed', 'destroyed', 'render-process-gone', 'did-start-navigation']) {
    const win = windowFixture();
    const pending = requestRendererOnce(win, options);
    if (event === 'closed') win.emit(event);
    else if (event === 'did-start-navigation') win.webContents.emit(event, { isSameDocument: false, isMainFrame: true });
    else win.webContents.emit(event);
    assert.equal(await pending, false, `${event} fails closed`);
    assertClean(win);
  }
  {
    const win = windowFixture();
    const pending = requestRendererOnce(win, options);
    win.webContents.emit('did-start-navigation', { isSameDocument: false, isMainFrame: false });
    win.webContents.emit('did-start-navigation', { isSameDocument: true, isMainFrame: true });
    ipcMain.emit(`ui:confirm:${requestId(win)}`, {}, true);
    assert.equal(await pending, true, 'subframe and same-document navigation keep confirmation alive');
    assertClean(win);
  }
  {
    const win = windowFixture();
    win.isDestroyed = () => true;
    const wc = win.webContents;
    Object.defineProperty(win, 'webContents', { get: () => { throw new Error('destroyed window getter'); } });
    assert.equal(await requestRendererOnce(win, options), false);
    assert.equal(win.sent.length, 0);
    assert.equal(ipcMain.eventNames().length, 0);
    assert.equal(win.eventNames().length, 0);
    assert.equal(wc.eventNames().length, 0);
  }
  {
    const win = windowFixture();
    win.webContents.send = () => { throw new Error('send failed'); };
    await assert.rejects(requestRendererOnce(win, options), /send failed/);
    assertClean(win);
  }
  {
    const win = windowFixture();
    const pending = requestRendererOnce(win, { ...options, map: () => { throw new Error('map failed'); } });
    ipcMain.emit(`ui:confirm:${requestId(win)}`, {}, true);
    await assert.rejects(pending, /map failed/);
    assertClean(win);
  }
  {
    const win = windowFixture(), controller = new AbortController();
    const ui = new UiBridge(() => win, () => 'workspace');
    const pending = ui.confirm('人工审批', '内容', { signal: controller.signal, confirmNote: '原因' });
    await Promise.resolve();
    const id = requestId(win);
    assert.equal('signal' in win.sent[0].payload, false, 'AbortSignal stays in main process');
    controller.abort();
    assert.deepEqual(await pending, { confirmed: false, cancelledBy: 'timeout' });
    closed(win, id);
    assertClean(win);
  }
  {
    const win = windowFixture(), controller = new AbortController();
    const ui = new UiBridge(() => win, () => 'workspace');
    let finishSuspend, resumes = 0;
    ui.setConfirmSuspend({ suspend: () => new Promise((resolve) => { finishSuspend = resolve; }), resume: () => { resumes++; } });
    const pending = ui.confirm('人工审批', '内容', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    assert.deepEqual(await pending, { confirmed: false, cancelledBy: 'timeout' }, 'abort does not wait for hanging suspend');
    assert.equal(win.sent.length, 0);
    assert.equal(resumes, 1);
    finishSuspend();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resumes, 2, 'late suspend restores views when no confirmation remains');
    assertClean(win);
  }
  {
    const win = windowFixture(), ui = new UiBridge(() => win, () => 'workspace');
    let finishSuspend, resumes = 0;
    ui.setConfirmSuspend({ suspend: () => new Promise((resolve) => { finishSuspend = resolve; }), resume: () => { resumes++; } });
    win.webContents.send = (channel, payload) => {
      win.sent.push({ channel, payload });
      if (channel === 'ui:confirm') ipcMain.emit(`ui:confirm:${payload.requestId}`, {}, true);
    };
    // Accelerate the actual production deadline; a hanging preparation must still
    // reach the existing confirmation gate without waiting for suspend to resolve.
    const realSetTimeout = globalThis.setTimeout;
    try {
      globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(ms, 10), ...args);
      const result = await ui.confirm('人工审批', '内容');
      assert.equal(result.confirmed, true, 'bounded suspend proceeds to real request/reply');
      assert.equal(resumes, 1);
      finishSuspend();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(resumes, 2);
      assertClean(win);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }
  console.log('renderer-confirm-lifecycle: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
