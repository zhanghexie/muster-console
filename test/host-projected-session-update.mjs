import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-session-update-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { executeProjectedSessionUpdate: update } = await import(pathToFileURL(compile('main/capabilities/projectedSessionUpdate.ts')));
  const caller = { kind: 'scheduler' }, target = { id: 'one' }, sources = ['sessions.rename', 'sessions.run'];
  const input = { sessionId: 'one', name: 'new', pinned: true };
  let current = true, permission = true, executed = [], checks = [];
  const deps = { isCurrent: () => current,
    authorize: async (source, operation) => { checks.push([source, operation.tool]); assert.ok(Object.isFrozen(operation.args)); return () => permission; },
    execute: async operation => { executed.push(operation.tool); return { ok: true }; } };
  const result = await update(input, caller, target, sources, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(executed, ['sessions.rename', 'sessions.setPinned']);
  assert.deepEqual(checks, [['sessions.rename', 'sessions.rename'], ['sessions.run', 'sessions.setPinned']], 'authorization is not prompted twice');
  executed = []; checks = [];
  const schedulerSelf = await update({ name: ' Scheduler ' }, caller, undefined, ['sessions.rename'], deps);
  assert.equal(schedulerSelf.ok, true); assert.deepEqual(executed, ['sessions.rename']);
  await assert.rejects(update({ pinned: true }, caller, undefined, sources, deps), /Only the scheduler title/);
  const workerSelf = await update({ name: 'Worker' }, { kind: 'worker', sessionId: 'self' }, { id: 'self' }, ['sessions.rename'], deps);
  assert.equal(workerSelf.ok, true);
  executed = []; checks = [];
  await assert.rejects(update(input, caller, target, ['sessions.rename'], deps), /source is not authorized/);
  assert.deepEqual(executed, []); assert.deepEqual(checks, []);
  await assert.rejects(update(input, caller, target, sources, { ...deps, authorize: async (_source, operation) => {
    if (operation.tool === 'sessions.setPinned') throw new Error('denied'); return () => true;
  } }), /denied/);
  assert.deepEqual(executed, [], 'all requested operations are approved before any effect');
  const changed = await update(input, caller, target, sources, { ...deps, execute: async operation => {
    executed.push(operation.tool); permission = false; return { ok: true };
  } });
  assert.equal(changed.ok, false); assert.equal(changed.completed.length, 1);
  assert.match(changed.failed.error, /authorization changed/);
  permission = true; current = false;
  await assert.rejects(update(input, caller, target, sources, deps), /changed/);
  await assert.rejects(update({ sessionId: 'other', name: 'X' }, { kind: 'worker', sessionId: 'self' }, { id: 'other' }, sources, deps), /own session/);
  console.log('projected session update: preflight, scoped sources and partial outcomes passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
