import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-screen-runtime-'));
let screenRuntime, scheduler, registry;
try {
  const compiled = path.join(temp, 'compiled'), compile = createSharedCompiler(process.cwd(), compiled);
  const sharpDir = path.join(compiled, 'node_modules/sharp'); fs.mkdirSync(sharpDir, { recursive: true });
  const require = createRequire(import.meta.url), sharp = require('sharp');
  fs.writeFileSync(path.join(sharpDir, 'package.json'), JSON.stringify({ name: 'sharp', main: 'index.cjs' }));
  fs.writeFileSync(path.join(sharpDir, 'index.cjs'), `module.exports = require(${JSON.stringify(require.resolve('sharp'))});\n`);
  const load = p => import(pathToFileURL(compile(p)).href);
  const { ElectronDisplayRegistry } = await load('main/desktop/displayRegistry.ts');
  const { SchedulerDesktopEpochRuntime } = await load('main/desktop/schedulerEpochRuntime.ts');
  const { DesktopScreenRuntime } = await load('main/desktop/screenRuntime.ts');
  const userData = path.join(temp, 'data'); fs.mkdirSync(userData);
  const display = Object.assign(new EventEmitter(), { getAllDisplays: () => [{ id: 1, label: 'Fixture',
    bounds: { x: 0, y: 0, width: 2, height: 2 }, scaleFactor: 1, rotation: 0 }] });
  const power = new EventEmitter(); registry = new ElectronDisplayRegistry(display, power);
  const surfaceId = registry.refresh().surfaces[0].surfaceId;
  let allowWorker = true, workerPrompts = 0, schedulerPrompts = [], reads = 0, serial = 0;
  const ui = {
    async confirm() { workerPrompts++; return { confirmed: allowWorker, kind: allowWorker ? 'allowOnce' : 'deny' }; },
    async confirmWithReceipt(...args) { schedulerPrompts.push(args); return { approvalId: `receipt-${++serial}`,
      decision: { confirmed: true, kind: 'allowOnce' } }; }
  };
  scheduler = new SchedulerDesktopEpochRuntime(userData, ui);
  const ctx = { sessions: { get: id => ({ name: id }) }, desktopSchedulerTask: () => scheduler };
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#29aaff' } }).png().toBuffer();
  const image = { isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }), toPNG: () => png };
  screenRuntime = new DesktopScreenRuntime(ctx, userData, registry, ui,
    async () => { reads++; return [{ display_id: '1', thumbnail: image }]; }, () => image);
  const actor = { sessionId: 'worker', taskId: 'worker-generation-1', isCurrent: () => true };
  const first = await screenRuntime.look(actor, surfaceId, 60_000);
  assert.equal(first.width, 2); assert.ok(fs.existsSync(first.path)); assert.equal(workerPrompts, 1);
  await screenRuntime.look(actor, surfaceId, 60_000); assert.equal(workerPrompts, 1, 'same task reuses its screen grant');
  allowWorker = false;
  const nextActor = { ...actor, taskId: 'worker-generation-2' }, before = reads;
  await assert.rejects(screenRuntime.look(nextActor, surfaceId, 60_000), /declined/);
  assert.equal(reads, before, 'declined authorization never requests pixels');
  await assert.rejects(screenRuntime.look(nextActor, surfaceId, 60_000), /previously declined/);
  assert.equal(workerPrompts, 2, 'a prior refusal is not repeatedly prompted');

  const owner = 'orchestrator:ws', taskId = await scheduler.ensureCapture(owner, () => true);
  const schedulerActor = { sessionId: owner, taskId, isCurrent: () => scheduler.currentBinding(owner)?.epoch === taskId };
  await screenRuntime.look(schedulerActor, surfaceId, 60_000);
  assert.equal(schedulerPrompts.length, 1, 'initial all-display task consent is reused');
  assert.match(schedulerPrompts[0][1], /所有显示器的画面/);
  await screenRuntime.look(schedulerActor, surfaceId, 60_000);
  assert.equal(schedulerPrompts.length, 1, 'same capture grant does not repeatedly prompt');
  const otherOwner = 'orchestrator:other', otherTask = await scheduler.ensureCapture(otherOwner, () => true);
  assert.equal(scheduler.consumeCaptureApproval(otherOwner, otherTask), true);
  await screenRuntime.look({ sessionId: otherOwner, taskId: otherTask, isCurrent: () => scheduler.currentBinding(otherOwner)?.epoch === otherTask }, surfaceId, 60_000);
  assert.match(schedulerPrompts.at(-1)[0], /扩展当前桌面任务链/, 'a prior task without the screen proof uses expansion');
  assert.equal(scheduler.currentBinding(otherOwner).epoch, otherTask);
  console.log('desktop screen runtime: single scope consent, refusal, task generations and private artifacts passed');
} finally { screenRuntime?.close(); scheduler?.close(); registry?.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
