import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-projected-policy-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { projectHostDefinitions } = await load('main/capabilities/catalog/hostProjection.ts');
  const { projectedPolicyRequests } = await load('main/capabilities/projectedPolicy.ts');
  const { TOOL_DEFS } = await load('main/capabilities/catalog/registry.ts');
  const { HOST_TOOL_METAS } = await load('shared/hostTools/index.ts');
  const resolve = name => TOOL_DEFS.find(def => def.name === name) ?? (() => {
    const meta = HOST_TOOL_METAS.find(item => item.id === name);
    return meta?.schema && { name, description: name, dangerous: false, parameters: meta.schema };
  })();
  const scheduler = projectHostDefinitions('scheduler', ['sessions.rename', 'sessions.run', 'sessions.readMessages', 'llm.quota', 'ui.confirm'], resolve);
  const request = (name, args, target = { id: 'one' }) => projectedPolicyRequests(scheduler, { kind: 'scheduler' }, name, args, target);
  assert.deepEqual(request('host.mail.read', {}), [{ source: 'sessions.readMessages', target: 'sessions.readMessages', args: {} }]);
  assert.deepEqual(request('host.llm.run', { action: 'quota', params: {} }), [{ source: 'llm.quota', target: 'llm.quota', args: {} }]);
  assert.deepEqual(request('host.ask', { kind: 'confirm', title: 'Continue?' }), [{ source: 'ui.confirm', target: 'ui.confirm', args: { title: 'Continue?' } }]);
  assert.deepEqual(request('host.sessions.update', { sessionId: 'one', name: 'New', pinned: true }), [
    { source: 'sessions.rename', target: 'sessions.rename', args: { sessionId: 'one', name: 'New' } },
    { source: 'sessions.run', target: 'sessions.setPinned', args: { sessionId: 'one', pinned: true } }
  ]);
  assert.throws(() => request('sessions.readMessages', {}), /Unknown host tool/);
  const worker = projectHostDefinitions('worker', ['sessions.rename', 'sessions.setArchived'], resolve, { hasQuestionChannel: true });
  assert.throws(() => projectedPolicyRequests(worker, { kind: 'worker', sessionId: 'self' }, 'host.sessions.update',
    { sessionId: 'other', name: 'No' }, { id: 'other' }), /own session/);
  assert.deepEqual(projectedPolicyRequests(worker, { kind: 'worker', sessionId: 'self' }, 'host.sessions.update',
    { archived: true, sessionId: 'child' }, { id: 'child', parentSessionId: 'self' }), [
      { source: 'sessions.setArchived', target: 'sessions.setArchived', args: { sessionIds: ['child'], archived: true, __actorSessionId: 'self' } }
    ]);
  console.log('projected host policy: exact source and all session operations passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
