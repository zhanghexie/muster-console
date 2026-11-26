import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sessionProjectionFixture } from './helpers/session-projection.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-projected-scheduler-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { projectHostDefinitions } = await load('main/capabilities/catalog/hostProjection.ts');
  const { TOOL_DEFS } = await load('main/capabilities/catalog/registry.ts');
  const { executeProjectedScheduler } = await load('main/capabilities/projectedScheduler.ts');
  const entries = projectHostDefinitions('scheduler', ['sessions.rename', 'sessions.run', 'sessions.readMessages', 'ui.confirm'],
    name => TOOL_DEFS.find(def => def.name === name));
  const session = { id: 'one', type: 'terminal', runtime: 'acp', workspaceId: 'w', parentSessionId: 'parent' }, calls = [];
  const sessions = sessionProjectionFixture([session]);
  assert.notEqual(sessions.get('one'), sessions.get('one'), 'real get() produces fresh projections');
  let current = true;
  const deps = { resolveSession: ref => sessions.get(ref === 'prefix' ? 'one' : ref),
    sessionIdentity: id => sessions.peek(id), isCurrent: () => current, execute: async (name, args) => {
      calls.push([name, args]);
      if (name === 'sessions.rename') session.name = args.name;
      if (name === 'sessions.setPinned') session.pinned = args.pinned;
      if (name === 'sessions.setModel') session.modelOverride = { providerId: args.providerId, modelId: args.modelId };
      if (name === 'sessions.setThinking') session.thinkingLevel = args.level;
      return { ok: true, result: name };
    } };
  const run = (name, args, hidden) => executeProjectedScheduler(entries, name, args, deps, hidden);
  assert.equal((await run('host.mail.read', {})).ok, true);
  assert.deepEqual(calls.splice(0)[0], ['sessions.readMessages', {}]);
  const updated = await run('host.sessions.update', { sessionId: 'prefix', name: 'Name', pinned: true });
  assert.equal(updated.ok, true);
  assert.deepEqual(calls.splice(0), [['sessions.rename', { sessionId: 'one', name: 'Name' }], ['sessions.setPinned', { sessionId: 'one', pinned: true }]]);
  assert.equal(session.name, 'Name'); assert.equal(session.pinned, true, 'own earlier changes do not invalidate later fields');
  assert.equal((await run('host.sessions.update', { sessionId: 'one', model: { providerId: 'p', modelId: 'm' }, thinking: 'high' })).ok, true);
  assert.deepEqual(calls.splice(0).map(call => call[0]), ['sessions.setModel', 'sessions.setThinking'],
    'requested model updates do not invalidate the remaining thinking update');
  for (const change of [
    () => sessions.sessions.splice(0),
    () => { sessions.sessions[0] = { ...session }; },
    () => { session.parentSessionId = 'different-parent'; },
    () => { session.workspaceId = 'different-workspace'; }
  ]) {
    const interrupted = await executeProjectedScheduler(entries, 'host.sessions.update', { sessionId: 'one', name: 'First', pinned: false }, {
      ...deps, execute: async (name, args) => { calls.push([name, args]); change(); return { ok: true }; }
    });
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.completed.length, 1, 'the completed first field remains reported');
    assert.equal(interrupted.failed.tool, 'sessions.setPinned');
    assert.deepEqual(calls.splice(0).map(call => call[0]), ['sessions.rename']);
    session.parentSessionId = 'parent'; session.workspaceId = 'w'; sessions.sessions = [session];
  }
  await assert.rejects(run('host.sessions.update', { sessionId: 'one', name: 'Name', pinned: true }, { groups: [], tools: ['sessions.setPinned'] }), /hidden/);
  assert.deepEqual(calls, [], 'all fields are preflighted before any action');
  await assert.rejects(run('host.sessions.update', { sessionId: 'missing', name: 'Name' }), /not found/);
  const failing = { ...deps, execute: async (name, args) => {
    calls.push([name, args]); return name === 'sessions.rename' ? { ok: true, result: { ok: false, error: 'rejected' } } : { ok: true };
  } };
  const failure = await executeProjectedScheduler(entries, 'host.sessions.update', { sessionId: 'one', name: 'Name', pinned: true }, failing);
  assert.equal(failure.ok, false, 'nested handler failures stop later setters');
  assert.deepEqual(calls.splice(0).map(call => call[0]), ['sessions.rename']);
  current = false;
  await assert.rejects(run('host.mail.read', {}), /changed/);
  assert.deepEqual(calls, []);
  console.log('scheduler projected execution: normalized targets and all-field preflight passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
