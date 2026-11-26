import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-update-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { planSessionUpdate: plan, executeSessionUpdate } = await import(pathToFileURL(compile('main/capabilities/sessionUpdate.ts')));
  const scheduler = { kind: 'scheduler' }, worker = { kind: 'worker', sessionId: 'worker' };
  const self = { id: 'worker' }, child = { id: 'child', parentSessionId: 'worker' }, other = { id: 'other' };
  const operations = plan({ sessionId: 'child', name: ' title ', pinned: true, archived: true,
    orchestrated: false, model: null, thinking: null }, scheduler, child);
  assert.deepEqual(operations.map(op => op.tool), ['sessions.rename', 'sessions.setPinned', 'sessions.setOrchestrated',
    'sessions.setModel', 'sessions.setThinking', 'sessions.setArchived']);
  assert.equal(operations[0].args.name, 'title');
  assert.throws(() => plan({ sessionId: 'child', model: { providerId: 'p', modelId: 'm', unexpected: true } }, scheduler, child), /model requires/);
  assert.deepEqual(operations[3].args, { sessionId: 'child' });
  assert.deepEqual(plan({ sessionId: 'worker', name: 'self' }, worker, self)[0].args, { sessionId: 'worker', name: 'self' });
  assert.deepEqual(plan({ sessionId: 'child', archived: true }, worker, child)[0].args,
    { sessionIds: ['child'], archived: true, __actorSessionId: 'worker' });
  assert.throws(() => plan({ sessionId: 'other', name: 'no' }, worker, other), /only its own/);
  assert.throws(() => plan({ sessionId: 'other', archived: true }, worker, other), /direct child/);
  for (const field of [{ pinned: true }, { model: null }, { thinking: null }, { orchestrated: true }]) {
    assert.throws(() => plan({ sessionId: 'worker', ...field }, worker, self), /only to the scheduler/);
  }
  for (const invalid of [{}, { name: ' ' }, { pinned: 'false' }, { model: { providerId: '', modelId: 'x' } },
    { thinking: 'bogus' }, { arbitrary: 1 }]) {
    assert.throws(() => plan({ sessionId: 'child', ...invalid }, scheduler, child));
  }
  const called = [];
  const partial = await executeSessionUpdate(operations, async op => {
    called.push(op.tool);
    if (op.tool === 'sessions.setPinned') throw new Error('pinned failed');
    return { ok: true };
  });
  assert.equal(partial.ok, false);
  assert.deepEqual(called, ['sessions.rename', 'sessions.setPinned']);
  assert.deepEqual(partial.completed.map(item => item.tool), ['sessions.rename']);
  assert.match(partial.failed.error, /pinned failed/);
  const archiveFailure = await executeSessionUpdate([operations.at(-1)], async () => ({ failed: [{ id: 'child' }] }));
  assert.equal(archiveFailure.ok, false);
  const hostEntry = compile('main/capabilities/hosts/sessions.ts');
  fs.writeFileSync(compile('main/capabilities/hosts/creation.ts'), "export async function createSessionWithTask() { throw new Error('unused'); }\n");
  const { sessionsHost } = await import(pathToFileURL(hostEntry));
  const { runAsAgentSession, runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const records = new Map([[self.id, { ...self, name: 'worker' }], [child.id, { ...child, name: 'child' }]]);
  const ctx = { resolveBubbleWorkspaceId: () => 'workspace', renameAgentSession: async (_workspace, name) => ({ ok: true, name }), sessions: {
    resolveSessionRef: ({ sessionId }) => ({ id: sessionId }), get: id => records.get(id),
    rename: (id, name) => { records.get(id).name = name; return { id, name }; },
    setPinned: (id, pinned) => { records.get(id).pinned = pinned; return { id, pinned }; },
    setArchived: (id, archived) => { records.get(id).archived = archived; }
  } };
  await assert.rejects(sessionsHost['sessions.update'](ctx, { sessionId: 'worker', name: 'forged' }), /authenticated/);
  await runAsAgentSession('worker', async () => {
    assert.equal((await sessionsHost['sessions.update'](ctx, { name: 'new' })).ok, true);
    await assert.rejects(sessionsHost['sessions.update'](ctx, { sessionId: 'child', name: 'no', archived: true }), /only its own/);
    assert.equal(records.get('child').archived, undefined, 'invalid combination must not partially archive');
    assert.equal((await sessionsHost['sessions.update'](ctx, { sessionId: 'child', archived: true })).ok, true);
  });
  assert.equal(records.get('child').archived, true);
  await runAsSchedulerTool(async () => assert.equal((await sessionsHost['sessions.update'](ctx, { sessionId: 'child', pinned: true })).ok, true));
  await runAsSchedulerTool(async () => {
    assert.equal((await sessionsHost['sessions.update'](ctx, { name: 'scheduler title' })).ok, true);
    await assert.rejects(sessionsHost['sessions.update'](ctx, { pinned: true }), /without a session target/);
  });
  assert.equal(records.get('child').pinned, true);
  console.log('session update plan: field validation and per-caller authority passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
