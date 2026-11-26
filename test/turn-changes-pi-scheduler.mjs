/** Real Pi agent-core waits for review; AgentSession-style forwarding does not. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-pi-scheduler-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const { subscribePiReview } = await import(pathToFileURL(compile('main/agent/providers/reviewEvents.ts')));
const work = path.join(tmp, 'work'); fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'a'), 'before');
const service = new TurnChangeService(path.join(tmp, 'store'));
const tracker = service.begin('dispatch:ws', 'm', work, [work]);
try {
  const agent = new Agent({ streamFn: () => { throw new Error('the offline fixture must not call a model'); } });
  // processEvents is the installed SDK's real event dispatcher; a minimal
  // active run supplies the signal without contacting a model or server.
  agent.activeRun = { abortController: new AbortController() };
  agent.subscribe(event => {
    if (event.type === 'tool_execution_start') void tracker.toolStart(event.toolCallId, event.toolName, event.args);
    if (event.type === 'tool_execution_end') void tracker.toolEnd(event.toolCallId, !event.isError);
  });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const originalStart = tracker.toolStart.bind(tracker);
  tracker.toolStart = async (...args) => { if (args[4] === true) await gate; return originalStart(...args); };
  const unsub = subscribePiReview({ agent, subscribe: () => () => {} }, tracker);
  let settled = false;
  const prewrite = agent.processEvents({ type: 'tool_execution_start', toolCallId: 'write', toolName: 'write', args: { path: 'a', content: 'after' } }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'Pi agent-core must wait for the verified pre-write read');
  release(); await prewrite;
  fs.writeFileSync(path.join(work, 'a'), 'after');
  await agent.processEvents({ type: 'tool_execution_end', toolCallId: 'write', toolName: 'write', isError: false });
  unsub(); const summary = await tracker.finish();
  assert.equal(summary.files[0].revertible, true); assert.deepEqual(summary.warnings, []);
  assert.deepEqual((await service.revert(summary.id, 'dispatch:ws', 'm', [work])).restored, ['a']);
  assert.equal(fs.readFileSync(path.join(work, 'a'), 'utf8'), 'before');
  console.log('turn-changes-pi-scheduler: real agent-core awaits capture despite non-awaiting session forwarding');
} finally {
  await tracker.ready; service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
