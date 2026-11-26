import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-projected-exec-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { projectHostDefinitions } = await load('main/capabilities/catalog/hostProjection.ts');
  const { executeProjectedHostCall } = await load('main/capabilities/projectedExecution.ts');
  const { TOOL_DEFS } = await load('main/capabilities/catalog/registry.ts');
  const resolve = name => TOOL_DEFS.find(def => def.name === name);
  const entries = projectHostDefinitions('scheduler', ['sessions.rename', 'sessions.run', 'sessions.readMessages', 'ui.confirm'], resolve);
  let current = true, allowed = true, dispatched = [], approvals = [];
  const deps = { isCurrent: () => current,
    authorize: async request => { approvals.push(request.source); return () => allowed; },
    dispatch: async (target, args) => { dispatched.push([target, args]); return { ok: true }; },
    ask: async route => { dispatched.push([route.tool, route.args]); return { confirmed: false }; } };
  const run = (name, args, target) => executeProjectedHostCall(entries, { kind: 'scheduler' }, name, args, target, deps);
  assert.deepEqual(await run('host.mail.read', {}), { ok: true });
  assert.deepEqual(dispatched.shift(), ['sessions.readMessages', {}]);
  assert.deepEqual(await run('host.ask', { kind: 'confirm', title: 'Proceed?' }), { confirmed: false });
  assert.deepEqual(dispatched.shift(), ['ui.confirm', { title: 'Proceed?' }]);
  assert.deepEqual(approvals.splice(0), ['sessions.readMessages', 'ui.confirm']);
  const update = await run('host.sessions.update', { sessionId: 'one', name: 'New', pinned: true }, { id: 'one' });
  assert.equal(update.ok, true);
  assert.deepEqual(approvals.splice(0), ['sessions.rename', 'sessions.run']);
  assert.deepEqual(dispatched.splice(0).map(item => item[0]), ['sessions.rename', 'sessions.setPinned']);
  allowed = false;
  await assert.rejects(run('host.mail.read', {}), /authorization changed/);
  assert.deepEqual(dispatched, []);
  allowed = true; current = false;
  await assert.rejects(run('host.mail.read', {}), /caller or target changed/);
  assert.deepEqual(dispatched, []);
  console.log('projected execution: source authorization, question routing and preflight passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
