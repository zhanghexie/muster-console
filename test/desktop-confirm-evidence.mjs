import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = fs.realpathSync(process.cwd()), parent = path.join(root, '.tmp');
fs.mkdirSync(parent, { recursive: true });
const realParent = fs.realpathSync(parent), relativeParent = path.relative(root, realParent);
assert.ok(relativeParent && relativeParent !== '..' && !relativeParent.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeParent));
const temp = fs.mkdtempSync(path.join(realParent, 'desktop-confirm-evidence-'));
try {
  const compile = createSharedCompiler(root, temp), electron = path.join(temp, 'node_modules', 'electron');
  fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(electron, 'index.js'), "import {EventEmitter} from 'node:events'; export const ipcMain=new EventEmitter(); export const nativeImage={}; export const Notification={};");
  const { ipcMain } = await import(pathToFileURL(path.join(electron, 'index.js')));
  const { UiBridge } = await import(pathToFileURL(compile('main/uiBridge.ts')));
  const { makeUnknownActionConfirmation, confirmationRefusalReason } = await import(pathToFileURL(compile('main/desktop/unknownActionUi.ts')));
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#4383a3' } }).png().toBuffer();
  const evidence = { png, sha256: createHash('sha256').update(png).digest('hex'), region: { x: 1, y: 2, width: 2, height: 3 } };
  const win = new EventEmitter(); win.isDestroyed = () => false;
  win.webContents = new EventEmitter(); win.webContents.isDestroyed = () => false;
  win.webContents.mainFrame = {}; win.webContents.send = (channel, payload) => { if (channel === 'ui:confirm') win.request = payload; };
  let available = false;
  const delayedUi = new UiBridge(() => available ? win : null, () => 'fixture');
  const unavailable = await delayedUi.confirmWithReceipt('first action', 'private', { localOnly: true, desktopEvidence: evidence });
  assert.equal(unavailable.failureReason, 'confirmation-unavailable');
  assert.equal(confirmationRefusalReason(unavailable), 'confirmation-unavailable');
  assert.equal(confirmationRefusalReason({ decision: { confirmed: false, kind: 'deny', cancelledBy: 'button' } }), 'user-declined');
  assert.equal(confirmationRefusalReason({ decision: { confirmed: false, cancelledBy: 'timeout' }, failureReason: 'confirmation-interrupted' }), 'confirmation-interrupted');
  available = true;
  const ui = delayedUi;
  await assert.rejects(ui.confirmWithReceipt('confirm', 'private', { desktopEvidence: evidence }), /local-only/);
  await assert.rejects(ui.confirmWithReceipt('confirm', 'private', { localOnly: true, desktopEvidence: { ...evidence, sha256: '0'.repeat(64) } }), /hash/);
  await assert.rejects(ui.confirmWithReceipt('confirm', 'private', { localOnly: true, desktopEvidence: { ...evidence, region: { ...evidence.region, width: 3 } } }), /region/);
  const pending = ui.confirmWithReceipt('confirm', 'private', { localOnly: true, desktopEvidence: evidence });
  const deadline = Date.now() + 5000;
  while (!win.request && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(win.request, 'confirmation must be delivered after evidence validation');
  assert.equal(win.request.localOnly, true);
  assert.equal(win.request.desktopEvidence.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(win.request.desktopEvidence.region, evidence.region);
  ipcMain.emit(`ui:confirm:${win.request.requestId}`, { sender: win.webContents, senderFrame: win.webContents.mainFrame }, true);
  assert.equal((await pending).approvalId, win.request.requestId);
  win.request = undefined;
  for (const payload of [{ confirmed: false, kind: 'allowOnce' }, { confirmed: true, kind: 'bogus' },
    { confirmed: true, kind: 'deny' }, { confirmed: true, kind: 'allowOnce', cancelledBy: 'button' }]) {
    const invalid = ui.confirmWithReceipt('confirm', 'private', { localOnly: true });
    while (!win.request) await new Promise(resolve => setImmediate(resolve));
    ipcMain.emit(`ui:confirm:${win.request.requestId}`, { sender: win.webContents, senderFrame: win.webContents.mainFrame }, payload);
    const receipt = await invalid;
    assert.equal(receipt.failureReason, 'invalid-response');
    assert.equal(receipt.approvalId, undefined);
    assert.equal(receipt.decision.confirmed, false);
    win.request = undefined;
  }
  const boundary = { taskId: 'task', appId: 'fixture-app', processInstance: 'process', surfaceId: 'surface', surfaceGeneration: 'generation',
    captureId: 'capture', geometryRevision: 'geometry', region: evidence.region, actionClass: 'click', evidenceSha256: evidence.sha256 };
  const source = { png, captureId: 'capture', appId: 'fixture-app', processInstance: 'process', surfaceId: 'surface', surfaceGeneration: 'generation', geometryRevision: 'geometry', region: evidence.region };
  const interrupted = new AbortController();
  const oldChainConfirm = makeUnknownActionConfirmation({ confirmWithReceipt: async () => {
    interrupted.abort(); return { decision: { confirmed: false, cancelledBy: 'timeout' }, failureReason: 'confirmation-interrupted' };
  } }, async () => source, interrupted.signal);
  await assert.rejects(oldChainConfirm(boundary), /abort/i, 'legacy chain cancellation must not become a persisted refusal');
  const confirm = makeUnknownActionConfirmation(ui, async () => source);
  await assert.rejects(confirm({ ...boundary, evidenceSha256: '0'.repeat(64) }), /evidence changed/);
  await assert.rejects(confirm({ ...boundary, surfaceGeneration: 'different' }), /evidence changed/);
  await assert.rejects(confirm({ ...boundary, region: { ...boundary.region, x: 99 } }), /evidence changed/);
  const actionPending = confirm(boundary);
  const actionDeadline = Date.now() + 5000;
  while (!win.request && Date.now() < actionDeadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(win.request);
  assert.match(win.request.title, /允许桌面操作/);
  assert.match(win.request.detail, /fixture-app/);
  assert.equal(win.request.desktopEvidence.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  ipcMain.emit(`ui:confirm:${win.request.requestId}`, { sender: win.webContents, senderFrame: win.webContents.mainFrame }, true);
  assert.equal(await actionPending, true);
  console.log('desktop confirmation evidence: local scope, exact hash, PNG decode and region passed');
} finally {
  const resolved = fs.realpathSync(temp), relative = path.relative(realParent, resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.ok(path.basename(resolved).startsWith('desktop-confirm-evidence-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
