import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-action-authority-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { desktopLogicalOperationId, classifyDesktopActionResult } = await import(pathToFileURL(compile('main/desktop/desktopActionAuthority.ts')));
  const request = { sessionId: 'session', taskId: 'task', requestId: 'request', target: 'window', action: 'win32.click', fingerprint: 'a'.repeat(64) };
  const windows = { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' };
  assert.deepEqual(classifyDesktopActionResult(request, windows), { outcome: 'known', value: windows });
  assert.equal(classifyDesktopActionResult({ ...request, action: 'win32.launch' }, { ...windows, pid: 42 }).outcome, 'known');
  assert.equal(classifyDesktopActionResult({ ...request, action: 'win32.launch' }, windows).outcome, 'unknown');
  assert.equal(classifyDesktopActionResult(request, { ...windows, pid: 42 }).outcome, 'unknown');
  assert.equal(classifyDesktopActionResult(request, { ...windows, verification: 'success' }).outcome, 'unknown');
  assert.equal(classifyDesktopActionResult({ ...request, action: 'other' }, windows).outcome, 'unknown');
  assert.equal(classifyDesktopActionResult(request, { ...windows, extra: true }).outcome, 'unknown');
  const cua = { ok: true, delivery: 'unknown', effect: 'confirmed', verification: 'not_performed' };
  for (const effect of ['confirmed', 'unverifiable']) {
    assert.equal(classifyDesktopActionResult({ ...request, action: 'cua.click' }, { ...cua, effect }).outcome, 'known');
  }
  for (const effect of ['refused', 'not_applied']) {
    assert.equal(classifyDesktopActionResult({ ...request, action: 'cua.set_value' }, { ...cua, ok: false, effect }).outcome, 'known');
  }
  for (const effect of ['partial', 'unknown', 'suspected_noop']) {
    assert.equal(classifyDesktopActionResult({ ...request, action: 'cua.click' }, { ...cua, ok: false, effect }).outcome, 'unknown');
  }
  assert.equal(classifyDesktopActionResult({ ...request, action: 'cua.click' }, { ...cua, ok: false }).outcome, 'unknown');
  assert.equal(classifyDesktopActionResult({ ...request, action: 'cua.click' }, { ...cua, code: '../private' }).outcome, 'unknown');
  const macLaunch = { ...request, action: 'macos.launch' };
  assert.equal(classifyDesktopActionResult(macLaunch, cua).outcome, 'known', 'legacy launch receipts are still readable');
  assert.equal(classifyDesktopActionResult(macLaunch, { ...cua, launch: { status: 'already_running', active: false } }).outcome, 'known');
  assert.equal(classifyDesktopActionResult(macLaunch, { ...cua, launch: { status: 'started', active: null } }).outcome, 'unknown');
  assert.equal(classifyDesktopActionResult(macLaunch, { ...cua, launch: { status: 'already_running', active: true, pid: 2 } }).outcome, 'unknown');
  assert.equal(classifyDesktopActionResult({ ...request, action: 'macos.focus' },
    { ...cua, launch: { status: 'already_running', active: true } }).outcome, 'unknown');
  const accessor = { ...windows, get extra() { throw new Error('must not read'); } };
  assert.equal(classifyDesktopActionResult(request, accessor).outcome, 'unknown');
  assert.equal(desktopLogicalOperationId(request), desktopLogicalOperationId({ ...request }));
  assert.notEqual(desktopLogicalOperationId(request), desktopLogicalOperationId({ ...request, sessionId: 'other' }));
  assert.notEqual(desktopLogicalOperationId(request), desktopLogicalOperationId({ ...request, taskId: 'other' }));
  console.log('Desktop action authority: scoped IDs and explicit known/unknown backend projections passed');
} finally { removeWorkspaceFixture(temp, 'desktop-action-authority-'); }
