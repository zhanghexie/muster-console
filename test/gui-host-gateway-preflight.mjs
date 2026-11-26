import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'gui-host-preflight-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createGuiHostToolGateway } = await import(pathToFileURL(compile('main/agentSession/tools/gateway.ts')));
  const { currentGuiExecutionTurn, runOutsideAgentScope, runAsGuiExecutionTurn } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const { currentToolInvocation } = await import(pathToFileURL(compile('main/runtimeKernel/toolInvocation.ts')));
  let capturedInvocation;
  let turn = 'one', desktopTurn = 'desktop-one', mode = 'auto', executions = 0;
  let capturedTurn;
  const gateway = createGuiHostToolGateway({ sessionId: 'worker', cwd: temp,
    hostTools: [{ id: 'example.read', label: 'read', description: 'read', permissionClass: 'read',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      async execute(args) {
        executions++;
        capturedTurn = currentGuiExecutionTurn();
        capturedInvocation = currentToolInvocation();
        assert.equal(capturedInvocation.sessionId, 'worker');
        assert.equal(capturedInvocation.turnId, turn);
        assert.equal(capturedTurn.sessionId, 'worker');
        assert.equal(capturedTurn.turnId, turn);
        assert.equal(capturedTurn.isCurrent(), true);
        assert.equal(capturedTurn.desktopTurnId, desktopTurn);
        assert.equal(capturedTurn.isDesktopCurrent(), true);
        await Promise.resolve();
        assert.equal(currentGuiExecutionTurn(), capturedTurn);
        assert.equal(currentToolInvocation(), capturedInvocation);
        assert.equal(runOutsideAgentScope(() => currentToolInvocation()), undefined);
        assert.equal(runOutsideAgentScope(() => currentGuiExecutionTurn()), undefined);
        return args.value;
      } }],
    getPolicyState: () => ({ mode, planExecuting: false }), getTurnId: () => turn, getDesktopTurnId: () => desktopTurn,
    requestApproval: async () => ({ approved: true }) });
  const first = await gateway.prepare('example_read', { value: 'one', toolCallId: 'forged', turnId: 'forged' }, { id: 'call-1' });
  assert.equal(first.ok, true); assert.equal(executions, 0, 'preflight must not run effects');
  assert.deepEqual(await first.execute(), { ok: true, text: 'one' });
  assert.equal(capturedInvocation.toolCallId, 'call-1');
  assert.equal(currentToolInvocation(), undefined, 'tool identity must not leak to caller');
  desktopTurn = 'desktop-two';
  assert.equal(capturedTurn.isCurrent(), true, 'engine turn remains live across steering');
  assert.equal(capturedTurn.isDesktopCurrent(), false, 'desktop identity must expire at steering');
  assert.equal(currentGuiExecutionTurn(), undefined, 'turn identity must not leak to the caller');
  assert.equal(executions, 1);
  assert.equal((await first.execute()).ok, false, 'a prepared call can execute only once');
  const stale = await gateway.prepare('example_read', { value: 'two' }, { id: 'call-2' });
  assert.equal(stale.ok, true); turn = 'two';
  assert.equal(capturedTurn.isCurrent(), false, 'the trusted turn becomes stale when the host advances');
  assert.equal((await stale.execute()).ok, false, 'a turn change invalidates a prepared call');
  assert.equal(executions, 1);
  const changing = await gateway.prepare('example_read', { value: 'policy' }, { id: 'call-policy' });
  assert.equal(changing.ok, true); mode = 'default';
  assert.match((await changing.execute()).text, /permissions or parameters changed/);
  assert.equal(executions, 1); mode = 'auto';
  assert.equal((await gateway.invoke('example_read', { value: 'three' }, { id: 'call-3' })).ok, true);
  assert.equal(executions, 2);
  const unbound = createGuiHostToolGateway({ sessionId: 'other', cwd: temp,
    hostTools: [{ id: 'example.read', label: 'read', description: 'read', permissionClass: 'read',
      parameters: { type: 'object' }, async execute() { assert.equal(currentGuiExecutionTurn(), undefined); return 'ok'; } }],
    getPolicyState: () => ({ mode: 'auto', planExecuting: false }), requestApproval: async () => ({ approved: true }) });
  await runAsGuiExecutionTurn({ sessionId: 'worker', turnId: 'stale', isCurrent: () => false }, async () => {
    assert.equal((await unbound.invoke('example.read', {}, { id: 'unbound' })).ok, true);
  });
  console.log('GUI host gateway: preflight and single-use turn binding passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
