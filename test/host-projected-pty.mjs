import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sessionProjectionFixture } from './helpers/session-projection.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-projected-pty-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { ptyProjectedCatalog } = await load('main/capabilities/catalog/projectedCatalog.ts');
  const { executeProjectedPty } = await load('main/capabilities/projectedPty.ts');
  const entries = ptyProjectedCatalog(true), calls = [];
  const self = { id: 'self' }, child = { id: 'child', parentSessionId: 'self' };
  const sessions = sessionProjectionFixture([self, child]);
  let current = true;
  const deps = { sessionId: 'self', resolveSession: ref => sessions.get(ref), sessionIdentity: id => sessions.peek(id),
    isCurrent: () => current, execute: async (name, args) => { calls.push([name, args]); return { ok: true, result: name }; },
    ask: async args => ({ confirmed: args.kind === 'confirm' }) };
  const run = (name, args) => executeProjectedPty(entries, name, args, deps);
  assert.equal((await run('host.mail.read', {})).ok, true);
  assert.deepEqual(calls.splice(0), [['sessions.readMessages', {}]]);
  const update = await run('host.sessions.update', { sessionId: 'child', archived: true });
  assert.equal(update.ok, true);
  assert.equal(calls[0][0], 'sessions.setArchived');
  assert.equal(calls[0][1].__actorSessionId, 'self');
  calls.length = 0;
  assert.equal((await run('host.sessions.update', { name: 'Self name' })).ok, true, 'fresh projections permit self rename');
  calls.length = 0;
  let firstResolve = true;
  await assert.rejects(executeProjectedPty(entries, 'host.sessions.update', { sessionId: 'child', archived: true }, {
    ...deps, resolveSession: ref => {
      const row = sessions.get(ref);
      if (firstResolve) { firstResolve = false; child.parentSessionId = 'other'; }
      return row;
    }
  }), /changed/);
  child.parentSessionId = 'self';
  assert.deepEqual(calls, [], 'changed parent authority cannot archive a child');
  await assert.rejects(run('host.sessions.update', { sessionId: 'child', name: 'No' }), /own session/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await run('host.ask', { kind: 'confirm', title: 'Proceed?' }), { confirmed: true });
  current = false;
  await assert.rejects(run('host.mail.read', {}), /changed/);
  console.log('PTY projected execution: identity, source routes and question passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
