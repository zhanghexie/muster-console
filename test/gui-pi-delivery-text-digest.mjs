/** Exact UTF-16 text across the GUI parent/worker receipt, including lone surrogates. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const root = process.cwd(), prefix = 'gui-pi-delivery-digest-';
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', prefix));
try {
  const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
  const { GuiPiDesktopDelivery, captureGuiPiCuaDeliverySlot } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/desktopDelivery.ts')));
  const { PiWorkerDesktopDelivery } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/childDesktopDelivery.ts')));
  const { runAsGuiExecutionTurn } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const digest = text => createHash('sha256').update(text, 'utf16le').digest('hex');
  const effect = { ok: true, delivery: 'dispatched', effect: 'confirmed', verification: 'not_performed', code: '\ud800' };
  const invocationId = '11111111-1111-4111-8111-111111111111';
  const text = JSON.stringify({ ok: true, result: { outcome: 'dispatched', ...effect, invocationId } }).replace('\\ud800', '\ud800');
  const forged = text.replace('\ud800', '\udc00');
  assert.notEqual(text, forged);
  assert.deepEqual(Buffer.from(text, 'utf8'), Buffer.from(forged, 'utf8'), 'UTF-8 alone cannot distinguish these strings');
  const lease = { owner: 'session', turnId: 'desktop-turn', signal: new AbortController().signal, isCurrent: () => true };
  const actor = { sessionId: 'session', taskId: 'task', turnId: 'desktop-turn', isCurrent: () => true };
  let acknowledgements = 0;
  const parent = new GuiPiDesktopDelivery(() => 'host-turn', () => true, () => {});
  parent.begin(1, 'host-turn');
  const result = await runAsGuiExecutionTurn({ sessionId: 'session', turnId: 'host-turn', desktopTurnId: 'desktop-turn',
    isCurrent: () => true, isDesktopCurrent: () => true }, () => parent.run({ generation: 1, id: 'call',
    signal: new AbortController().signal, isCurrent: () => true }, async () => {
    const slot = captureGuiPiCuaDeliverySlot({ actor, targetGeneration: 'target', isTargetCurrent: () => true },
      { lease, indicatorEpoch: 1, isIndicatorCurrent: () => true, isTargetCurrent: () => true });
    slot.stageDelivery(invocationId, effect, async () => { acknowledgements++; return { outcome: 'acknowledged' }; });
    return { ok: true, text };
  }));
  assert.ok(result.desktopDeliveryProof);
  const signal = new AbortController().signal;
  assert.equal((await parent.acknowledge(1, 'call', result.desktopDeliveryProof, digest(forged), signal)).outcome, 'unknown');
  assert.equal(acknowledgements, 0, 'a UTF-8-equivalent forgery must not reach the parent closure');
  assert.equal((await parent.acknowledge(1, 'call', result.desktopDeliveryProof, digest(text), signal)).outcome, 'acknowledged');
  assert.equal(acknowledgements, 1);
  parent.close();

  const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1:9',
    reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let agent, requests = 0, proofReceived;
  const delivery = new PiWorkerDesktopDelivery(() => 1, () => true, async proof => {
    proofReceived = proof; return { outcome: 'acknowledged' };
  }, () => assert.fail('valid result must not be abandoned'));
  const tool = { name: 'host_desktop_act', label: 'Act', description: 'offline fixture', parameters: Type.Object({}),
    async execute(id, _args, toolSignal) {
      delivery.expect({ generation: 1, toolCallId: id, toolName: 'host_desktop_act', text,
        proof: 'x'.repeat(43), signal: toolSignal });
      return { content: [{ type: 'text', text }], details: {} };
    } };
  agent = new Agent({ initialState: { model, tools: [tool] }, streamFn: () => {
    const first = ++requests === 1;
    const message = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'call', name: tool.name, arguments: {} }] : [],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); });
    return stream;
  } });
  delivery.attach(agent);
  await agent.prompt('Run the fixture.');
  assert.equal(proofReceived?.textDigest, digest(text), 'the worker hashes exactly the text seen in turn_end');
  assert.notEqual(proofReceived.textDigest, digest(forged));
  delivery.close();
  console.log('gui-pi-delivery-text-digest: parent and native Pi tracker reject UTF-8-equivalent text');
} finally { removeWorkspaceFixture(tmp, prefix); }
