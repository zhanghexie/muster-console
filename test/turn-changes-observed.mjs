/** Native provider events should produce review-only snapshots without model registration. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-observed-'));
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const { CodexAppServerEventMapper } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerEvents.ts')));
const { createCodexStreamState, mapCodexEvent } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/streamMap.ts')));
const { createAcpStreamState, resetAcpStreamTurn, mapAcpSessionUpdate } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/streamMap.ts')));
const { createClaudeStreamState, mapClaudeAssistant, mapClaudeUser } = await import(pathToFileURL(compile('main/agentSession/drivers/claude/streamMap.ts')));
const { ExternalPiReviewEvents } = await import(pathToFileURL(compile('main/agentSession/drivers/externalPi/reviewEvents.ts')));
const service = new TurnChangeService(path.join(tmp, 'store'));
let tracker;
const trackers = [];
const start = (owner, message) => { const current = service.begin(owner, message, work, [work]); trackers.push(current); return current; };
const accept = async (current, events) => {
  for (const event of events) {
    if ((event.type === 'tool-start' || event.type === 'tool-update') && !event.reviewLate)
      await current.toolStart(event.toolCallId, event.toolName, event.input, event.toolKind);
    if (event.type === 'tool-result') await current.toolEnd(event.toolCallId, event.ok, event.patch, false, event.reviewChanges);
  }
};
try {
  fs.writeFileSync(path.join(work, 'source.txt'), 'before\n');
  tracker = start('gui:codex', 'm1');
  const mapper = new CodexAppServerEventMapper(), state = createCodexStreamState();
  const deliver = async (method, item) => {
    for (const mapped of mapper.map(method, { item })) await accept(tracker, mapCodexEvent(state, mapped));
  };
  await deliver('item/started', { id: 'edit-1', type: 'fileChange', status: 'inProgress', changes: [{ path: 'source.txt', kind: { type: 'update' } }] });
  fs.writeFileSync(path.join(work, 'source.txt'), 'after\n');
  await deliver('item/completed', { id: 'edit-1', type: 'fileChange', status: 'completed', changes: [{ path: 'source.txt', kind: { type: 'update' } }] });
  const summary = await tracker.finish();
  assert.equal(summary.files.length, 1, 'Codex native file-change events must appear without explicit registration');
  assert.equal(summary.files[0].origin, 'observed-tool');
  assert.equal(summary.files[0].revertible, false, 'an observed start is not a guaranteed pre-write hook');
  const diff = service.diff(summary.id, 'gui:codex', 'm1', 'source.txt');
  assert.match(diff, /-before/); assert.match(diff, /\+after/);
  const result = await service.revert(summary.id, 'gui:codex', 'm1', [work]);
  assert.deepEqual(result.restored, []);
  assert.equal(fs.readFileSync(path.join(work, 'source.txt'), 'utf8'), 'after\n');

  // A Codex completed-only event must use the provider's patch, not a fake
  // start captured after the file has already changed.
  fs.writeFileSync(path.join(work, 'late.txt'), 'new\n');
  tracker = start('gui:codex', 'm2');
  const lateMapper = new CodexAppServerEventMapper(), lateState = createCodexStreamState();
  for (const mapped of lateMapper.map('item/completed', { item: { id: 'late', type: 'fileChange', status: 'completed',
    changes: [{ path: 'late.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' }] } })) {
    const events = mapCodexEvent(lateState, mapped);
    assert.equal(events[0].reviewLate, true);
    await accept(tracker, events);
  }
  const late = await tracker.finish();
  assert.equal(late.files[0].origin, 'provider-diff'); assert.equal(late.files[0].revertible, false);
  const reported = service.diff(late.id, 'gui:codex', 'm2', 'late.txt');
  assert.match(reported, /-old/); assert.match(reported, /\+new/);
  const { parseDiff } = await import('react-diff-view');
  assert.equal(parseDiff(reported).length, 1, 'provider patch must be consumable by the production diff renderer');
  const limitedMapper = new CodexAppServerEventMapper();
  const limited = limitedMapper.map('item/completed', { item:{id:'large',type:'fileChange',status:'completed',changes:[
    {path:'large.txt',kind:{type:'update'},diff:'x'.repeat(1024*1024+1)}
  ]} });
  tracker = start('gui:codex', 'large');
  const limitedState = createCodexStreamState();
  for (const event of limited) await accept(tracker, mapCodexEvent(limitedState, event));
  assert.equal((await tracker.finish()).files.find(file => file.path === 'large.txt')?.diffOmitted, true);

  // When every observed operation has a provider patch, use the provider's
  // tool-specific evidence rather than folding a concurrent human edit into it.
  fs.writeFileSync(path.join(work, 'specific.txt'), 'old\n');
  tracker = start('gui:codex', 'm-specific');
  await tracker.toolStart('specific', 'file_change', { changes:[{path:'specific.txt',kind:'update'}] });
  fs.writeFileSync(path.join(work, 'specific.txt'), 'new\nother change\n');
  await tracker.toolEnd('specific', true, undefined, false, [{path:'specific.txt',kind:'update',diff:'@@ -1 +1 @@\n-old\n+new\n'}]);
  const specific = await tracker.finish();
  assert.equal(specific.files[0].origin, 'provider-diff');
  const specificDiff = service.diff(specific.id, 'gui:codex', 'm-specific', 'specific.txt');
  assert.match(specificDiff, /\+new/); assert.doesNotMatch(specificDiff, /other change/);

  // ACP often sends the first path in a later in-progress locations update.
  fs.writeFileSync(path.join(work, 'acp.txt'), 'old\n');
  tracker = start('gui:acp', 'm3'); const acp = createAcpStreamState();
  await accept(tracker, mapAcpSessionUpdate(acp, { sessionUpdate: 'tool_call', toolCallId: 'acp', kind: 'edit', status: 'in_progress', title: 'Editing' }));
  const update = mapAcpSessionUpdate(acp, { sessionUpdate: 'tool_call_update', toolCallId: 'acp', status: 'in_progress', locations: [{ path: 'acp.txt' }] });
  assert.equal(update[0].type, 'tool-update'); await accept(tracker, update);
  fs.writeFileSync(path.join(work, 'acp.txt'), 'new\n');
  await accept(tracker, mapAcpSessionUpdate(acp, { sessionUpdate: 'tool_call_update', toolCallId: 'acp', status: 'completed' }));
  const acpSummary = await tracker.finish();
  assert.equal(acpSummary.files[0].path, 'acp.txt'); assert.equal(acpSummary.files[0].revertible, false);
  resetAcpStreamTurn(acp);
  const reused = mapAcpSessionUpdate(acp, { sessionUpdate:'tool_call_update', toolCallId:'acp', kind:'edit', status:'in_progress', locations:[{path:'next.txt'}] });
  assert.equal(reused[0].type, 'tool-start', 'a reused ACP tool ID must start a new turn');
  assert.deepEqual(reused[0].input.locations, [{path:'next.txt'}], 'old turn locations must not leak');

  // ACP can report the actual before/after contents before completion, even
  // when no location was sent and the terminal event omits content.
  fs.writeFileSync(path.join(work, 'acp-reported.txt'), 'new\n');
  tracker = start('gui:acp', 'm-acp-diff'); const acpDiff = createAcpStreamState();
  await accept(tracker, mapAcpSessionUpdate(acpDiff, {sessionUpdate:'tool_call',toolCallId:'diff',kind:'edit',status:'in_progress'}));
  await accept(tracker, mapAcpSessionUpdate(acpDiff, {sessionUpdate:'tool_call_update',toolCallId:'diff',status:'in_progress',content:[
    {type:'diff',path:path.join(work,'acp-reported.txt'),oldText:'old\n',newText:'new\n'}
  ]}));
  await accept(tracker, mapAcpSessionUpdate(acpDiff, {sessionUpdate:'tool_call_update',toolCallId:'diff',status:'completed'}));
  const acpReported = await tracker.finish();
  assert.equal(acpReported.files[0].origin, 'provider-diff');
  assert.equal(acpReported.files[0].revertible, false);
  assert.match(service.diff(acpReported.id, 'gui:acp', 'm-acp-diff', 'acp-reported.txt'), /-old[\s\S]*\+new/);
  assert.equal(parseDiff(service.diff(acpReported.id, 'gui:acp', 'm-acp-diff', 'acp-reported.txt')).length, 1);
  const acpFailed = createAcpStreamState();
  mapAcpSessionUpdate(acpFailed, {sessionUpdate:'tool_call',toolCallId:'failed',kind:'edit',content:[{type:'diff',path:'x',oldText:'a',newText:'b'}]});
  const failedResult = mapAcpSessionUpdate(acpFailed, {sessionUpdate:'tool_call_update',toolCallId:'failed',status:'failed'});
  assert.equal(failedResult[0].reviewChanges, undefined, 'failed tool diffs must not become successful review evidence');
  const oversized = createAcpStreamState();
  mapAcpSessionUpdate(oversized, {sessionUpdate:'tool_call',toolCallId:'large',kind:'edit',content:[{type:'diff',path:'x',oldText:'a'.repeat(1024*1024+1),newText:'b'}]});
  const largeResult = mapAcpSessionUpdate(oversized, {sessionUpdate:'tool_call_update',toolCallId:'large',status:'completed'});
  assert.deepEqual(largeResult[0].reviewChanges, [{path:'x',kind:'update',diff:'',diffOmitted:true}]);

  // Claude's ordinary Write tool reports its file path in the assistant event.
  fs.writeFileSync(path.join(work, 'claude.txt'), 'old\n');
  tracker = start('gui:claude', 'm4'); const claude = createClaudeStreamState();
  await accept(tracker, mapClaudeAssistant(claude, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'claude.txt', content: 'new\n' } }] } }));
  fs.writeFileSync(path.join(work, 'claude.txt'), 'new\n');
  await accept(tracker, mapClaudeUser(claude, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] } }));
  const claudeSummary = await tracker.finish();
  assert.equal(claudeSummary.files[0].path, 'claude.txt'); assert.equal(claudeSummary.files[0].revertible, false);

  // An external Pi result can carry the real SDK edit patch even if the
  // original event reached the host too late to sample the old file.
  fs.writeFileSync(path.join(work, 'external.txt'), 'old\n');
  tracker = start('gui:external', 'm5'); const external = new ExternalPiReviewEvents();
  const args = { path:'external.txt', edits:[{oldText:'old',newText:'new'}] };
  external.start('ext', 'edit', args);
  const nativeResult = await createEditToolDefinition(work).execute('ext', args);
  await tracker.toolEnd('ext', true, undefined, false, external.finish('ext', nativeResult));
  const externalSummary = await tracker.finish();
  assert.equal(externalSummary.files[0].origin, 'provider-diff');
  assert.match(service.diff(externalSummary.id, 'gui:external', 'm5', 'external.txt'), /\+new/);
  external.start('ext-large', 'edit', args);
  const oversizedPatch = external.finish('ext-large', { details: { patch: 'x'.repeat(1024*1024+1) } });
  assert.deepEqual(oversizedPatch, [{ path: 'external.txt', kind: 'update', diff: '', diffOmitted: true }]);
  console.log('turn-changes-observed: Codex, Claude, ACP and external Pi events produce review diffs');
} finally {
  await Promise.all(trackers.map(current => current.ready)); service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
