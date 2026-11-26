import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'codex-delivery-'));
let runtime;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { CodexMcpToolDeliveryTracker } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/toolDelivery.ts')));
  const { createVisibleActionRuntime } = await import(pathToFileURL(compile('main/desktop/visibleActionFactory.ts')));
  runtime = createVisibleActionRuntime(path.join(temp, 'outbox.sqlite'), path.join(temp, 'locks'));
  const tracker = new CodexMcpToolDeliveryTracker(), failures = [], completed = [];
  const make = async (taskId, requestId) => {
    const state = { current: true };
    const ctx = { sessionId: 'session', taskId, target: 'window', action: 'click', indicatorEpoch: 1,
      isCurrent: () => state.current, isIndicatorCurrent: epoch => epoch === 1 };
    const action = await runtime.coordinator.run(ctx, async () => ({ effect: 'unverifiable' }));
    assert.equal(action.outcome, 'known');
    const args = { requestId, action: 'click', target: { windowId: 'opaque-window' } };
    const outputText = JSON.stringify({ outcome: 'dispatched', invocationId: action.invocationId, value: action.value });
    const expectation = { threadId: 'thread', turnId: 'turn', server: 'muster', tool: 'host_desktop_act', arguments: args,
      invocationId: action.invocationId, outputText, isCurrent: () => state.current,
      acknowledge: async () => { completed.push(action.invocationId); return runtime.coordinator.acknowledgeKnown(ctx, action.invocationId, `delivery-${taskId}`, action.deliveryToken); },
      onUnconfirmed: reason => failures.push([taskId, reason]) };
    tracker.expect(expectation);
    const event = { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: {
      type: 'mcpToolCall', id: `item-${taskId}`, server: 'muster', tool: 'host_desktop_act', status: 'completed', arguments: args,
      result: { content: [{ type: 'text', text: outputText }], structuredContent: null, _meta: null }, error: null } } };
    return { state, ctx, action, event, expectation };
  };

  const first = await make('first', 'request-1');
  tracker.expect({ ...first.expectation });
  assert.throws(() => tracker.expect({ ...first.expectation, outputText: `${first.expectation.outputText} changed` }), /conflicts/);
  await tracker.observe({ ...first.event, params: { ...first.event.params, threadId: 'other' } });
  assert.equal(completed.length, 0, 'another thread cannot acknowledge the result');
  await tracker.observe({ ...first.event, params: { ...first.event.params, item: { ...first.event.params.item,
    arguments: { ...first.event.params.item.arguments, requestId: 'other' } } } });
  assert.equal(completed.length, 0, 'a different call cannot acknowledge the result');
  await tracker.observe(first.event);
  assert.deepEqual(completed, [first.action.invocationId]);
  assert.equal((await runtime.coordinator.run(first.ctx, async () => ({ next: true }))).outcome, 'known');
  await tracker.observe(first.event);
  assert.equal(completed.length, 1, 'a repeated event cannot acknowledge twice');

  const changed = await make('changed', 'request-2');
  const changedEvent = structuredClone(changed.event);
  changedEvent.params.item.result.content[0].text += ' altered';
  await tracker.observe(changedEvent);
  assert.deepEqual(failures.at(-1), ['changed', 'result-mismatch']);
  await assert.rejects(runtime.coordinator.run(changed.ctx, async () => true), /not dispatched/);

  for (const [suffix, field, value] of [['error', 'isError', true], ['structured', 'structured_content', { altered: true }],
    ['extra', 'unexpected', 'value']]) {
    const other = await make(`other-${suffix}`, `request-${suffix}`);
    other.event.params.item.result[field] = value;
    await tracker.observe(other.event);
    assert.deepEqual(failures.at(-1), [`other-${suffix}`, 'result-mismatch'], 'extra result fields cannot be silently acknowledged');
    await assert.rejects(runtime.coordinator.run(other.ctx, async () => true), /not dispatched/);
  }

  const stopped = await make('stopped', 'request-3');
  stopped.state.current = false;
  await tracker.observe(stopped.event);
  assert.deepEqual(failures.at(-1), ['stopped', 'invalidated']);
  stopped.state.current = true;
  await assert.rejects(runtime.coordinator.run(stopped.ctx, async () => true), /not dispatched/);

  const ambiguousA = await make('ambiguous-a', 'same-request');
  await make('ambiguous-b', 'same-request');
  await tracker.observe(ambiguousA.event);
  assert.deepEqual(failures.slice(-2).map(row => row[1]), ['ambiguous', 'ambiguous']);
  assert.equal(completed.length, 1);

  const pending = await make('close', 'request-4');
  tracker.close(); tracker.close();
  assert.deepEqual(failures.at(-1), ['close', 'tracker-closed']);
  await tracker.observe(pending.event);
  await assert.rejects(runtime.coordinator.run(pending.ctx, async () => true), /not dispatched/);
  console.log('Codex MCP delivery candidate: exact result, turn binding and failure barriers passed');
} finally { runtime?.close(); removeWorkspaceFixture(temp, 'codex-delivery-'); }
