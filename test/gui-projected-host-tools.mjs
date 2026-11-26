import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sessionProjectionFixture } from './helpers/session-projection.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-projected-tools-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { buildProjectedGuiTools } = await import(pathToFileURL(compile('main/agentSession/tools/projectedGuiTools.ts')));
  const { currentGuiExecutionTurn } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const { createPromptAuthorityScope, currentMemoryTurn, currentTurnUserText, isCurrentTurnNetworkTainted, markTurnNetworkTaint } =
    await import(pathToFileURL(compile('main/agent/turnScope.ts')));
  let mode = 'auto', count = 0;
  let desktopTurn = 'desktop-one', desktopStarted, finishDesktop;
  const enteredDesktop = new Promise(resolve => { desktopStarted = resolve; });
  const desktopGate = new Promise(resolve => { finishDesktop = resolve; });
  let mutationStarted, finishMutation;
  const enteredMutation = new Promise(resolve => { mutationStarted = resolve; });
  const mutationGate = new Promise(resolve => { finishMutation = resolve; });
  const tool = (id, permissionClass, parameters) => ({ id, label: id, description: id, permissionClass, parameters,
    async execute(args, exec) { count++; assert.equal(exec.sessionId, 'self'); return JSON.stringify({ ok: true, result: args }); },
    resultFormat: 'execute-result-json' });
  const hostTools = [
    tool('sessions.rename', 'status', { type: 'object', properties: { sessionId: { type: 'string' }, name: { type: 'string' } }, required: ['name'] }),
    tool('sessions.setArchived', 'edit', { type: 'object', properties: { sessionIds: { type: 'array', items: { type: 'string' } }, archived: { type: 'boolean' } }, required: ['sessionIds', 'archived'] }),
    tool('sessions.readMessages', 'read', { type: 'object', properties: {} }),
    { id: 'desktop.look', label: 'desktop', description: 'desktop', permissionClass: 'read', resultFormat: 'execute-result-json',
      parameters: { type: 'object', properties: { surfaceId: { type: 'string' } }, required: ['surfaceId'] },
      async execute() { assert.equal(currentGuiExecutionTurn().desktopTurnId, 'desktop-one'); desktopStarted(); await desktopGate; return JSON.stringify({ ok: true, result: {} }); } },
    { id: 'desktop.act', label: 'act', description: 'act', permissionClass: 'read', resultFormat: 'execute-result-json',
      parameters: { type: 'object', properties: { surfaceId: { type: 'string' }, requestId: { type: 'string' },
        action: { type: 'string' }, target: { type: 'object' } }, required: ['surfaceId', 'requestId', 'action', 'target'] },
      async execute() { mutationStarted(); await mutationGate; return JSON.stringify({ ok: true, result: {} }); } }
  ];
  const input = { sessionId: 'self', cwd: temp, hostTools, getPolicyState: () => ({ mode, planExecuting: false }),
    getTurnId: () => 'turn', getDesktopTurnId: () => desktopTurn, requestApproval: async () => ({ approved: true }),
    requestUserQuestion: async () => ({ kind: 'answered', answers: [{ id: 'host-confirm', selected: ['确认'] }] }) };
  const sessions = sessionProjectionFixture([{ id: 'self' }, { id: 'child', parentSessionId: 'self' }, { id: 'other' }]);
  sessions.resolveSessionRef = ({ sessionId }) => ({ id: sessionId });
  const ctx = { sessions };
  const tools = buildProjectedGuiTools(ctx, input);
  const get = id => tools.find(item => item.id === id);
  assert.ok(get('host.mail.read')); assert.ok(get('host.sessions.update')); assert.ok(get('host.ask'));
  assert.equal(get('sessions.readMessages'), undefined);
  const call = (id, args) => get(id).execute(args, { sessionId: 'self', cwd: temp });
  assert.equal(JSON.parse(await call('host.mail.read', {})).ok, true);
  const catalogFailure = { ok: false, cancelled: true, cancelledBy: 'button', error: 'cancelled' };
  const failedRead = (execute) => buildProjectedGuiTools(ctx, { ...input,
    hostTools: [{ ...tool('sessions.readMessages', 'read', { type: 'object', properties: {} }), execute }]
  }).find(t => t.id === 'host.mail.read').execute({}, { sessionId: 'self', cwd: temp });
  assert.deepEqual(JSON.parse(await failedRead(async () => JSON.stringify(catalogFailure))), catalogFailure);
  assert.deepEqual(JSON.parse(await failedRead(async () => { throw Error('{"ok":true}'); })),
    { ok: false, error: '{"ok":true}' }, 'a thrown error is text even if it resembles an envelope');
  const renamed = JSON.parse(await call('host.sessions.update', { name: 'New' }));
  assert.equal(renamed.ok, true);
  assert.equal(renamed.completed[0].result.result.name, 'New', 'GUI batch writes expose the effect as an object');
  const archiveFailure = { updated: [], archived: true, failed: [{ id: 'child', error: 'busy' }], count: 0 };
  const failingTools = buildProjectedGuiTools(ctx, { ...input, hostTools: hostTools.map(tool =>
    tool.id === 'sessions.setArchived' ? { ...tool, execute: async () => JSON.stringify({ ok: true, result: archiveFailure }) } : tool) });
  const archive = failingTools.find(tool => tool.id === 'host.sessions.update');
  const batchFailure = JSON.parse(await archive.execute({ sessionId: 'child', archived: true }, { sessionId: 'self', cwd: temp }));
  assert.equal(batchFailure.ok, false, 'a failed business operation must stop the batch even when the tool executed successfully');
  assert.equal(batchFailure.failed.tool, 'sessions.setArchived');
  assert.deepEqual(JSON.parse(batchFailure.failed.error), archiveFailure);
  const forged = JSON.parse(await get('host.mail.read').execute({}, { sessionId: 'other', cwd: temp }));
  assert.equal(forged.ok, false, 'projected calls cannot change the connection identity');
  assert.equal(JSON.parse(await call('host.sessions.update', { sessionId: 'other', archived: true })).ok, false,
    'a Worker cannot archive an unrelated session through the merged tool');
  mode = 'ask';
  const blocked = JSON.parse(await call('host.sessions.update', { sessionId: 'child', archived: true }));
  assert.equal(blocked.ok, false, 'underlying edit permission remains enforced');
  assert.equal(count, 2);
  mode = 'standard';
  for (const change of [
    () => { sessions.sessions = sessions.sessions.filter(row => row.id !== 'child'); },
    () => { sessions.sessions = sessions.sessions.map(row => row.id === 'child' ? { ...row } : row); },
    () => { sessions.peek('child').parentSessionId = 'other'; },
    () => { mode = 'ask'; }
  ]) {
    let approved = false;
    const guardedTools = buildProjectedGuiTools(ctx, { ...input, requestApproval: async () => {
      approved = true; change(); return { approved: true };
    } });
    const guarded = guardedTools.find(item => item.id === 'host.sessions.update');
    const outcome = JSON.parse(await guarded.execute({ sessionId: 'child', archived: true }, { sessionId: 'self', cwd: temp }));
    assert.equal(approved, true, 'the race occurs after the actual permission prompt');
    assert.equal(outcome.ok, false, 'target identity, parent relation and caller permission are rechecked after approval');
    assert.equal(count, 2, 'an invalidated approval dispatches no setter');
    sessions.sessions = sessions.sessions.filter(row => row.id !== 'child');
    sessions.sessions.push({ id: 'child', parentSessionId: 'self' }); mode = 'standard';
  }
  const answer = JSON.parse(await call('host.ask', { kind: 'confirm', title: 'Proceed?' }));
  assert.equal(answer.ok, true); assert.equal(answer.result.confirmed, true);
  mode = 'auto';
  const oldDesktopCall = call('host.desktop.look', { surfaceId: 'display' });
  await enteredDesktop;
  desktopTurn = 'desktop-two';
  finishDesktop();
  assert.equal(JSON.parse(await oldDesktopCall).ok, false, 'a desktop result from before steering must not enter the new instruction');
  const oldMutation = call('host.desktop.act', { surfaceId: 'display', requestId: 'r1', action: 'click', target: { windowId: 'window', x: 1, y: 1 } });
  await enteredMutation;
  desktopTurn = 'desktop-three';
  finishMutation();
  const mutationResult = JSON.parse(await oldMutation);
  assert.equal(mutationResult.ok, false);
  assert.match(mutationResult.error, /outcome may be unknown/, 'a dispatched write must not be presented as a clean cancellation');
  let memoryAuthority = createPromptAuthorityScope('Remember my original preference.');
  const [remember] = buildProjectedGuiTools(ctx, {
    ...input,
    nativePermissions: true,
    getMemoryAuthority: () => memoryAuthority,
    hostTools: [{ ...tool('memory.remember', 'edit', { type: 'object', properties: {} }),
      async execute() {
        const result = { ...currentMemoryTurn(), userText: currentTurnUserText(), tainted: isCurrentTurnNetworkTainted() };
        markTurnNetworkTaint();
        return JSON.stringify({ ok: true, result });
      } }]
  });
  const externalRemember = async () => JSON.parse(await remember.execute({}, { sessionId: 'self', cwd: temp }));
  const firstRemember = await externalRemember();
  assert.equal(firstRemember.result.userText, 'Remember my original preference.');
  assert.equal(firstRemember.result.tainted, false);
  const secondRemember = await externalRemember();
  assert.equal(secondRemember.result.eventId, firstRemember.result.eventId);
  assert.equal(secondRemember.result.tainted, true, 'external callbacks retain the same turn taint');
  memoryAuthority.close();
  assert.equal((await externalRemember()).ok, false, 'retired authority cannot authorize another call');
  memoryAuthority = createPromptAuthorityScope(undefined);
  assert.equal((await externalRemember()).result.userText, undefined, 'host-only input never provides user evidence');
  memoryAuthority.close();
  console.log('GUI projected tools: legacy source permissions and host question passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
