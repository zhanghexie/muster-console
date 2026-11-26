/** Exercise the actual awaited Pi extension hooks around a real file write. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-pi-hook-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const { createPiReviewCaptureExtension } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/reviewCaptureExtension.ts')));
const work = path.join(tmp, 'work'); fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'a'), 'before');
const service = new TurnChangeService(path.join(tmp, 'store'));
const tracker = service.begin('gui:a', 'm', work, [work]);
let multiTracker;
try {
  const handlers = new Map(), log = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  createPiReviewCaptureExtension({
    async start(event) { await gate; await tracker.toolStart(event.toolCallId, event.toolName, event.input, undefined, true); },
    async end(event) { await tracker.toolEnd(event.toolCallId, event.ok, undefined, true); }
  }, message => log.push(message))({ on: (name, callback) => handlers.set(name, callback) });
  let returned = false;
  const start = handlers.get('tool_call')({ toolName: 'write', toolCallId: 'w', input: { path: 'a', content: 'after' } }).then(() => { returned = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false, 'the SDK must wait for the host before writing');
  release(); await start;
  fs.writeFileSync(path.join(work, 'a'), 'after');
  await handlers.get('tool_result')({ toolName: 'write', toolCallId: 'w', isError: false });
  await handlers.get('tool_call')({ toolName: 'read', toolCallId: 'r', input: { path: 'a' } });
  await handlers.get('tool_result')({ toolName: 'read', toolCallId: 'r', isError: false });
  const summary = await tracker.finish();
  assert.equal(summary.files.length, 1); assert.equal(summary.files[0].revertible, true); assert.deepEqual(log, []);
  assert.deepEqual((await service.revert(summary.id, 'gui:a', 'm', [work])).restored, ['a']);
  assert.equal(fs.readFileSync(path.join(work, 'a'), 'utf8'), 'before');

  // The installed Pi SDK sends edits[] matched against the same original file.
  // Execute its real tool, including BOM and CRLF preservation, between the hooks.
  const original = '\uFEFFstart one\r\nmiddle\r\nend three\r\n';
  fs.writeFileSync(path.join(work, 'multi'), original);
  multiTracker = service.begin('gui:b', 'm2', work, [work]);
  const multiHandlers = new Map();
  createPiReviewCaptureExtension({
    start: event => multiTracker.toolStart(event.toolCallId, event.toolName, event.input, undefined, true),
    end: event => multiTracker.toolEnd(event.toolCallId, event.ok, undefined, true)
  }, message => log.push(message))({ on: (name, callback) => multiHandlers.set(name, callback) });
  const args = { path: 'multi', edits: [{ oldText: 'one', newText: 'three' }, { oldText: 'three', newText: 'done' }] };
  await multiHandlers.get('tool_call')({ toolName: 'edit', toolCallId: 'multi-edit', input: args });
  await createEditToolDefinition(work).execute('multi-edit', args);
  await multiHandlers.get('tool_result')({ toolName: 'edit', toolCallId: 'multi-edit', isError: false });
  assert.equal(fs.readFileSync(path.join(work, 'multi'), 'utf8'), '\uFEFFstart three\r\nmiddle\r\nend done\r\n');
  const multiSummary = await multiTracker.finish();
  assert.equal(multiSummary.files[0].revertible, true, 'current Pi edits[] must support safe revert');
  assert.deepEqual((await service.revert(multiSummary.id, 'gui:b', 'm2', [work])).restored, ['multi']);
  assert.equal(fs.readFileSync(path.join(work, 'multi'), 'utf8'), original);
  console.log('turn-changes-pi-hook: awaited pre-write and post-write hooks passed');
} finally {
  await tracker.ready; await multiTracker?.ready; service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
