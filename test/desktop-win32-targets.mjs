import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const temp = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'desktop-win32-targets-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { Win32Targets, win32CapturePoint } = await import(pathToFileURL(compile('main/desktop/win32Targets.ts')));
  const { Win32TargetRegistry } = await import(pathToFileURL(compile('main/desktop/win32TargetRegistry.ts')));
  const { resolveWin32SemanticTarget } = await import(pathToFileURL(compile('main/desktop/win32SemanticTarget.ts')));
  let live = true, time = 100, complete = true, replaceDuringInventory = false;
  const win = { nativeHandle: '0x44', title: 'Example', pid: 5, processImage: 'app.exe', processCreated: '123',
    bounds: { x: -50, y: 0, width: 50, height: 50 }, limitations: [] };
  let generation = '1';
  const generations = { observe: () => generation, current: (_id, token) => token === generation, release() {}, close() {} };
  const targets = new Win32Targets(() => { if (replaceDuringInventory) generation = '2'; return { windows: [win], complete }; }, generations, () => time);
  const frame = { sessionId: 's', taskId: 't', captureId: 'c', surfaceId: 'd', surfaceGeneration: 'g', geometryRevision: 'r',
    expiresAt: 200, width: 50, height: 50, sourceSize: { width: 200, height: 100 }, region: { x: 50, y: 10, width: 50, height: 50 },
    bounds: { x: -100, y: 0, width: 100, height: 50 }, isCurrent: () => live };
  const [{ windowId }] = targets.register(frame).windows;
  assert.deepEqual(win32CapturePoint(frame, 10, 10), { x: -70, y: 10 });
  assert.throws(() => win32CapturePoint(frame, 50, 0), /outside/);
  const scaled = { ...frame, width: 200, height: 200, sourceSize: { width: 200, height: 200 },
    region: { x: 0, y: 0, width: 200, height: 200 }, bounds: { x: -100, y: -20, width: 100, height: 100 } };
  assert.deepEqual(win32CapturePoint(scaled, 199, 199), { x: -1, y: 79 }, 'last raster pixel stays inside a scaled display');
  const crossing = { ...scaled, bounds: { x: 0, y: 0, width: 100, height: 100 } };
  assert.deepEqual(win32CapturePoint(crossing, 199, 199), { x: 99, y: 99 }, 'a window crossing onto another display cannot move the mapped point past this display');
  assert.equal(targets.resolve('s', 't', windowId).window.pid, 5);
  const actor = { sessionId: 's', taskId: 't', turnId: 'turn', isCurrent: () => live };
  const semantic = resolveWin32SemanticTarget(targets, actor, windowId);
  assert.deepEqual({ pid: semantic.pid, windowId: semantic.windowId, generation: semantic.generation },
    { pid: 5, windowId: 68, generation: '1' });
  assert.equal(Object.isFrozen(semantic), true);
  assert.throws(() => resolveWin32SemanticTarget(targets, { ...actor, sessionId: 'other' }, windowId), /unavailable/);
  assert.throws(() => resolveWin32SemanticTarget(targets, actor, '0x44'), /unavailable/,
    'a raw native handle cannot replace the host selection');
  const unsafe = { resolve: () => ({ window: { pid: 5, nativeHandle: '0x20000000000000' }, generation: '1', isCurrent: () => true }) };
  assert.throws(() => resolveWin32SemanticTarget(unsafe, actor, windowId), /represented safely/);
  assert.throws(() => resolveWin32SemanticTarget({ resolve: () => ({ window: { pid: 0, nativeHandle: '0x44' }, generation: '1', isCurrent: () => true }) }, actor, windowId), /unavailable/);
  assert.throws(() => targets.resolve('other', 't', windowId), /unavailable/);
  const proof = targets.resolve('s', 't', windowId).isCurrent;
  win.bounds.x++; assert.equal(proof(), false); assert.equal(semantic.isCurrent(), false); win.bounds.x--;
  complete = false; assert.equal(proof(), true, 'unrelated omitted windows do not invalidate an observed target'); complete = true;
  win.processCreated = '456'; assert.equal(proof(), false); win.processCreated = '123';
  generation = '2'; assert.equal(proof(), false, 'same-process HWND reuse with unchanged geometry invalidates the old reference');
  assert.equal(semantic.isCurrent(), false, 'semantic target rejects a recycled HWND'); generation = '1';
  replaceDuringInventory = true; assert.equal(proof(), false, 'replacement during enumeration invalidates the reference');
  replaceDuringInventory = false; generation = '1';
  live = false; assert.equal(proof(), false); live = true;
  time = 201; assert.throws(() => targets.resolve('s', 't', windowId), /unavailable/);
  const crowded = new Win32Targets(() => ({ windows: [
    ...Array.from({length: 15}, (_, i) => ({ ...win, nativeHandle: '0x' + (i + 100).toString(16), title: '' })),
    { ...win, nativeHandle: '0xff', title: 'Visible target' }
  ], complete: true }), generations, () => 100);
  const page = crowded.register(frame);
  assert.equal(page.windows[0].title, 'Visible target'); assert.equal(page.windows.length, 12); assert.equal(page.nextOffset, 12);
  const next = crowded.register(frame, page.nextOffset);
  assert.equal(next.windows.length, 4); assert.equal(next.nextOffset, null); assert.equal(next.complete, true);
  assert.throws(() => crowded.register(frame, -1), /offset/);
  const inaccessible = new Win32Targets(() => ({ windows: [win], complete: true }),
    { ...generations, observe: () => null }, () => 100).register(frame);
  assert.equal(inaccessible.windows.length, 0); assert.equal(inaccessible.unavailable, 1); assert.equal(inaccessible.complete, false);
  // The same selection code is usable without constructing legacy approval or
  // action-receipt storage; physical inventory is mapped to DIP exactly once.
  const physical = { ...win, bounds: { x: -100, y: 0, width: 100, height: 100 } };
  let registryClosed = false;
  const registry = new Win32TargetRegistry(point => ({ x: point.x / 2, y: point.y / 2 }),
    () => ({ ...generations, close() { registryClosed = true; } }), () => ({ windows: [physical], complete: true }));
  const capture = { ...frame, expiresAt: Date.now() + 60_000 };
  const registered = registry.register(actor, capture, { bounds: frame.bounds }, () => live).windows[0];
  assert.equal(registry.visibleTarget(actor, registered.windowId).window.bounds.x, -50);
  assert.equal(registry.semanticTarget(actor, registered.windowId).windowId, 68);
  assert.throws(() => registry.visibleTarget({ ...actor, taskId: 'other' }, registered.windowId), /unavailable/);
  registry.close(); assert.equal(registryClosed, true);
  console.log('desktop Win32 targets: crop mapping, caller binding and stale target checks passed');
} finally { removeWorkspaceFixture(temp, 'desktop-win32-targets-'); }
