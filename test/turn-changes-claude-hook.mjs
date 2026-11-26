/** Claude SDK hook contract: await original content, bind the turn and fail closed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-claude-hook-'));
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const { createClaudeReviewHooks } = await import(pathToFileURL(compile('main/agentSession/drivers/claude/reviewCapture.ts')));
const service = new TurnChangeService(path.join(tmp, 'store'));
const trackers = []; let currentTurn = 'turn-1', current;
const begin = message => { current = service.begin('gui:claude', message, work, [work]); trackers.push(current); return current; };
try {
  fs.writeFileSync(path.join(work, 'a'), 'before\n');
  const tracker = begin('m1'), logs = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  const nativeStart = tracker.toolStart.bind(tracker);
  tracker.toolStart = async (...args) => { await gate; return nativeStart(...args); };
  const hooks = createClaudeReviewHooks({ tracker: () => current, turnId: () => currentTurn, isCurrent: () => true, log: text => logs.push(text) });
  const pre = hooks.PreToolUse[0].hooks[0], post = hooks.PostToolUse[0].hooks[0], fail = hooks.PostToolUseFailure[0].hooks[0];
  const controller = new AbortController();
  let returned = false;
  const pending = pre({ hook_event_name:'PreToolUse', tool_name:'Edit', tool_use_id:'edit', tool_input:{file_path:'a',old_string:'before',new_string:'after'} }, 'edit', { signal:controller.signal }).then(() => { returned = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false, 'Claude must wait for the captured original');
  release(); await pending;
  fs.writeFileSync(path.join(work, 'a'), 'after\n');
  await post({ hook_event_name:'PostToolUse', tool_name:'Edit', tool_use_id:'edit', tool_input:{}, tool_response:'ok' }, 'edit', { signal:controller.signal });
  const summary = await tracker.finish();
  assert.equal(summary.files[0].revertible, true);
  assert.deepEqual((await service.revert(summary.id, 'gui:claude', 'm1', [work])).restored, ['a']);
  assert.equal(fs.readFileSync(path.join(work, 'a'), 'utf8'), 'before\n');

  fs.writeFileSync(path.join(work, 'b'), 'old');
  const stale = begin('m2'); currentTurn = 'turn-2';
  await pre({hook_event_name:'PreToolUse',tool_name:'Write',tool_use_id:'stale',tool_input:{file_path:'b',content:'new'}}, 'stale', {signal:controller.signal});
  fs.writeFileSync(path.join(work, 'b'), 'new'); currentTurn = 'turn-3';
  await post({hook_event_name:'PostToolUse',tool_name:'Write',tool_use_id:'stale',tool_input:{},tool_response:'ok'}, 'stale', {signal:controller.signal});
  const staleSummary = await stale.finish();
  assert(!staleSummary.files.some(file => file.revertible), 'a result from another turn cannot authorize undo');

  fs.writeFileSync(path.join(work, 'c'), 'old');
  const failed = begin('m3'); currentTurn = 'turn-4';
  await pre({hook_event_name:'PreToolUse',tool_name:'Write',tool_use_id:'failed',tool_input:{file_path:'c',content:'new'}}, 'failed', {signal:controller.signal});
  fs.writeFileSync(path.join(work, 'c'), 'new');
  await fail({hook_event_name:'PostToolUseFailure',tool_name:'Write',tool_use_id:'failed',tool_input:{},error:'failed'}, 'failed', {signal:controller.signal});
  assert(!(await failed.finish()).files.some(file => file.revertible));
  assert.deepEqual(logs, []);
  console.log('turn-changes-claude-hook: awaited pre-write, stale turn and failure safety passed');
} finally {
  await Promise.all(trackers.map(tracker => tracker.ready)); service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
}
