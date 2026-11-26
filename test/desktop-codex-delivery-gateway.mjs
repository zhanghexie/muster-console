import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'codex-delivery-gateway-'));
let gateway, bridge;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { CodexDesktopDelivery, captureCodexWin32DeliverySlot } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/desktopDelivery.ts')));
  const { createDesktopEngineDeliverySelector } = await import(pathToFileURL(compile('main/desktop/desktopEngineDelivery.ts')));
  const { runWithDesktopDeliveryInvocation, captureInvocationCuaSlot } = await import(pathToFileURL(compile('main/desktop/desktopDeliveryInvocation.ts')));
  const { startHostToolGateway } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/hostToolGateway.ts')));
  const { runAsGuiExecutionTurn } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const errors = [], acknowledgements = [];
  let hostTurn = 'host-turn', targetCurrent = true, indicatorCurrent = true, afterStage, beforeAcknowledge;
  const actionSignal = new AbortController();
  bridge = new CodexDesktopDelivery(() => hostTurn, reason => errors.push(reason));
  const selector = createDesktopEngineDeliverySelector();
  const effect = { ok: true, delivery: 'foreground', effect: 'unverifiable', verification: 'not_performed' };
  const tool = { id: 'host.desktop.act', label: 'desktop', description: 'fixture', permissionClass: 'status',
    resultFormat: 'execute-result-json', parameters: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false },
    execute: async args => runAsGuiExecutionTurn({ sessionId: 'fixture', turnId: 'host-turn', desktopTurnId: 'desktop-turn',
      isCurrent: () => hostTurn === 'host-turn', isDesktopCurrent: () => hostTurn === 'host-turn' }, async () => {
      const invocationId = randomUUID(), actor = { sessionId: 'fixture', taskId: 'task', turnId: 'desktop-turn', isCurrent: () => true };
      return runWithDesktopDeliveryInvocation({ actor,
        lease: { owner: 'fixture', turnId: 'desktop-turn', signal: actionSignal.signal, isCurrent: () => !actionSignal.signal.aborted },
        indicatorEpoch: 1, targetWindowId: 'window', isIndicatorCurrent: () => indicatorCurrent, isTargetCurrent: () => targetCurrent, onUnknown() {} }, async () => {
      const slot = captureInvocationCuaSlot(selector, { actor, hostWindowId: 'window', requestId: args.requestId,
        fingerprint: 'fingerprint', action: 'click', targetGeneration: 'generation',
        isTargetCurrent: () => targetCurrent, isCurrent: () => true });
      await slot.stageDelivery(invocationId, effect, async () => {
        if (beforeAcknowledge) await beforeAcknowledge();
        if (slot.lease.signal.aborted || !slot.lease.isCurrent()) return { outcome: 'unknown', reason: 'stopped' };
        acknowledgements.push(invocationId); return { outcome: 'acknowledged' };
      });
      if (afterStage) await afterStage();
      return JSON.stringify({ ok: true, result: { outcome: 'dispatched', invocationId, ...effect } });
      });
    }) };
  let alterWindowsResult = false;
  const windows = { ...tool, id: 'host.desktop.win32', execute: async () => runAsGuiExecutionTurn({ sessionId: 'fixture', turnId: 'host-turn',
    desktopTurnId: 'desktop-turn', isCurrent: () => hostTurn === 'host-turn', isDesktopCurrent: () => hostTurn === 'host-turn' }, async () => {
    const invocationId = randomUUID(), winEffect = { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' };
    const slot = captureCodexWin32DeliverySlot({ sessionId: 'fixture', taskId: 'task', turnId: 'desktop-turn', isCurrent: () => true }, {
      lease: { owner: 'fixture', turnId: 'desktop-turn', signal: actionSignal.signal, isCurrent: () => !actionSignal.signal.aborted },
      indicatorEpoch: 1, isIndicatorCurrent: () => indicatorCurrent, isTargetCurrent: () => targetCurrent, onUnknown: () => {} });
    await slot.stageDelivery(invocationId, winEffect, async () => { acknowledgements.push(invocationId); return { outcome: 'acknowledged' }; });
    return JSON.stringify({ ok: true, result: { outcome: 'dispatched', invocationId,
      value: alterWindowsResult ? { ...winEffect, effect: 'confirmed' } : winEffect } });
  }) };
  gateway = await startHostToolGateway({ sessionId: 'fixture', cwd: temp, hostTools: [tool, windows], getTurnId: () => hostTurn,
    requestApproval: async () => ({ approved: true }), getPolicyState: () => ({ mode: 'auto', planExecuting: false }), log() {} }, { interceptor: bridge });
  const call = async (requestId, name = 'host_desktop_act') => {
    const args = { requestId };
    const response = await fetch(gateway.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: gateway.token, name, arguments: args }) });
    return { ...(await response.json()), args, name };
  };
  const event = (result, id = 'item-1') => ({ method: 'item/completed', params: { threadId: 'thread', turnId: 'native-turn', item: {
    id, type: 'mcpToolCall', server: 'muster', tool: result.name, arguments: result.args, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: result.text }], structuredContent: null, _meta: null } } } });

  const unarmed = await call('unarmed');
  assert.equal(unarmed.isError, true, 'SDK fallback has no trusted delivery event and cannot stage a write');
  bridge.begin('host-turn');
  const early = await call('early');
  assert.equal(early.isError, false);
  assert.equal(acknowledgements.length, 0, 'a gateway response is not an engine receipt');
  bridge.bind('host-turn', 'thread', 'native-turn');
  await bridge.observe('host-turn', event(early));
  assert.equal(acknowledgements.length, 1, 'the exact matching native completion acknowledges once');
  await bridge.observe('host-turn', event(early));
  assert.equal(acknowledgements.length, 1);
  const mismatch = await call('mismatch');
  const wrong = event(mismatch, 'item-2');
  wrong.params.item.result.content[0].text += ' changed';
  await bridge.observe('host-turn', wrong);
  assert.equal(acknowledgements.length, 1);
  assert.ok(errors.includes('result-mismatch'));
  const stale = await call('stale');
  targetCurrent = false;
  await bridge.observe('host-turn', event(stale, 'item-3'));
  assert.equal(acknowledgements.length, 1);
  assert.ok(errors.includes('invalidated'));
  targetCurrent = true;
  const pending = await call('pending');
  bridge.end('host-turn');
  await bridge.observe('host-turn', event(pending, 'item-4'));
  assert.equal(acknowledgements.length, 1, 'turn end invalidates late events');
  bridge.begin('host-turn'); bridge.bind('host-turn', 'thread', 'native-turn');
  let enterAck, releaseAck;
  const ackEntered = new Promise(resolve => { enterAck = resolve; });
  const ackGate = new Promise(resolve => { releaseAck = resolve; });
  beforeAcknowledge = () => { enterAck(); return ackGate; };
  const racing = await call('racing');
  const observing = bridge.observe('host-turn', event(racing, 'item-racing'));
  await ackEntered;
  bridge.end('host-turn');
  releaseAck();
  await observing;
  assert.equal(acknowledgements.length, 1, 'turn end must invalidate a confirmation already waiting on a lock');
  assert.ok(errors.includes('acknowledgement-unknown'));
  beforeAcknowledge = undefined;
  bridge.begin('host-turn'); bridge.bind('host-turn', 'thread', 'native-turn');
  afterStage = async () => { indicatorCurrent = false; };
  const hidden = await call('hidden');
  assert.equal(hidden.isError, true, 'a lost indicator cannot produce a successful desktop result');
  assert.ok(errors.includes('semantic-result-unconfirmed'));
  indicatorCurrent = true; afterStage = undefined;
  const win = await call('windows', 'host_desktop_win32');
  assert.equal(win.isError, false);
  await bridge.observe('host-turn', event(win, 'windows-item'));
  assert.equal(acknowledgements.length, 2, 'Windows coordinate results use the same private engine delivery proof');
  alterWindowsResult = true;
  const alteredWin = await call('windows-altered', 'host_desktop_win32');
  assert.equal(alteredWin.isError, true, 'a changed Windows effect is not registered for delivery');
  assert.equal(acknowledgements.length, 2);
  console.log('Codex desktop delivery gateway: native identity, exact output and invalidation passed');
} finally { bridge?.close(); gateway?.close(); removeWorkspaceFixture(temp, 'codex-delivery-gateway-'); }
