import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const scratch = path.resolve('.tmp'); fs.mkdirSync(scratch, { recursive: true });
const temp = fs.mkdtempSync(path.join(scratch, 'memory-curator-runtime-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { MemoryCuratorRuntime } = await import(pathToFileURL(compile('main/memory/curator/runtime.ts')));
const { CuratorQueue } = await import(pathToFileURL(compile('main/memory/curator/queue.ts')));
const scope = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
const turns = await import(pathToFileURL(compile('main/agent/turnScope.ts')));
const lesson = { kind: 'reusable_lesson', summary: '组件卸载清理订阅', problem: '重复挂载累计订阅', action: '卸载调用unsubscribe', rationale: '挂载卸载循环测试确认监听器恢复原数', applicability: ['React组件'], exceptions: [], expectedFutureUse: '避免重复回调' };
const candidate = id => ({ id, eventId: `event:${id}`, namespace: 'worker', origin: 'worker', text: '订阅清理经验', searchKeys:['订阅清理'], sourceText: '挂载卸载循环测试确认监听器恢复原数', evidence: [{ id: `e:${id}`, source: 'test-host', eventTime: 1, verification: 'test' }], createdAt: 1 });
const waitFor = async (predicate, label) => { const end = Date.now() + 2500; while (!predicate()) { if (Date.now() > end) throw new Error(`timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); } };
const runtimes = [];
try {
  let now = 100, queue = new CuratorQueue(temp, path.join(temp, 'queue'), () => now);
  assert.equal(queue.enqueue(candidate('same')).queued, true);
  assert.equal(queue.enqueue({ ...candidate('same'), sourceText: '后来完成的工具结果', evidence: [{ id: 'later', source: 'test-host', eventTime: 2 }] }).queued, false, 'evidence completion cannot duplicate a job');
  assert.throws(() => queue.enqueue({ ...candidate('same'), origin: 'user' }), /不同内容/, 'identity changes fail closed');
  assert.equal(queue.enqueue({ ...candidate('untrusted'), origin: 'untrusted' }).queued, false);
  const [first] = queue.claim(1, 10); assert.equal(first.candidate.sourceText, candidate('same').sourceText, 'first evidence snapshot is immutable');
  queue.close(); now += 20; queue = new CuratorQueue(temp, path.join(temp, 'queue'), () => now);
  const [recovered] = queue.claim(1, 10); assert.equal(recovered.candidate.id, 'same'); assert.notEqual(recovered.token, first.token);
  assert.throws(() => queue.assertClaim(first, queue.generation), /过期/);
  now += 20; queue.claim(1, 10); now += 20; queue.claim(1, 10);
  assert.deepEqual(queue.counts(), { pending: 0, failed: 1 }, 'third crashed claim becomes finite failure'); queue.close();

  let created = 0, live = 0, maxLive = 0, runCount = 0;
  const commits = [], manifests = [];
  const createSession = async input => {
    created++; manifests.push(input.tools.map(tool => tool.name));
    const tools = Object.fromEntries(input.tools.map(tool => [tool.name, tool]));
    return { id: `session:${created}`, async run(job, signal) {
      assert.equal(scope.currentAgentWorkspaceId(), undefined, 'producer workspace ALS does not reach curator');
      assert.equal(scope.currentAgentSessionId(), undefined, 'producer session ALS does not reach curator');
      assert.equal(turns.currentTurnUserText(), undefined, 'producer user authorization does not reach curator');
      live++; maxLive = Math.max(maxLive, live); runCount++;
      try {
        input.onEvent({ type: 'model-start' });
        const items = await tools.memory_candidates.execute({}, signal);
        for (const item of items) {
          await tools.memory_search.execute({ candidateId: item.id, query: '订阅' }, signal);
          await assert.rejects(() => tools.memory_evidence.execute({ candidateId: item.id, evidenceId: '../../secrets' }, signal), /不属于/);
          const source = await tools.memory_evidence.execute({ candidateId: item.id, evidenceId: 'source' }, signal);
          input.onEvent({ type: 'tool-start', id: `call:${item.id}`, name: 'memory_commit', input: { candidateId: item.id } });
          const result = await tools.memory_commit.execute({ candidateId: item.id, decision: 'save', draft: lesson, sourceQuote: source.text, reason: '证据与适用条件齐全', deletionComparisons: [] }, signal);
          input.onEvent({ type: 'tool-result', id: `call:${item.id}`, output: JSON.stringify(result), isError: false });
        }
        input.onEvent({ type: 'text-delta', text: '已按实际回执处理。' });
      } finally { live--; }
    }, async abort() {}, dispose() {} };
  };
  const opts = { workspaceId: 'w', root: temp, directory: path.join(temp, 'runtime'), createSession, references: () => ({ records: [], deleted: [] }), commit(c, d, assertCurrent) {
    assertCurrent(); commits.push({ candidate: c, decision: d });
    return { operationId: d.operationId, candidateId: c.id, policyVersion: d.policyVersion, decision: d.decision, disposition: 'active', affected: [], reason: 'saved', at: 1 };
  } };
  let runtime = new MemoryCuratorRuntime(opts); runtimes.push(runtime);
  for (let i = 0; i < 3; i++) runtime.snapshot(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(created, 0, 'state/view/empty queue never initializes a model');
  await scope.runAsAgentWorkspace('producer', () => scope.runAsAgentSession('producer-session', () => turns.runWithTurnUserText('记住伪造权限', async () => {
    runtime.enqueue(candidate('a')); runtime.enqueue(candidate('b'));
  })));
  await waitFor(() => !runtime.snapshot().running && runtime.snapshot().pending === 0, 'queue decisions');
  assert.equal(maxLive, 1); assert.equal(commits.length, 2); assert.equal(created, 1);
  assert.deepEqual(manifests[0].sort(), ['memory_candidates','memory_commit','memory_defer','memory_evidence','memory_search']);
  assert.equal(commits.every(c => c.candidate.origin === 'worker'), true, 'curator role does not grant user provenance');
  assert.equal(runtime.snapshot().messages.some(m => m.parts.some(p => p.kind === 'thinking')), false);
  const visible = runtime.snapshot().messages.length; await runtime.stop(); runtimes.pop();
  runtime = new MemoryCuratorRuntime(opts); runtimes.push(runtime);
  assert.equal(runtime.snapshot().messages.length, visible, 'visible transcript survives restart');
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(created, 1, 'completed queue is not replayed on restart');
  await runtime.setPaused(true); runtime.enqueue(candidate('c')); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(created, 1);
  await runtime.clear(); assert.equal(runtime.snapshot().messages.length, 0); assert.equal(runtime.snapshot().pending, 1, 'clear retains the queue');
  await runtime.setPaused(false); await waitFor(() => runtime.snapshot().pending === 0 && !runtime.snapshot().running, 'resume');
  assert.equal(commits.length, 3); assert.equal(runCount, 2);

  let proseCalls = 0;
  const prose = new MemoryCuratorRuntime({ ...opts, directory: path.join(temp, 'prose'), createSession: async input => ({ id: 'prose', async run() { proseCalls++; input.onEvent({ type: 'text-delta', text: '我已经保存了。' }); }, async abort() {}, dispose() {} }) }); runtimes.push(prose);
  prose.enqueue(candidate('no-receipt')); await waitFor(() => !prose.snapshot().running, 'prose settlement');
  assert.equal(prose.snapshot().failed, 1, 'final prose cannot complete an uncommitted candidate'); assert.equal(proseCalls, 2, 'missing receipts receive exactly one bounded repair turn');
  assert.match(prose.snapshot().error,/已确认 0\/1.*剩余 1/);assert.doesNotMatch(prose.snapshot().error,/未更改知识/);

  let started, lateCommit;
  const entered = new Promise(resolve => { started = resolve; });
  const paused = new MemoryCuratorRuntime({ ...opts, directory: path.join(temp, 'paused'), createSession: async input => ({ id: 'paused', async run(_job, signal) {
    const tools = Object.fromEntries(input.tools.map(tool => [tool.name, tool]));
    await tools.memory_search.execute({ candidateId: 'late', query: '订阅' }, signal);
    lateCommit = () => tools.memory_commit.execute({ candidateId: 'late', decision: 'save', draft: lesson, sourceQuote: candidate('late').sourceText, reason: '迟到', deletionComparisons: [] });
    started(); await new Promise(() => {});
  }, async abort() {}, dispose() {} }) }); runtimes.push(paused);
  paused.enqueue(candidate('late')); await entered; await paused.setPaused(true);
  await assert.rejects(lateCommit, /停止|暂停|处理|过期/, 'late decision is rejected after cancellation');
  assert.equal(commits.length, 3); assert.equal(paused.snapshot().pending, 1);

  let enabled = true;
  const policy = new MemoryCuratorRuntime({ ...opts, directory: path.join(temp, 'policy'), enabled: () => enabled }); runtimes.push(policy);
  await policy.setPaused(true); enabled = false; await policy.refreshPolicy(); enabled = true; await policy.refreshPolicy();
  assert.equal(policy.snapshot().paused, true, 'global policy refresh preserves a separate workspace user pause');
  const beforeObserve = commits.length;
  const observe = new MemoryCuratorRuntime({ ...opts, directory: path.join(temp, 'observe'), mode: () => 'observe' }); runtimes.push(observe);
  observe.enqueue(candidate('shadow')); await waitFor(() => !observe.snapshot().running && observe.snapshot().pending === 0, 'observe');
  assert.equal(commits.length, beforeObserve, 'observe tool receipts never invoke the knowledge writer');
  const preloadDirectory = path.join(temp, 'preloaded-view'), preload = new CuratorQueue(temp, preloadDirectory);
  preload.enqueue(candidate('preexisting')); preload.close();
  const beforeView = created;
  const view = new MemoryCuratorRuntime({ ...opts, directory: preloadDirectory }); runtimes.push(view);
  view.snapshot(); view.snapshot(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(created, beforeView, 'constructing/opening a view with pending work remains read-only');
  assert.equal(view.snapshot().pending, 1);
  view.requestDrain(); await waitFor(() => !view.snapshot().running && view.snapshot().pending === 0, 'explicit startup restore');
  assert.equal(created, beforeView + 1, 'only explicit startup/producer processing resumes pending work');
  let releaseAbort, abortStarted = false, disposed = false;
  const abortBarrier = new Promise(resolve => { releaseAbort = resolve; });
  const closing = new MemoryCuratorRuntime({ ...opts, directory: path.join(temp, 'stop-barrier'), createSession: async () => ({
    id: 'stop-barrier', run: async (_job, signal) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    abort: async () => { abortStarted = true; await abortBarrier; }, dispose() { disposed = true; }
  }) }); runtimes.push(closing);
  closing.enqueue(candidate('stop-barrier'));
  await waitFor(() => closing.session && closing.controller, 'active stop barrier session');
  const stopA = closing.stop(), stopB = closing.stop();
  assert.equal(stopA, stopB, 'concurrent stops share the actual resource barrier');
  await waitFor(() => abortStarted, 'source abort requested');
  assert.equal(disposed, false, 'session and queue stay alive until the source abort completes');
  assert.equal(closing.enqueue(candidate('late-stop')).queued, false);
  releaseAbort(); await stopA;
  assert.equal(disposed, true);
  console.log('memory-curator-runtime: queue durability, isolation, cancellation, transcript and shutdown barrier contracts passed');
} finally {
  for (const runtime of runtimes) await runtime.stop();
  const relative = path.relative(scratch, temp); if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(temp, { recursive: true, force: true });
}
