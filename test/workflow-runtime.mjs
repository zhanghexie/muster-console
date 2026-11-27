/**
 * 工作流运行时集成（dynamic-workflow W1）：真 worker 内核 + 真 run.mjs，派活/调工具/信任用假件。
 * - 闭环：阶段 → 派活 → 等会话相位 → 问调度 → 问用户 → 结束；进度事件种类与 run 记录落盘
 * - 重启续跑回归：shutdown 后新运行时 resumeAll，已完成的派活不重复（去掉自动记账时该用例转红），
 *   待答问题沿用原 askId 重发
 * - 先查现状：任务已在目标状态时 waitFor 立即返回；waitFor 超时 resolve {timedOut}
 * - 停机期间改脚本：不续跑、标记中断并发 interrupted 事件
 * - 护栏：派活超 maxDelegates 失败；同时运行上限；wf.tool 调用边界；wf.read 越界/禁区；wf.glob
 * - 子工作流 wf.call；workflow.validate 冒烟 import；reply 拒答问人的问题
 * - 派活队列出队回调（排队的 wf.delegate 据此等到真正拉起）
 * 运行: node test/workflow-runtime.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-runtime-'));
const compile = createSharedCompiler(repo, tmp);
const { WorkflowRuntime } = await import(pathToFileURL(compile('main/workflow/runtime.ts')).href);
const { readRunRecord, writeRunRecord, listRunRecords, loadWorkflow, workflowFingerprint } = await import(
  pathToFileURL(compile('main/workflow/store.ts')).href
);
const queueMod = await import(pathToFileURL(compile('main/tasks/delegateQueue.ts')).href);
const bridgeMod = await import(pathToFileURL(compile('main/workflow/delegateBridge.ts')).href);
const kernelMod = await import(pathToFileURL(compile('main/workflow/kernel.ts')).href);
const { WORKFLOW_MEMO_PENDING } = await import(pathToFileURL(compile('shared/workflow.ts')).href);
const { planCloseBatch } = await import(pathToFileURL(compile('shared/sessionCloseBatch.ts')).href);

const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-ws-'));
const WS = 'w1';

function writeWorkflow(name, frontmatter, script, root = wsRoot) {
  const dir = path.join(root, '.muster', 'workflows', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), `---\nname: ${name}\n${frontmatter}\n---\n说明\n`);
  fs.writeFileSync(path.join(dir, 'run.mjs'), script);
}

async function until(pred, label, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  // Windows taskkill is asynchronous. Observe bounded quiescence rather than assuming fixed exit latency.
async function assertStopsWriting(file,label) {
 const size=()=>fs.existsSync(file)?fs.readFileSync(file,'utf8').length:0;
 let previous=size(),lastChange=Date.now();
 await until(()=>{const n=size();if(n!==previous){previous=n;lastChange=Date.now();}return Date.now()-lastChange>=1200;},label,5000);
 const before=size();await delay(800);assert.equal(size(),before,label);
}

function sessionTool(state, name, args) {
  if (name === 'fixture.unknown') return { ok: false, error: `未知工具: ${name}` };
  if (state.toolFail?.(name, args)) return { ok: false, error: '假失败' };
  if (!['sessions.setArchived', 'sessions.delete'].includes(name)) return { ok: true, result: { echoed: name } };
  state.sessionRows ??= new Map();
  for (const id of args.sessionIds) if (!state.sessionRows.has(id)) state.sessionRows.set(id, { id, type: 'terminal', archived: false });
  if (name === 'sessions.setArchived') {
    for (const id of args.sessionIds) state.sessionRows.get(id).archived = args.archived;
    return { ok: true, result: { updated: args.sessionIds, failed: [] } };
  }
  const plan = planCloseBatch([...state.sessionRows.values()], args.sessionIds);
  const failed = plan.failed.length ? plan.failed : state.deleteAborted ? args.sessionIds.map(id => ({ id, error: '仍被占用' })) : [];
  return { ok: true, result: { closed: failed.length ? [] : plan.targets.map(row => ({ id: row.id })), failed, aborted: !!failed.length } };
}

function makeRuntime(state, root = wsRoot) {
  return new WorkflowRuntime({
    ...(state.clock ? { now: () => state.clock.now } : {}),
    workspaceIds: () => [WS],
    workspaceRoot: (ws) => (ws === WS ? root : undefined),
    emit: (ws, e) => state.events.push({ ws, ...e }),
    delegate: async (_ws, input, ctl) => {
      if (state.assignee[input.creationKey]) {
        state.recoveredAssignments = (state.recoveredAssignments || 0) + 1;
        return {taskId:input.creationKey,sessionId:state.assignee[input.creationKey]};
      }
      state.delegates.push(input);
      if (state.hangDelegate) return new Promise((_resolve, reject) => { ctl?.registerCancel(() => { reject(Error('fixture delegate cancelled')); return true; }); });
      const n = state.delegates.length;
      return { sessionId: `s${n}`, sessionName: `W${n}`, taskId: `t${n}` };
    },
    executeTool: async (_ws, name, args) => {
      state.tools.push({ name, args });
      return sessionTool(state, name, args);
    },
    sessionPhase: (_ws, id) => state.phases[id],
    ensureTrusted: async (_ws, loaded) => {
      state.trustAsks.push(loaded.name);
      return state.trust !== false;
    },
    trustState: (_ws, name) => state.trustStates[name] ?? 'trusted',
    revokeTrust: (_ws, name) => state.revoked.push(name),
    notifyHuman: (_ws, info) => state.notified.push(info),
    nextScheduleAt: (_schedule, from) => from + 3600_000,
    ...(state.removeDir ? { removeDir: state.removeDir } : {}),
    setInterval: () => 0,
    clearInterval: () => {}
  });
}

const newState = () => ({
  events: [],
  delegates: [],
  tools: [],
  assignee: {},
  phases: {},
  trustAsks: [],
  trustStates: {},
  revoked: [],
  notified: []
});
const lastEvent = (state, trigger) => [...state.events].reverse().find((e) => e.trigger === trigger);

// ---------- 1) 闭环 ----------
writeWorkflow(
  'loop',
  'description: 闭环\nargs: task',
  `export default async function (wf, args) {
  wf.phase('实现');
  const d = await wf.delegate({ isolate: false, task: args.task, name: '实现' });
  const ev = await wf.waitFor({ kind: 'phase', sessionId: d.sessionId, trigger: ['needs_you', 'blocked'] });
  const verdict = await wf.ask('改动是否达标？', { options: ['达标', '不达标'] });
  const go = await wf.ask('合入吗？', { to: 'human', options: ['合入', '打回'] });
  wf.state.done = true;
  return { to: ev.trigger, verdict, go };
}
`
);
{
  const st = newState();
  const rt = makeRuntime(st);
  await assert.rejects(rt.startRun(WS, 'loop', {}), /缺少必填参数 task/);
  const rec = await rt.startRun(WS, 'loop', { task: '修登录' });
  assert.equal(lastEvent(st, 'started').name, 'loop');
  await until(() => st.delegates.length === 1, '派活');
  assert.equal(st.delegates[0].task, '修登录');
  await until(() => rt.get(WS, rec.runId).status === 'waiting', '进入等待');
  rt.onEvent(WS, { kind: 'phase', sessionId: 's9', trigger: 'needs_you' });
  rt.onEvent(WS, { kind: 'phase', sessionId: 's1', trigger: 'needs_you' });
  const ask = await until(() => lastEvent(st, 'ask'), '问调度事件');
  const askId = rt.get(WS, rec.runId).pendingAsk.askId;
  assert.match(ask.detail, new RegExp(`askId:"${askId}"`), '事件行内给出答复参数');
  rt.reply(WS, rec.runId, askId, '达标');
  await until(() => lastEvent(st, 'ask_human'), '问用户事件');
  const human = rt.pendingHumanAsk(WS, rec.runId);
  assert.deepEqual(st.notified, [{ runId: rec.runId, name: 'loop', question: '合入吗？' }], '问用户时桌面提醒');
  assert.match(lastEvent(st, 'ask_human').detail, /工作流面板/);
  assert.throws(() => rt.reply(WS, rec.runId, human.ask.askId, '合入'), /askHuman/, '调度不能代答问用户的问题');
  assert.equal(rt.get(WS, rec.runId).status, 'waiting');
  rt.answerHuman(WS, rec.runId, human.ask.askId, '合入');
  await until(() => lastEvent(st, 'completed'), '完成事件');
  const done = readRunRecord(wsRoot, rec.runId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { to: 'needs_you', verdict: '达标', go: '合入' });
  assert.equal(done.state.done, true, 'wf.state 随结果落盘');
  assert.equal(done.phase, '实现');
  assert.equal(done.delegates, 1);
  assert.equal(done.humanWaitSince, undefined);
  assert.deepEqual(st.trustAsks, ['loop'], '启动前过信任门');
  console.log('ok: 闭环（派活→等翻转→问调度→问用户→完成）');
}

// ---------- 2) 重启续跑：已完成的派活不重复 ----------
writeWorkflow(
  'resume',
  'description: 续跑',
  `export default async function (wf) {
  const d = await wf.delegate({ isolate: false, task: '长任务' });
  const a = await wf.ask('继续吗？');
  return { sessionId: d.sessionId, a };
}
`
);
{
  const st1 = newState();
  const rt1 = makeRuntime(st1);
  const rec = await rt1.startRun(WS, 'resume', {});
  await until(() => lastEvent(st1, 'ask'), '首跑问题');
  const askId = rt1.get(WS, rec.runId).pendingAsk.askId;
  await rt1.shutdown();
  const onDisk = readRunRecord(wsRoot, rec.runId);
  assert.equal(onDisk.status, 'waiting', '关机保留运行态');

  const st2 = newState();
  const rt2 = makeRuntime(st2);
  rt2.resumeAll();
  await until(() => lastEvent(st2, 'ask'), '续跑后重发问题');
  assert.equal(st2.delegates.length, 0, '续跑命中记账，不重复派活');
  assert.equal(rt2.get(WS, rec.runId).pendingAsk.askId, askId, '沿用原 askId');
  assert.deepEqual(st2.trustAsks, [], '指纹未变不再确认');
  rt2.reply(WS, rec.runId, askId, '继续');
  await until(() => lastEvent(st2, 'completed'), '续跑完成');
  const done = readRunRecord(wsRoot, rec.runId);
  assert.deepEqual(done.result, { sessionId: 's1', a: '继续' }, '拿到首跑时的派活结果');
  assert.equal(done.resumes, 1);
  console.log('ok: 重启续跑跳过已完成步骤');
}

// ---------- 3) 停机期间改脚本 → 中断 ----------
writeWorkflow('mutate', 'description: 改脚本', `export default async function (wf) { await wf.ask('等'); }\n`);
{
  const st1 = newState();
  const rt1 = makeRuntime(st1);
  const rec = await rt1.startRun(WS, 'mutate', {});
  await until(() => lastEvent(st1, 'ask'), '问题');
  await rt1.shutdown();
  fs.appendFileSync(path.join(wsRoot, '.muster', 'workflows', 'mutate', 'run.mjs'), '// changed\n');
  const st2 = newState();
  makeRuntime(st2).resumeAll();
  assert.equal(readRunRecord(wsRoot, rec.runId).status, 'interrupted');
  assert.match(lastEvent(st2, 'interrupted').detail, /修改/);
  console.log('ok: 停机期间改脚本不续跑并通知');
}

// ---------- 4) 先查现状 + 超时 ----------
writeWorkflow(
  'snapshot',
  'description: 现状',
  `export default async function (wf) {
  const a = await wf.waitFor({ kind: 'phase', sessionId: 'tx', trigger: 'needs_you' });
  const b = await wf.waitFor({ kind: 'phase', trigger: 'needs_you' }, { timeoutMs: 30 });
  return { a, b };
}
`
);
{
  const st = newState();
  st.phases.tx = 'needs_you';
  const rt = makeRuntime(st);
  const rec = await rt.startRun(WS, 'snapshot', {});
  await until(() => lastEvent(st, 'completed'), '完成');
  const r = readRunRecord(wsRoot, rec.runId).result;
  assert.equal(r.a.snapshot, true, '任务已在目标状态，立即返回');
  assert.deepEqual(r.b, { timedOut: true }, '超时 resolve 而非抛错');
  console.log('ok: waitFor 先查现状 + 超时');
}

// ---------- 5) 护栏 ----------
writeWorkflow(
  'greedy',
  'description: 超额\nmaxDelegates: 1',
  `export default async function (wf) {
  await wf.delegate({ isolate: false, task: 'a' });
  await wf.delegate({ isolate: false, task: 'b' });
  return 'unreachable';
}
`
);
writeWorkflow(
  'fence',
  'description: 边界',
  `export default async function (wf) {
  const out = {};
  out.created = await wf.tool('sessions.create', { name: 'worker' });
  out.ok = await wf.tool('sessions.observe', {});
  out.denied = [];
  for (const name of [
    'workflow.run', 'workflow.start', 'workflow_run', 'workflow_start', ' Workflow_Run ', ' Workflow_Start ',
    'mcp__muster__workflow_run', 'muster__workflow_start', 'other__workflow_run',
    'host.workflow.start', 'host_workflow_run', 'mcp__muster__host.workflow_start'
  ]) {
    try { await wf.tool(name, { action: 'start' }); } catch (e) { out.denied.push({ name, message: e.message }); }
  }
  out.listed = await wf.tool('workflow.list', {});
  out.got = await wf.tool('workflow.get', { runId: 'r1' });
  out.replied = await wf.tool('workflow.reply', { runId: 'r1' });
  out.unrelated = await wf.tool('hostXworkflow.run', {});
  try { await wf.tool('fixture.unknown', {}); } catch (e) { out.unknown = e.message; }
  out.invalidNames = [];
  for (const name of ['', '   ', null, 123, {}]) {
    try { await wf.tool(name, {}); } catch (e) { out.invalidNames.push(e.message); }
  }
  try { await wf.read('../outside.txt'); } catch (e) { out.escape = e.message; }
  try { await wf.read('.muster/local/x.json'); } catch (e) { out.local = e.message; }
  out.missing = await wf.read('nope.md');
  out.text = await wf.read('docs/a.md');
  out.files = await wf.glob('docs/**/*.md');
  out.cmd = await wf.run('node', ['-e', 'process.stdout.write("hi")']);
  return out;
}
`
);
writeWorkflow('idle', 'description: 挂起', `export default async function (wf) { await wf.ask('一直等'); }\n`);
{
  const st = newState();
  const rt = makeRuntime(st);
  const g = await rt.startRun(WS, 'greedy', {});
  await until(() => lastEvent(st, 'failed'), '超额失败');
  assert.match(readRunRecord(wsRoot, g.runId).error, /派活次数/);
  assert.equal(st.delegates.length, 1, '超额那次没派出去');

  fs.mkdirSync(path.join(wsRoot, 'docs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'docs', 'a.md'), '# A');
  fs.writeFileSync(path.join(wsRoot, 'docs', 'sub', 'b.md'), '# B');
  const f = await rt.startRun(WS, 'fence', {});
  await until(() => ['completed', 'failed'].includes(readRunRecord(wsRoot, f.runId)?.status), 'fence 结束');
  const fence = readRunRecord(wsRoot, f.runId);
  assert.equal(fence.status, 'completed', fence.error);
  const r = fence.result;
  assert.deepEqual(r.created, { echoed: 'sessions.create' });
  assert.deepEqual(r.ok, { echoed: 'sessions.observe' });
  assert.equal(r.denied.length, 12, '启动入口及其别名/前缀都被拒绝');
  for (const item of r.denied) {
    assert.match(item.message, /wf\.tool 不允许调用 .*启动另一个工作流；子流程用 wf\.call/);
    assert.ok(item.message.includes(item.name.trim()), '拒绝消息包含实际工具名');
  }
  assert.deepEqual(r.listed, { echoed: 'workflow.list' });
  assert.deepEqual(r.got, { echoed: 'workflow.get' });
  assert.deepEqual(r.replied, { echoed: 'workflow.reply' });
  assert.deepEqual(r.unrelated, { echoed: 'hostXworkflow.run' });
  assert.equal(r.unknown, '未知工具: fixture.unknown', '执行器错误原样传递');
  assert.equal(r.invalidNames.length, 5);
  for (const message of r.invalidNames) assert.match(message, /name.*非空字符串/);
  assert.deepEqual(st.tools, [
    { name: 'sessions.create', args: { name: 'worker' } },
    { name: 'sessions.observe', args: {} },
    { name: 'workflow.list', args: {} },
    { name: 'workflow.get', args: { runId: 'r1' } },
    { name: 'workflow.reply', args: { runId: 'r1' } },
    { name: 'hostXworkflow.run', args: {} },
    { name: 'fixture.unknown', args: {} }
  ], '仅合法且未被拒绝的工具名到达执行器');
  assert.match(r.escape, /越出工作区/);
  assert.match(r.local, /不允许访问/);
  assert.equal(r.missing, null);
  assert.equal(r.text, '# A');
  assert.deepEqual(r.files, ['docs/a.md', 'docs/sub/b.md']);
  assert.equal(r.cmd.code, 0);
  assert.equal(r.cmd.stdout, 'hi');

  const idle = [];
  for (let i = 0; i < 3; i++) idle.push(await rt.startRun(WS, 'idle', {}));
  await assert.rejects(rt.startRun(WS, 'idle', {}), /上限 3/);
  for (const x of idle) await rt.cancel(WS, x.runId, '测试收尾');
  assert.equal(readRunRecord(wsRoot, idle[0].runId).status, 'cancelled');

  st.trust = false;
  await assert.rejects(rt.startRun(WS, 'idle', {}), /未确认/);
  console.log('ok: 护栏（派活上限/并发上限/工具调用边界/读边界/信任拒绝）');
}

// ---------- 6) 子工作流 + validate ----------
writeWorkflow('child', 'description: 子\nargs: n', `export default async function (wf, args) { return args.n * 2; }\n`);
writeWorkflow('parent', 'description: 父', `export default async function (wf) { return await wf.call('child', { n: 21 }); }\n`);
writeWorkflow('broken', 'description: 坏', `export const notDefault = 1;\n`);
{
  const st = newState();
  const rt = makeRuntime(st);
  const p = await rt.startRun(WS, 'parent', {});
  await until(() => lastEvent(st, 'completed'), '父完成');
  assert.equal(readRunRecord(wsRoot, p.runId).result, 42);
  assert.deepEqual(st.trustAsks, ['parent', 'child'], '子工作流也过信任门');
  assert.equal(st.events.filter((e) => e.trigger === 'completed').length, 1, '子工作流完成不单独唤醒调度');
  assert.equal((await rt.validate(WS, 'child')).ok, true);
  const bad = await rt.validate(WS, 'broken');
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /export default/);
  console.log('ok: 子工作流 + 冒烟校验');
}

// ---------- 7) 派活队列出队回调 ----------
{
  const ctx = {
    config: { get: () => ({ workspaces: [{ id: WS, path: wsRoot }], workspace: wsRoot }) },
    sessions: { listByWorkspace: () => [] },
    notify: { push() {} }
  };
  queueMod.resetDelegateQueueForTests();
  queueMod.bindDelegateRunner(async (_ctx, input) => ({ session: { id: 'sq', name: input.name }, notified: false }));
  const got = [];
  const off = queueMod.addDelegateDrainedListener((queueId, ws, outcome) => got.push({ queueId, ws, outcome }));
  const { queueId } = queueMod.enqueueDelegate(ctx, WS, { task: 'x', name: 'Q', isolate: false });
  await queueMod.drainDelegateQueue(WS);
  assert.equal(got.length, 1);
  assert.equal(got[0].queueId, queueId);
  assert.equal(got[0].outcome.ok, true);
  assert.equal(got[0].outcome.result.session.id, 'sq');
  off();
  queueMod.resetDelegateQueueForTests();
  console.log('ok: 派活队列出队回调');
}

// ---------- 8) wf.run 带 key 记账：重启续跑不再执行 ----------
{
  const counter = path.join(tmp, 'run-counter.txt');
  const bump = `require('fs').appendFileSync(process.argv[1], 'x')`;
  writeWorkflow(
    'runkey',
    'description: 命令记账',
    `export default async function (wf) {
  await wf.run('node', ['-e', ${JSON.stringify(bump)}, ${JSON.stringify(counter)}], { key: 'once' });
  await wf.run('node', ['-e', ${JSON.stringify(bump)}, ${JSON.stringify(counter)}]);
  await wf.ask('等');
  return 'ok';
}
`
  );
  const st1 = newState();
  const rt1 = makeRuntime(st1);
  const rec = await rt1.startRun(WS, 'runkey', {});
  await until(() => lastEvent(st1, 'ask'), '首跑问题');
  assert.equal(fs.readFileSync(counter, 'utf8'), 'xx');
  await rt1.shutdown();
  const st2 = newState();
  const rt2 = makeRuntime(st2);
  rt2.resumeAll();
  await until(() => lastEvent(st2, 'ask'), '续跑问题');
  assert.equal(fs.readFileSync(counter, 'utf8'), 'xxx', '带 key 的命令续跑不重跑，不带 key 的重跑');
  // 回归：命令参数原先整行写进 run 日志（持久化并回传调度），参数里的密钥会泄露
  const saved = JSON.stringify(readRunRecord(wsRoot, rec.runId));
  assert.ok(!saved.includes('appendFileSync') && !saved.includes('run-counter'), 'run 记录不含命令参数');
  assert.ok(readRunRecord(wsRoot, rec.runId).log.some((l) => l.text === '命令：node（3 段参数不落日志）'));
  await rt2.cancel(WS, rec.runId);
  console.log('ok: wf.run key 记账');
}

// ---------- 9) 派活防重复：「准备派」落盘后崩溃，续跑按确定性任务 id 找回 ----------
writeWorkflow('crashdelegate', 'description: 派活崩溃', `export default async function (wf) { return await wf.delegate({ isolate: false, task: '长活' }); }\n`);
{
  const st1 = newState();
  st1.hangDelegate = true;
  const rt1 = makeRuntime(st1);
  const rec = await rt1.startRun(WS, 'crashdelegate', {});
  await until(() => st1.delegates.length === 1, '发出派活');
  const creationKey = st1.delegates[0].creationKey;
  assert.match(creationKey, /^wf-/, '派活携带确定性任务 id');
  await rt1.shutdown();

  const st2 = newState();
  st2.assignee[creationKey] = 'sX';
  const rt2 = makeRuntime(st2);
  rt2.resumeAll();
  await until(() => lastEvent(st2, 'completed'), '续跑完成');
  assert.equal(st2.delegates.length, 0, '已有创建身份，不重复创建会话');
  assert.equal(st2.recoveredAssignments, 1, '恢复必须重新经过幂等首封任务投递');
  const done = readRunRecord(wsRoot, rec.runId);
  assert.deepEqual(done.result, { taskId: creationKey, sessionId: 'sX' });
  assert.equal(done.delegates, 1, '找回不重复计数');
  assert.deepEqual(done.sessions, ['sX']);
  console.log('ok: 派活崩溃后按会话创建记录找回');
}
{
  const st1 = newState();
  st1.hangDelegate = true;
  const rt1 = makeRuntime(st1);
  const rec = await rt1.startRun(WS, 'crashdelegate', {});
  await until(() => st1.delegates.length === 1, '发出派活');
  await rt1.shutdown();
  const st2 = newState();
  const rt2 = makeRuntime(st2);
  rt2.resumeAll();
  await until(() => lastEvent(st2, 'completed'), '续跑完成');
  assert.equal(st2.delegates.length, 1, '任务表没有该 id：补派');
  assert.equal(st2.delegates[0].creationKey, st1.delegates[0].creationKey, '补派沿用同一任务 id');
  assert.equal(readRunRecord(wsRoot, rec.runId).delegates, 1);
  console.log('ok: 派活未落地时补派且不重复计数');
}

// ---------- 10) 会话相位快照 ----------
writeWorkflow(
  'phasesnap',
  'description: 相位',
  `export default async function (wf) { return await wf.waitFor({ kind: 'phase', sessionId: 'sp', trigger: ['needs_you', 'done'] }); }\n`
);
{
  const st = newState();
  st.phases.sp = 'needs_you';
  const rt = makeRuntime(st);
  const rec = await rt.startRun(WS, 'phasesnap', {});
  await until(() => lastEvent(st, 'completed'), '完成');
  const r = readRunRecord(wsRoot, rec.runId).result;
  assert.equal(r.snapshot, true, '会话已在目标相位，立即返回');
  assert.equal(r.trigger, 'needs_you');
  console.log('ok: waitFor phase 先查会话相位');
}

// ---------- 11) 取消收尾：关闭本 run 与子 run 派出的会话 ----------
writeWorkflow('subdispatch', 'description: 子派活', `export default async function (wf) { await wf.delegate({ isolate: false, task: 'c' }); await wf.ask('子等'); }\n`);
writeWorkflow(
  'dispatch2',
  'description: 派两个',
  `export default async function (wf) {
  await wf.delegate({ isolate: false, task: 'a' });
  await wf.delegate({ isolate: false, task: 'b' });
  await wf.call('subdispatch', {});
}
`
);
{
  const st = newState();
  st.toolFail = (name, args) => name === 'sessions.delete' && args.sessionIds.includes('s2');
  const rt = makeRuntime(st);
  const rec = await rt.startRun(WS, 'dispatch2', {});
  await until(() => lastEvent(st, 'ask') && st.delegates.length === 3, '子 run 派活并提问');
  const out = await rt.cancel(WS, rec.runId, '收尾', { closeSessions: true });
  assert.deepEqual(
    st.tools.filter((t) => t.name === 'sessions.delete').flatMap((t) => t.args.sessionIds).sort(),
    ['s1', 's2', 's3'],
    '本 run 与子 run 的会话都关闭'
  );
  assert.deepEqual(out.closed.sort(), ['s1', 's3']);
  assert.deepEqual(out.failed, [{ sessionId: 's2', error: '假失败' }], '关闭失败逐个报告');
  assert.equal(readRunRecord(wsRoot, rec.runId).status, 'cancelled');
  console.log('ok: 取消时关闭派出的会话');
}

// ---------- 12) 运行记录保留：超 30 天的结束 run 在续跑时清理 ----------
{
  const st = newState(); st.deleteAborted = true;
  const rt = makeRuntime(st);
  const rec = await rt.startRun(WS, 'dispatch2', {});
  await until(() => lastEvent(st, 'ask') && st.delegates.length === 3, '待删除回执核验');
  const result = await rt.cancel(WS, rec.runId, '收尾', { closeSessions: true });
  assert.deepEqual(result.closed, [], '外层 ok 不能冒充实际删除成功');
  assert.equal(result.failed.length, 3);
  assert.ok(result.failed.every(item => item.error === '仍被占用'));
}

{
  const done = listRunRecords(wsRoot).find((r) => r.status === 'completed' && !r.parentRunId);
  const longAgo = Date.now() - 31 * 86400_000;
  const old = { ...done, runId: 'wf-old-run', startedAt: longAgo, updatedAt: longAgo, endedAt: longAgo };
  writeRunRecord(wsRoot, old);
  assert.ok(readRunRecord(wsRoot, 'wf-old-run'));
  makeRuntime(newState()).resumeAll();
  assert.equal(readRunRecord(wsRoot, 'wf-old-run'), null, '过期 run 被清理');
  assert.ok(readRunRecord(wsRoot, done.runId), '近期 run 保留');
  console.log('ok: run 记录保留策略');
}

// ---------- 13) 定时触发 ----------
{
  const trigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-trig-'));
  writeWorkflow('cron', 'description: 定时\nschedule: every 1h', `export default async function () { return 'tick'; }\n`, trigRoot);
  const st = newState();
  st.clock = { now: 1_000_000_000_000 };
  const rt = makeRuntime(st, trigRoot);
  const runs = () => listRunRecords(trigRoot).filter((r) => r.name === 'cron');

  st.trustStates.cron = 'never';
  rt.checkTriggers();
  st.clock.now += 2 * 3600_000;
  rt.checkTriggers();
  assert.equal(runs().length, 0, '从未信任：不触发');
  assert.equal(rt.overview(WS).workflows.find((w) => w.name === 'cron').trust, 'never');

  st.trustStates.cron = 'trusted';
  rt.checkTriggers();
  assert.equal(runs().length, 0, '刚信任只立基准，不立即补跑');
  const ov = rt.overview(WS).workflows.find((w) => w.name === 'cron');
  assert.equal(ov.nextDueAt, st.clock.now + 3600_000);
  assert.match(ov.schedule, /1 小时/);
  st.clock.now += 30 * 60_000;
  rt.checkTriggers();
  assert.equal(runs().length, 0, '未到点');
  st.clock.now += 31 * 60_000;
  rt.checkTriggers();
  await until(() => runs()[0]?.status === 'completed', '定时 run 完成');
  assert.equal(runs()[0].trigger, 'schedule');
  assert.match(lastEvent(st, 'started').detail, /定时触发/);
  assert.deepEqual(st.trustAsks, [], '无人值守不弹确认');
  rt.checkTriggers();
  assert.equal(runs().length, 1, '同一时刻不重复触发');
  st.clock.now += 5 * 3600_000;
  rt.checkTriggers();
  await until(() => runs().every((r) => r.status === 'completed') && runs().length === 2, '漏跑补一次');
  rt.checkTriggers();
  assert.equal(runs().length, 2, '错过多次也只补一次');

  st.trustStates.cron = 'changed';
  st.clock.now += 2 * 3600_000;
  rt.checkTriggers();
  rt.checkTriggers();
  assert.equal(runs().length, 2, '改过未确认：跳过');
  assert.equal(st.events.filter((e) => e.trigger === 'trigger_blocked').length, 1, 'trigger_blocked 每个指纹只报一次');
  assert.match(rt.overview(WS).workflows.find((w) => w.name === 'cron').lastSkip.reason, /尚未确认/);
  assert.ok(fs.existsSync(path.join(trigRoot, '.muster', 'scheduler', 'workflow-triggers.json')), '触发状态落盘');

  rt.revokeTrust(WS, 'cron');
  assert.deepEqual(st.revoked, ['cron']);
  fs.rmSync(trigRoot, { recursive: true, force: true });
  console.log('ok: 定时触发（信任门/基准/补跑一次/改后跳过并提醒）');
}

// ---------- 14) 事件触发（冷却/防连锁/workflow 种类） ----------
{
  const trigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-trig-'));
  writeWorkflow(
    'onblock',
    'description: 卡住时\nargs: event\non: {"kind":"phase","trigger":"error"}\ncooldown: 1',
    `export default async function (wf, args) { return args.event.sessionId; }\n`,
    trigRoot
  );
  writeWorkflow('holder', 'description: 派活后挂起', `export default async function (wf) { await wf.delegate({ isolate: false, task: 'x' }); await wf.ask('挂起'); }\n`, trigRoot);
  const st = newState();
  st.clock = { now: 1_000_000_000_000 };
  const rt = makeRuntime(st, trigRoot);
  const runs = () => listRunRecords(trigRoot).filter((r) => r.name === 'onblock');

  rt.onEvent(WS, { kind: 'phase', sessionId: 'ext1', trigger: 'needs_you' });
  assert.equal(runs().length, 0, '不匹配不触发');
  rt.onEvent(WS, { kind: 'phase', sessionId: 'ext1', trigger: 'error' });
  await until(() => runs()[0]?.status === 'completed', '事件 run 完成');
  assert.equal(runs()[0].result, 'ext1', '事件字段作为 args.event 传入');
  assert.equal(runs()[0].trigger, 'event');

  rt.onEvent(WS, { kind: 'phase', sessionId: 'ext2', trigger: 'error' });
  assert.equal(runs().length, 1, '冷却期内不触发');

  st.clock.now += 2 * 60_000;
  const holder = await rt.startRun(WS, 'holder', {});
  await until(() => lastEvent(st, 'ask'), 'holder 派活');
  rt.onEvent(WS, { kind: 'phase', sessionId: 't1', trigger: 'error' });
  rt.onEvent(WS, { kind: 'workflow', taskId: 'ext3', to: 'blocked' });
  assert.equal(runs().length, 1, '工作流自己派的任务 / workflow 事件不触发');
  await rt.cancel(WS, holder.runId);
  rt.onEvent(WS, { kind: 'phase', sessionId: 't1', trigger: 'error' });
  assert.equal(runs().length, 1, 'run 结束后其派出的任务仍在防连锁期内');

  st.trustStates.onblock = 'never';
  rt.onEvent(WS, { kind: 'phase', sessionId: 'ext4', trigger: 'error' });
  assert.equal(runs().length, 1, '未信任不触发');
  st.trustStates.onblock = 'trusted';
  rt.onEvent(WS, { kind: 'phase', sessionId: 'ext5', trigger: 'error' });
  await until(() => runs().length === 2 && runs().every((r) => r.status === 'completed'), '冷却后再触发');
  fs.rmSync(trigRoot, { recursive: true, force: true });
  console.log('ok: 事件触发（匹配/冷却/防连锁/信任门）');
}

// ---------- 15) 面板：停用 / 启用触发、删除工作流 ----------
{
  const trigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-trig-'));
  writeWorkflow('cron2', 'description: 定时\nschedule: every 1h', `export default async function () { return 'tick'; }\n`, trigRoot);
  writeWorkflow('onev', 'description: 事件\nargs: event\non: {"kind":"fact"}', `export default async function () { return 1; }\n`, trigRoot);
  writeWorkflow('busy', 'description: 挂起', `export default async function (wf) { await wf.ask('等'); }\n`, trigRoot);
  const st = newState();
  st.clock = { now: 1_000_000_000_000 };
  const rt = makeRuntime(st, trigRoot);
  const runsOf = (name) => listRunRecords(trigRoot).filter((r) => r.name === name);
  const item = (name) => rt.overview(WS).workflows.find((w) => w.name === name);

  rt.checkTriggers();
  rt.setTriggersEnabled(WS, 'cron2', false);
  st.clock.now += 2 * 3600_000;
  rt.checkTriggers();
  assert.equal(runsOf('cron2').length, 0, '停用后到点不触发');
  assert.equal(item('cron2').triggersDisabled, true);
  assert.equal(item('cron2').nextDueAt, undefined, '停用时不显示下次时间');
  assert.equal(rt.list(WS).workflows.find((w) => w.name === 'cron2').triggersDisabled, true, '调度 workflow.list 也看得到');

  rt.setTriggersEnabled(WS, 'cron2', true);
  rt.checkTriggers();
  assert.equal(runsOf('cron2').length, 0, '恢复时从此刻重立基准，不补跑停用期间');
  assert.equal(item('cron2').nextDueAt, st.clock.now + 3600_000);
  st.clock.now += 61 * 60_000;
  rt.checkTriggers();
  await until(() => runsOf('cron2')[0]?.status === 'completed', '恢复后到点触发');

  rt.checkTriggers();
  rt.setTriggersEnabled(WS, 'onev', false);
  rt.onEvent(WS, { kind: 'fact', sessionId: 'x' });
  assert.equal(runsOf('onev').length, 0, '停用后事件不触发');
  const persisted = JSON.parse(fs.readFileSync(path.join(trigRoot, '.muster', 'scheduler', 'workflow-triggers.json'), 'utf8'));
  assert.equal(persisted.onev.disabled, true, '停用状态落盘');

  const b = await rt.startRun(WS, 'busy', {});
  await until(() => lastEvent(st, 'ask'), 'busy 挂起');
  await assert.rejects(rt.deleteWorkflow(WS, 'busy'), /先取消/, '有运行中的 run 时拒绝删除');
  await rt.cancel(WS, b.runId);
  const removed = [];
  st.removeDir = async (dir) => {
    removed.push(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const rt2 = makeRuntime(st, trigRoot);
  await rt2.deleteWorkflow(WS, 'cron2');
  assert.deepEqual(removed, [path.join(trigRoot, '.muster', 'workflows', 'cron2')], '删除走 removeDir（wiring=回收站）');
  assert.ok(!fs.existsSync(path.join(trigRoot, '.muster', 'workflows', 'cron2')));
  assert.ok(st.revoked.includes('cron2'), '删除时一并撤销信任');
  assert.equal(rt2.overview(WS).workflows.some((w) => w.name === 'cron2'), false);
  const after = JSON.parse(fs.readFileSync(path.join(trigRoot, '.muster', 'scheduler', 'workflow-triggers.json'), 'utf8'));
  assert.equal(after.cron2, undefined, '触发状态随之清掉');
  await assert.rejects(rt2.deleteWorkflow(WS, '../outside'), /不合法/, '名字防越界');
  await assert.rejects(rt2.deleteWorkflow(WS, 'nope'), /找不到/);
  fs.rmSync(trigRoot, { recursive: true, force: true });
  console.log('ok: 停用/启用触发 + 删除工作流');
}

// ---------- 16) 手动清理运行历史 ----------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-clear-'));
  writeWorkflow('quick', 'description: 秒完', `export default async function () { return 1; }\n`, root);
  writeWorkflow('kid', 'description: 子', `export default async function () { return 2; }\n`, root);
  writeWorkflow('dad', 'description: 父', `export default async function (wf) { return await wf.call('kid', {}); }\n`, root);
  writeWorkflow('hold', 'description: 挂起', `export default async function (wf) { await wf.ask('等'); }\n`, root);
  const st = newState();
  const rt = makeRuntime(st, root);
  const a = await rt.startRun(WS, 'quick', {});
  const b = await rt.startRun(WS, 'quick', {});
  const d = await rt.startRun(WS, 'dad', {});
  await until(() => [a, b, d].every((r) => readRunRecord(root, r.runId)?.status === 'completed'), '三个 run 完成');
  const h = await rt.startRun(WS, 'hold', {});
  await until(() => lastEvent(st, 'ask'), 'hold 挂起');
  const ids = () => listRunRecords(root).map((r) => r.runId).sort();
  const kidId = listRunRecords(root).find((r) => r.name === 'kid').runId;

  assert.equal(rt.clearRuns(WS, [a.runId, h.runId]), 1, '指定删除只删已结束的');
  assert.equal(readRunRecord(root, a.runId), null);
  assert.ok(readRunRecord(root, h.runId), '运行中的不删');
  assert.equal(rt.clearRuns(WS), 2, '清空全部已结束的顶层 run');
  assert.deepEqual(ids(), [h.runId], '子 run 随父删除，运行中的保留');
  assert.equal(readRunRecord(root, kidId), null);
  await rt.cancel(WS, h.runId);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('ok: 手动清理运行历史');
}

// ---------- 17) W1：validate 信任门（未确认不 import；确认后执行型校验；顶层 throw 可见） ----------
writeWorkflow(
  'vlite',
  'description: w1',
  `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(wsRoot, 'w1-marker'))}, 'top');
export default async () => null;
`
);
writeWorkflow('vthrow', 'description: throw', `throw new Error('顶层爆炸');\nexport default async () => null;\n`);
writeWorkflow('vsyn', 'description: syn', `export default async function ((\n`);
{
  const marker = path.join(wsRoot, 'w1-marker');
  const st = newState();
  st.trust = false;
  const rt = makeRuntime(st);
  const v = await rt.validate(WS, 'vlite');
  assert.equal(v.ok, false, '拒绝确认时 validate 不通过');
  assert.deepEqual(v.exec, { performed: false, reason: 'declined' }, '标明未做执行型校验');
  assert.match(v.errors[0], /跳过执行型校验/);
  assert.equal(fs.existsSync(marker), false, '未确认前顶层标记不存在');
  assert.deepEqual(st.trustAsks, ['vlite'], '确实尝试了确认');
  st.trust = true;
  const v2 = await rt.validate(WS, 'vlite');
  assert.equal(v2.ok, true);
  assert.deepEqual(v2.exec, { performed: true }, '确认后做了执行型校验');
  assert.equal(fs.existsSync(marker), true, '确认后 import 执行模块顶层');
  const v3 = await rt.validate(WS, 'vthrow');
  assert.equal(v3.ok, false);
  assert.match(v3.errors[0], /顶层爆炸/, '顶层 throw 在结果里可见');
  assert.deepEqual(v3.exec, { performed: true });
  const v4 = await rt.validate(WS, 'vsyn');
  assert.equal(v4.ok, false, '语法错误可见');
  assert.match(v4.errors[0], /冒烟 import 失败/);
  // 内核层：顶层阻塞代码的 import 超时可见（短超时直测，避免 10s 默认拖慢套件）
  const blockScript = path.join(wsRoot, '.muster', 'workflows', 'vsyn', 'block.mjs');
  fs.writeFileSync(blockScript, `await new Promise(() => {});\nexport default async () => null;\n`);
  const smokeErr = await kernelMod.smokeImportWorkflow(blockScript, 'fp', 250);
  assert.match(smokeErr, /超时/, 'import 超时可见');
  console.log('ok: W1 validate 信任门（拒绝不 import / 确认后执行型 / throw·语法·超时可见）');
}

// ---------- 18) W2：撤销/改过未确认后重启不续跑；子工作流同口径 ----------
writeWorkflow('resume2', 'description: w2', `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(wsRoot, 'w2-marker'))}, 'run\\n');\nexport default async (wf) => { await wf.ask('等', { to: 'human' }); };\n`);
{
  const marker = path.join(wsRoot, 'w2-marker');
  const count = () => fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
  const st1 = newState();
  const rt1 = makeRuntime(st1);
  const rec = await rt1.startRun(WS, 'resume2', {});
  await until(() => rt1.get(WS, rec.runId).pendingAsk, '首跑挂起');
  await rt1.shutdown();
  assert.equal(count(), 1);
  const st2 = newState();
  st2.trustStates.resume2 = 'never'; // 撤销信任（指纹未变）
  const rt2 = makeRuntime(st2);
  rt2.resumeAll();
  await until(() => readRunRecord(wsRoot, rec.runId)?.status === 'interrupted', '阻断后标记中断');
  const saved = readRunRecord(wsRoot, rec.runId);
  assert.match(saved.error, /信任已撤销/);
  assert.equal(count(), 1, '无新的顶层执行');
  assert.match(lastEvent(st2, 'interrupted').detail, /撤销/);
  assert.notEqual(saved.memo, undefined, 'memo 保留在记录里');

  // 改过未确认（changed）：同口径阻断
  const rt3 = makeRuntime(st1);
  const rec2 = await rt3.startRun(WS, 'resume2', {});
  await until(() => rt3.get(WS, rec2.runId).pendingAsk, '第二轮挂起');
  await rt3.shutdown();
  const st4 = newState();
  st4.trustStates.resume2 = 'changed';
  makeRuntime(st4).resumeAll();
  await until(() => readRunRecord(wsRoot, rec2.runId)?.status === 'interrupted', 'changed 阻断');
  assert.match(readRunRecord(wsRoot, rec2.runId).error, /旧版本|未确认/);
  assert.equal(count(), 2, '只有两次首跑，无恢复执行');

  // 子工作流：子信任被撤销时随父恢复不重跑，父失败可见
  writeWorkflow('wkid', 'description: 子', `export default async (wf) => { await wf.ask('子等'); };\n`);
  writeWorkflow('wdad', 'description: 父', `export default async (wf) => { await wf.call('wkid', {}); };\n`);
  const st5 = newState();
  const rt5 = makeRuntime(st5);
  const dad = await rt5.startRun(WS, 'wdad', {});
  await until(() => lastEvent(st5, 'ask'), '子工作流挂起');
  await rt5.shutdown();
  const kidRec = listRunRecords(wsRoot).find((r) => r.name === 'wkid');
  const st6 = newState();
  st6.trustStates.wkid = 'never'; // 只撤销子工作流
  const rt6 = makeRuntime(st6);
  rt6.resumeAll();
  await until(() => readRunRecord(wsRoot, dad.runId)?.status === 'failed', '父因子阻断而失败');
  assert.equal(readRunRecord(wsRoot, kidRec.runId).status, 'interrupted', '子标记中断');
  assert.match(readRunRecord(wsRoot, kidRec.runId).error, /信任已撤销/);
  assert.match(readRunRecord(wsRoot, dad.runId).error, /子工作流/);
  await rt6.shutdown();
  console.log('ok: W2 撤销/改过未确认阻断续跑（含子工作流）');
}

// ---------- 19) W3：取消收回在途派活（排队撤销 / 创建中迟到补关 / 已创建未返回 / 双取消） ----------
{
  const qRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-w3-'));
  writeWorkflow('qlate', 'description: q', `export default async (wf) => { await wf.delegate({ isolate: false, task: '排队活' }); await wf.ask('等'); };\n`, qRoot);
  const qctx = {
    config: { get: () => ({ workspaces: [{ id: WS, path: qRoot }] }) },
    sessions: { listByWorkspace: () => [] },
    notify: { push() {} }
  };
  const runnerCalls = [];
  const qRuntime = (st, gate) => {
    const bridge = bridgeMod.createQueuedDelegateBridge((res) => ({
      sessionId: res.session?.id,
      sessionName: res.session?.name,
      taskId: res.session?.meta?.creationKey
    }));
    return new WorkflowRuntime({
      workspaceIds: () => [WS],
      workspaceRoot: (ws) => (ws === WS ? qRoot : undefined),
      emit: (ws, e) => st.events.push({ ws, ...e }),
      delegate: async (_ws, input, ctl) => {
        const { queueId } = queueMod.enqueueDelegate(qctx, WS, { task: input.task, creationKey: input.creationKey, isolate: input.isolate });
        return bridge.waitQueued(queueId, ctl);
      },
      executeTool: async (_ws, name, args) => {
        st.tools.push({ name, args });
        return sessionTool(st, name, args);
      },
      ensureTrusted: async () => true,
      trustState: () => 'trusted',
      setInterval: () => 0,
      clearInterval() {}
    });
  };

  // 19a 排队未出队：取消直接撤销，不创建会话，占位 memo 清理
  queueMod.resetDelegateQueueForTests();
  queueMod.bindDelegateRunner(async (_ctx, input) => {
    runnerCalls.push(input.task);
    return { session: { id: 'q-s1', name: 'Q', meta: { creationKey: input.creationKey } } };
  });
  {
    const st = newState();
    const rt = qRuntime(st);
    const rec = await rt.startRun(WS, 'qlate', {});
    await until(() => queueMod.listDelegateQueue(WS).length === 1, '已入队未出队');
    assert.deepEqual(runnerCalls, [], '未真正派活');
    const out = await rt.cancel(WS, rec.runId, '测', { closeSessions: true });
    assert.equal(out.status, 'cancelled');
    assert.equal((out.revokedDelegates ?? []).length, 1, '排队项被撤销');
    assert.equal(queueMod.listDelegateQueue(WS).length, 0, '队列出清');
    await delay(150);
    assert.deepEqual(runnerCalls, [], '撤销后不再执行');
    const saved = readRunRecord(qRoot, rec.runId);
    assert.ok(!JSON.stringify(saved.memo).includes(WORKFLOW_MEMO_PENDING), '占位 memo 已清');
    assert.equal(saved.delegates, 0, '计数回退');
    assert.deepEqual(st.tools, [], '无需关会话（未创建）');
  }

  // 19b 创建中（launching）：撤不掉 → closeSessions 迟到补关 + 记账
  queueMod.resetDelegateQueueForTests();
  let gateResolve;
  const gate = new Promise((r) => {
    gateResolve = r;
  });
  queueMod.bindDelegateRunner(async (_ctx, input) => {
    runnerCalls.push(input.task);
    await gate;
    return { session: { id: 'q-late', name: '迟到', meta: { creationKey: input.creationKey } } };
  });
  {
    const st = newState();
    const rt = qRuntime(st);
    const rec = await rt.startRun(WS, 'qlate', {});
    await until(() => queueMod.listDelegateQueue(WS).length === 1, '已入队');
    void queueMod.drainDelegateQueue(WS); // 手动触发槽位出队（真实队列联动），runner 挂在 gate 上
    await until(() => runnerCalls.length >= 1 && queueMod.listDelegateQueue(WS).length === 0, '已出队创建中');
    const out = await rt.cancel(WS, rec.runId, '测', { closeSessions: true });
    assert.deepEqual(out.closed, [], '取消时点没有可关会话');
    assert.equal((out.lateDelegates ?? []).length, 1, '在途派活登记为迟到');
    assert.match(out.note ?? '', /自动补关/);
    gateResolve();
    await until(() => st.tools.some((t) => t.name === 'sessions.delete' && t.args.sessionIds.includes('q-late')), '迟到补关会话');
    const saved = readRunRecord(qRoot, rec.runId);
    assert.ok((saved.sessions ?? []).includes('q-late'), '迟到会话记入归属');
    assert.ok(saved.log.some((l) => /迟到/.test(l.text)), '迟到结算写进日志');
  }

  // 19c closeSessions:false：迟到会话保留（语义不变）但仍记账（新 gate 模拟创建中）
  queueMod.resetDelegateQueueForTests();
  {
    let gate2Resolve;
    const gate2 = new Promise((r) => {
      gate2Resolve = r;
    });
    queueMod.bindDelegateRunner(async (_ctx, input) => {
      runnerCalls.push(input.task);
      await gate2;
      return { session: { id: 'q-keep', name: '保留', meta: { creationKey: input.creationKey } } };
    });
    const st = newState();
    const rt = qRuntime(st);
    const rec = await rt.startRun(WS, 'qlate', {});
    await until(() => queueMod.listDelegateQueue(WS).length === 1, '第三个已入队');
    void queueMod.drainDelegateQueue(WS);
    await until(() => runnerCalls.length >= 2, '第二个排队活创建中');
    const out = await rt.cancel(WS, rec.runId, '测', { closeSessions: false });
    assert.equal((out.lateDelegates ?? []).length, 1);
    assert.ok(!('closed' in out), '不关会话');
    gate2Resolve();
    await delay(150);
    const saved = readRunRecord(qRoot, rec.runId);
    assert.ok((saved.sessions ?? []).includes('q-keep'), '会话保留且记账');
    assert.ok(!st.tools.some((t) => t.args?.sessionIds?.includes('q-keep')), '未补关');
    // 重复取消：run 已结算，不再触碰资源
    const again = await rt.cancel(WS, rec.runId, '再取消', { closeSessions: true });
    assert.match(again.note, /已不在运行/);
    assert.deepEqual(st.tools, [], '重复取消不新增关闭动作');
  }
  queueMod.resetDelegateQueueForTests();
  fs.rmSync(qRoot, { recursive: true, force: true });
  console.log('ok: W3 取消收回在途派活（排队撤销/创建中迟到补关/保留语义/双取消）');
}

// ---------- 20) W4：取消/超时停止自有进程树（真 Windows shell→Node→孙进程） ----------
if (process.platform === 'win32') {
  const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-w4-'));
  const ready = path.join(tRoot, 'ready');
  const late = path.join(tRoot, 'after-cancel');
  const tick = path.join(tRoot, 'tick');
  const grand = path.join(tRoot, 'grand.cjs');
  const parent = path.join(tRoot, 'parent.cjs');
  fs.writeFileSync(
    grand,
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, '1'); setInterval(() => fs.appendFileSync(${JSON.stringify(late)}, 'x'), 100); setTimeout(() => process.exit(0), 20_000);\n`
  );
  fs.writeFileSync(
    parent,
    `const cp = require('node:child_process');\ncp.spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`
  );
  writeWorkflow('tree', 'description: 树', `export default async (wf) => await wf.run(${JSON.stringify(process.execPath)}, [${JSON.stringify(parent)}]);\n`, tRoot);
  {
    const st = newState();
    const rt = makeRuntime(st, tRoot);
    const rec = await rt.startRun(WS, 'tree', {});
    await until(() => fs.existsSync(ready), '子命令 ready');
    await until(() => fs.existsSync(late), '孙进程已持续写入');
    await rt.cancel(WS, rec.runId, '测');
    await assertStopsWriting(late, '取消后孙进程停止持续写入（整棵树停止）');
    const saved = readRunRecord(tRoot, rec.runId);
    assert.ok(saved.log.some((l) => /停止本 run 的外部命令/.test(l.text)), '停止动作写日志');
  }
  // 超时：同一资源收回策略，进程真实终止（marker 不再增长）
  writeWorkflow(
    'tmo',
    'description: 超时',
    `export default async (wf) => await wf.run(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(
      `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], ''); setInterval(() => fs.appendFileSync(process.argv[1], 'x'), 200);`
    )}, ${JSON.stringify(tick)}], { timeoutMs: 300 });\n`,
    tRoot
  );
  {
    const st = newState();
    const rt = makeRuntime(st, tRoot);
    const rec = await rt.startRun(WS, 'tmo', {});
    await until(() => readRunRecord(tRoot, rec.runId)?.status === 'completed', '超时后命令收尾');
    const result = readRunRecord(tRoot, rec.runId).result;
    assert.equal(result.timedOut, true, '标明超时');
    assert.notEqual(result.code, 0, '非零退出');
    const n1 = fs.existsSync(tick) ? fs.readFileSync(tick, 'utf8').length : 0;
    await delay(800);
    const n2 = fs.existsSync(tick) ? fs.readFileSync(tick, 'utf8').length : 0;
    assert.equal(n2, n1, '进程树已终止，输出不再增长');
  }
  fs.rmSync(tRoot, { recursive: true, force: true });
  console.log('ok: W4 取消/超时停止自有进程树（真 shell→Node→孙进程）');
} else {
  console.log('skip: W4 进程树用例仅 Windows（POSIX 边界见 dynamic-workflow.md）');
}

// ---------- 21) W1 真实入口：经能力宿主 workflow.validate（调度身份门 + 信任门） ----------
{
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-host-'));
  const marker = path.join(hostRoot, 'host-marker');
  writeWorkflow(
    'vh',
    'description: 入口',
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x'); export default async () => null;\n`,
    hostRoot
  );
  const st = newState();
  st.trust = false;
  const rt = makeRuntime(st, hostRoot);
  const { workflowHost } = await import(pathToFileURL(compile('main/capabilities/hosts/workflow.ts')).href);
  const { runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')).href);
  const { bindWorkflowRuntime } = await import(pathToFileURL(compile('main/workflow/runtimeRef.ts')).href);
  bindWorkflowRuntime(rt);
  const ctx = { config: { get: () => ({ activeWorkspaceId: WS }) } };
  // 非调度身份：能力门拒绝（host 是同步抛错，包一层 async）
  await assert.rejects(async () => workflowHost['workflow.validate'](ctx, { name: 'vh' }), /仅调度/);
  // 调度身份 + 拒绝确认：不 import，exec 标明
  const res = await runAsSchedulerTool(() => workflowHost['workflow.validate'](ctx, { name: 'vh' }));
  assert.equal(res.ok, false);
  assert.deepEqual(res.exec, { performed: false, reason: 'declined' });
  assert.equal(fs.existsSync(marker), false, '真实入口下未确认不执行顶层');
  // 调度身份 + 确认：执行型校验真正跑模块顶层
  st.trust = true;
  const res2 = await runAsSchedulerTool(() => workflowHost['workflow.validate'](ctx, { name: 'vh' }));
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.exec, { performed: true });
  assert.equal(fs.existsSync(marker), true);
  bindWorkflowRuntime(null);
  fs.rmSync(hostRoot, { recursive: true, force: true });
  console.log('ok: W1 真实能力入口（调度身份门 + 信任门）');
}

// ---------- 22) r1-W1：确认等待期间改 run.mjs，执行绑定被确认的版本 ----------
{
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r1w1-'));
  const marker = path.join(hostRoot, 'bind-marker');
  const scriptPath = path.join(hostRoot, '.muster', 'workflows', 'vbind', 'run.mjs');
  const v1 = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'exec-v1'); export default async () => null;\n`;
  const v2 = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'exec-v2'); export default async () => null;\n`;
  writeWorkflow('vbind', 'description: 绑定', v1, hostRoot);
  const makeRt = (st, mutateOnce) =>
    new WorkflowRuntime({
      workspaceIds: () => [WS],
      workspaceRoot: (ws) => (ws === WS ? hostRoot : undefined),
      emit: (ws, e) => st.events.push({ ws, ...e }),
      delegate: async () => ({ sessionId: 'x' }),
      executeTool: async () => ({ ok: true }),
      ensureTrusted: async (_ws, loaded) => {
        st.trustAsks.push(loaded.fingerprint);
        // 模拟：弹框等待期间 run.mjs 被改（用户确认的是旧指纹）
        if (mutateOnce && !st.mutated) {
          st.mutated = true;
          fs.writeFileSync(scriptPath, v2);
        }
        if (!mutateOnce && st.trustAsks.length < 6) fs.writeFileSync(scriptPath, `// churn ${st.trustAsks.length}\n${v1}`);
        return true;
      },
      trustState: () => 'never',
      setInterval: () => 0,
      clearInterval() {}
    });
  // start：旧指纹确认 → 重读发现变更 → 对新内容重新确认 → 执行的是新版本
  {
    const st = { events: [], trustAsks: [], mutated: false };
    const rt = makeRt(st, true);
    const rec = await rt.startRun(WS, 'vbind', {});
    await until(() => readRunRecord(hostRoot, rec.runId)?.status === 'completed', '绑定后完成');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'exec-v2', '未执行旧指纹版本的内容');
    assert.equal(st.trustAsks.length, 2, '新内容重新过了确认');
    const { loadWorkflow } = await import(pathToFileURL(compile('main/workflow/store.ts')).href);
    assert.equal(readRunRecord(hostRoot, rec.runId).fingerprint, loadWorkflow(hostRoot, 'vbind').fingerprint, 'run 记录绑定磁盘当前版本指纹');
  }
  // validate 同口径：确认后重读，冒烟的是新版本
  {
    fs.writeFileSync(scriptPath, v1);
    fs.rmSync(marker, { force: true });
    const st = { events: [], trustAsks: [], mutated: false };
    const rt = makeRt(st, true);
    const v = await rt.validate(WS, 'vbind');
    assert.equal(v.ok, true);
    assert.deepEqual(v.exec, { performed: true });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'exec-v2', '冒烟 import 的是重读后的新版本');
    const { loadWorkflow } = await import(pathToFileURL(compile('main/workflow/store.ts')).href);
    assert.equal(v.fingerprint, loadWorkflow(hostRoot, 'vbind').fingerprint);
  }
  // 反复变化：有界循环后拒绝，不执行任何版本
  {
    fs.writeFileSync(scriptPath, v1);
    fs.rmSync(marker, { force: true });
    const st = { events: [], trustAsks: [], mutated: false };
    const rt = makeRt(st, false);
    await assert.rejects(rt.startRun(WS, 'vbind', {}), /稳定|变化/);
    assert.equal(fs.existsSync(marker), false, '未执行未绑定成功的任何版本');
    rt.stop();
  }
  fs.rmSync(hostRoot, { recursive: true, force: true });
  console.log('ok: r1-W1 确认等待期间改文件不执行未确认内容（start/validate/反复变化）');
}

// ---------- 23) r1-W3：迟到失败带已建会话——补偿关/记账 + 关闭失败可见 ----------
writeWorkflow('l8fail', 'description: 迟到失败', `export default async (wf) => { await wf.delegate({ isolate: false, task: '迟到失败活' }); await wf.ask('等'); };\n`);
{
  const mk = (closeFails) => {
    const st = newState();
    let fire;
    const pendingReject = new Promise((_resolve, reject) => {
      fire = () => {
        // 生产形态（delegate.ts）：会话建出后投递失败，错误携带 sessionId、会话保留
        const err = new Error('Worker task delivery failed (session orphan-1; session retained): 注入');
        err.sessionId = 'orphan-1';
        reject(err);
      };
    });
    const rt = new WorkflowRuntime({
      workspaceIds: () => [WS],
      workspaceRoot: (ws) => (ws === WS ? wsRoot : undefined),
      emit: (ws, e) => st.events.push({ ws, ...e }),
      delegate: () => {
        st.delegates.push({ task: 'late-fail' });
        return pendingReject;
      },
      executeTool: async (_ws, name, args) => {
        st.tools.push({ name, args });
        return sessionTool(st, name, args);
      },
      ensureTrusted: async () => true,
      trustState: () => 'trusted',
      setInterval: () => 0,
      clearInterval() {}
    });
    if (closeFails) st.toolFail = (name, args) => name === 'sessions.delete' && args.sessionIds.includes('orphan-1');
    return { st, rt, fire };
  };
  // closeSessions:true：迟到失败也补关 + 记账
  {
    const { st, rt, fire } = mk(false);
    const rec = await rt.startRun(WS, 'l8fail', {});
    await until(() => st.delegates.length >= 1, '派活在途');
    const out = await rt.cancel(WS, rec.runId, '测', { closeSessions: true });
    assert.equal((out.lateDelegates ?? []).length, 1);
    fire();
    await until(() => st.tools.some((t) => t.name === 'sessions.delete' && t.args.sessionIds.includes('orphan-1')), '迟到失败补关');
    const saved = readRunRecord(wsRoot, rec.runId);
    assert.ok((saved.sessions ?? []).includes('orphan-1'), '已建会话记入归属');
    assert.ok(saved.log.some((l) => /迟到失败/.test(l.text)), '迟到失败写日志');
  }
  // closeSessions:false：保留会话但记账
  {
    const { st, rt, fire } = mk(false);
    const rec = await rt.startRun(WS, 'l8fail', {});
    await until(() => st.delegates.length >= 1, '派活在途2');
    await rt.cancel(WS, rec.runId, '测', { closeSessions: false });
    fire();
    await delay(150);
    const saved = readRunRecord(wsRoot, rec.runId);
    assert.ok((saved.sessions ?? []).includes('orphan-1'), '保留语义：会话仍记账');
    assert.ok(!st.tools.some((t) => t.args?.sessionIds?.includes('orphan-1')), '未补关');
  }
  // 补关失败可见（关不掉逐条报进日志）
  {
    const { st, rt, fire } = mk(true);
    const rec = await rt.startRun(WS, 'l8fail', {});
    await until(() => st.delegates.length >= 1, '派活在途3');
    await rt.cancel(WS, rec.runId, '测', { closeSessions: true });
    fire();
    await until(() => (readRunRecord(wsRoot, rec.runId).log ?? []).some((l) => /关闭失败/.test(l.text)), '补关失败入日志');
  }
  console.log('ok: r1-W3 迟到失败带已建会话：补关/记账/关闭失败可见');
}

// ---------- 24) r1-W4：Job 容器不依赖 taskkill（二进制缺失仍可真实回收） ----------
if (process.platform === 'win32') {
  const kRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r1w4-'));
  const script = path.join(kRoot, 'selfexit.cjs');
  fs.writeFileSync(script, `setTimeout(() => {}, 1200);\n`); // 最多自活 1.2s，防泄漏
  writeWorkflow('kfail', 'description: 收树失败', `export default async (wf) => await wf.run(${JSON.stringify(process.execPath)}, [${JSON.stringify(script)}]);\n`, kRoot);
  const prevBin = process.env.MUSTER_TASKKILL_BIN;
  process.env.MUSTER_TASKKILL_BIN = path.join(kRoot, 'no-such-taskkill.exe');
  try {
    const st = newState();
    const rt = makeRuntime(st, kRoot);
    const rec = await rt.startRun(WS, 'kfail', {});
    await delay(500); // 命令已起（不依赖输出，只求在途）
    await rt.cancel(WS, rec.runId, '测');
    await until(
      () => (readRunRecord(kRoot, rec.runId)?.log ?? []).some((l) => /停止本 run 的外部命令/.test(l.text)),
      '回退写入日志'
    );
    const saved = readRunRecord(kRoot, rec.runId);
    assert.equal(saved.status, 'cancelled');
    await delay(300);
    assert.equal(readRunRecord(kRoot, rec.runId).status, 'cancelled', '宿主与收尾不受影响（无未处理 error）');
  } finally {
    if (prevBin === undefined) delete process.env.MUSTER_TASKKILL_BIN;
    else process.env.MUSTER_TASKKILL_BIN = prevBin;
    // 回退只杀 shell，孙进程（cwd 在 kRoot）自活到 1.2s 后目录才可删
    for (let i = 0; i < 20; i++) {
      try {
        fs.rmSync(kRoot, { recursive: true, force: true });
        break;
      } catch {
        await delay(150);
      }
    }
  }
  console.log('ok: r1-W4 Job ownership remains effective when taskkill is unavailable');
}

// ---------- 25) r1-W3：取消早于撤销回调登记（交接窗口） ----------
{
  const hRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r1handoff-'));
  writeWorkflow('hwait', 'description: 交接', `export default async (wf) => { await wf.delegate({ isolate: false, task: '交接活' }); await wf.ask('等'); };\n`, hRoot);
  const qctx = {
    config: { get: () => ({ workspaces: [{ id: WS, path: hRoot }] }) },
    sessions: { listByWorkspace: () => [] },
    notify: { push() {} }
  };
  const runnerCalls = [];
  queueMod.resetDelegateQueueForTests();
  queueMod.bindDelegateRunner(async (_ctx, input) => {
    runnerCalls.push(input.task);
    return { session: { id: 'h-s1', meta: { creationKey: input.creationKey } } };
  });
  let pauseResolve;
  const pause = new Promise((r) => {
    pauseResolve = r;
  });
  let delegateInvoked = false;
  const bridge = bridgeMod.createQueuedDelegateBridge((res) => ({
    sessionId: res.session?.id,
    sessionName: res.session?.name,
    taskId: res.session?.meta?.creationKey
  }));
  const st = newState();
  const rt = new WorkflowRuntime({
    workspaceIds: () => [WS],
    workspaceRoot: (ws) => (ws === WS ? hRoot : undefined),
    emit: (ws, e) => st.events.push({ ws, ...e }),
    // 模拟生产：delegateTask 在途（目录检查等 await）后才入队并登记撤销回调
    delegate: async (_ws, input, ctl) => {
      delegateInvoked = true;
      await pause;
      const { queueId } = queueMod.enqueueDelegate(qctx, WS, { task: input.task, creationKey: input.creationKey, isolate: input.isolate });
      return bridge.waitQueued(queueId, ctl);
    },
    executeTool: async (_ws, name, args) => {
      st.tools.push({ name, args });
      return sessionTool(st, name, args);
    },
    ensureTrusted: async () => true,
    trustState: () => 'trusted',
    setInterval: () => 0,
    clearInterval() {}
  });
  const rec = await rt.startRun(WS, 'hwait', {});
  await until(() => delegateInvoked, 'delegate 在途（未入队）');
  const out = await rt.cancel(WS, rec.runId, '测', { closeSessions: true });
  assert.equal((out.lateDelegates ?? []).length, 1, '取消时点尚未登记回调，只能先记迟到');
  pauseResolve(); // 出口继续：入队 + 晚登记回调
  await until(() => queueMod.listDelegateQueue(WS).length === 0, '交接窗口撤销：队列出清');
  await queueMod.drainDelegateQueue(WS);
  await delay(150);
  assert.deepEqual(runnerCalls, [], '晚登记消费已请求的取消，未真正派活');
  const saved = readRunRecord(hRoot, rec.runId);
  assert.ok(!JSON.stringify(saved.memo).includes(WORKFLOW_MEMO_PENDING), '占位 memo 已清');
  assert.equal(saved.delegates, 0, '计数回退');
  assert.deepEqual(st.tools, [], '无会话可关');
  queueMod.resetDelegateQueueForTests();
  fs.rmSync(hRoot, { recursive: true, force: true });
  console.log('ok: r1-W3 交接窗口：取消先于登记时晚登记立即撤销');
}

// ---------- 26) r1-W5：创建中取消后失败，队列不再重插重派 ----------
{
  const rRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r1req-'));
  writeWorkflow('rretry', 'description: 重派', `export default async (wf) => { await wf.delegate({ isolate: false, task: '取消后失败' }); await wf.ask('等'); };\n`, rRoot);
  const qctx = {
    config: { get: () => ({ workspaces: [{ id: WS, path: rRoot }] }) },
    sessions: { listByWorkspace: () => [] },
    notify: { push() {} }
  };
  const runnerCalls = [];
  queueMod.resetDelegateQueueForTests();
  let failGateResolve;
  const failGate = new Promise((r) => {
    failGateResolve = r;
  });
  queueMod.bindDelegateRunner(async (_ctx, input) => {
    runnerCalls.push(input.task);
    await failGate;
    throw new Error('创建失败注入');
  });
  const bridge = bridgeMod.createQueuedDelegateBridge((res) => ({
    sessionId: res.session?.id,
    taskId: res.session?.meta?.creationKey
  }));
  const st = newState();
  const rt = new WorkflowRuntime({
    workspaceIds: () => [WS],
    workspaceRoot: (ws) => (ws === WS ? rRoot : undefined),
    emit: (ws, e) => st.events.push({ ws, ...e }),
    delegate: async (_ws, input, ctl) => {
      const { queueId } = queueMod.enqueueDelegate(qctx, WS, { task: input.task, creationKey: input.creationKey, isolate: input.isolate });
      return bridge.waitQueued(queueId, ctl);
    },
    executeTool: async (_ws, name, args) => {
      st.tools.push({ name, args });
      return sessionTool(st, name, args);
    },
    ensureTrusted: async () => true,
    trustState: () => 'trusted',
    setInterval: () => 0,
    clearInterval() {}
  });
  const rec = await rt.startRun(WS, 'rretry', {});
  await until(() => queueMod.listDelegateQueue(WS).length === 1, '已入队');
  void queueMod.drainDelegateQueue(WS);
  await until(() => runnerCalls.length >= 1 && queueMod.listDelegateQueue(WS).length === 0, '已出队创建中');
  const out = await rt.cancel(WS, rec.runId, '测', { closeSessions: true });
  assert.equal((out.lateDelegates ?? []).length, 1);
  failGateResolve(); // 创建失败
  await until(
    () => (readRunRecord(rRoot, rec.runId).log ?? []).some((l) => /迟到失败/.test(l.text)),
    '取消后失败已结算'
  );
  // 槽位再释放也不重派
  await queueMod.drainDelegateQueue(WS);
  await queueMod.notifyDelegateSlotFreed(WS);
  await delay(200);
  assert.equal(runnerCalls.length, 1, '取消后失败不重插重派');
  assert.equal(queueMod.listDelegateQueue(WS).length, 0, '队列干净');
  const saved = readRunRecord(rRoot, rec.runId);
  assert.ok(!JSON.stringify(saved.memo).includes(WORKFLOW_MEMO_PENDING), 'pending 占位已清');
  assert.equal(saved.delegates, 0);
  queueMod.resetDelegateQueueForTests();
  fs.rmSync(rRoot, { recursive: true, force: true });
  console.log('ok: r1-W5 取消后创建失败不再重插重派，pending 已结算');
}

// ---------- 27) W4 补充：预算失败与关机也收自有进程树 ----------
{
  const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r1tree-'));
  const long = path.join(bRoot, 'tick.cjs');
  fs.writeFileSync(
    long,
    `const fs = require('node:fs'); const m = process.argv[2]; fs.writeFileSync(m, ''); setInterval(() => fs.appendFileSync(m, 'x'), 250); setTimeout(()=>process.exit(), 7000);\n`
  );
  const tickFile = path.join(bRoot, 'budget-tick');
  writeWorkflow(
    'boom',
    'description: 预算\nmaxDelegates: 1',
    `export default async (wf) => { const p = wf.run(${JSON.stringify(process.execPath)}, [${JSON.stringify(long)}, ${JSON.stringify(tickFile)}]); await wf.delegate({ isolate: false, task: 'a' }); await wf.delegate({ isolate: false, task: 'b' }); return 'unreachable'; }\n`,
    bRoot
  );
  {
    const st = newState();
    const rt = makeRuntime(st, bRoot);
    const rec = await rt.startRun(WS, 'boom', {});
    await until(() => readRunRecord(bRoot, rec.runId)?.status === 'failed', '派活超限失败');
    assert.match(readRunRecord(bRoot, rec.runId).error, /派活次数/);
    await assertStopsWriting(tickFile,'预算失败后自有子进程树已停');
  }
  const tick2 = path.join(bRoot, 'shutdown-tick');
  writeWorkflow('hold', 'description: 关机', `export default async (wf) => { await wf.run(${JSON.stringify(process.execPath)}, [${JSON.stringify(long)}, ${JSON.stringify(tick2)}]); }\n`, bRoot);
  {
    const st = newState();
    const rt = makeRuntime(st, bRoot);
    const rec = await rt.startRun(WS, 'hold', {});
    await until(() => fs.existsSync(tick2), '命令已起');
    await rt.shutdown();
    await assertStopsWriting(tick2,'关机后自有子进程树已停');
    assert.notEqual(readRunRecord(bRoot, rec.runId).status, 'completed');
  }
  fs.rmSync(bRoot, { recursive: true, force: true });
  console.log('ok: W4 预算失败与关机同样收自有进程树');
}

// ---------- 28) r2-W1：最终字节核对后、worker import 前改 run.mjs，执行的仍是已确认字节 ----------
{
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const nodeRequire = createRequire(import.meta.url);
  const wt = nodeRequire('node:worker_threads');
  const RealWorker = wt.Worker;
  const root28 = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r2bind-'));
  const marker28 = path.join(root28, 'bind28-marker');
  const script28 = path.join(root28, '.muster', 'workflows', 'bind28', 'run.mjs');
  const v1 = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker28)}, 'v1'); export default async () => null;\n`;
  const v2 = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker28)}, 'v2-UNCONFIRMED'); export default async () => null;\n`;
  writeWorkflow('bind28', 'description: 绑定字节', v1, root28);
  const doc28 = fs.readFileSync(path.join(path.dirname(script28), 'WORKFLOW.md'), 'utf8');
  const fp1 = workflowFingerprint(doc28, v1);
  // 在 worker 构造（= import 前）这一刻改写 run.mjs：模拟外部进程在「最终重读后、内核
  // import 前」的窄窗口写入未确认字节。修复后内核 import 的是已确认字节快照，不受影响。
  // 每轮只触发一次（start 一轮 / validate 一轮），轮间重置 run.mjs 为 v1。
  let mutateNext = true;
  const armMutate = () => {
    mutateNext = true;
  };
  wt.Worker = class extends RealWorker {
    constructor(source, options) {
      if (mutateNext) {
        mutateNext = false;
        fs.writeFileSync(script28, v2);
      }
      super(source, options);
    }
  };
  syncBuiltinESMExports();
  try {
    const rt = makeRuntime(newState(), root28);
    const rec = await rt.startRun(WS, 'bind28', {});
    await until(() => readRunRecord(root28, rec.runId)?.status === 'completed', '绑定 run 完成');
    assert.equal(fs.readFileSync(marker28, 'utf8'), 'v1', '执行的是已确认字节，窄窗口改盘不生效');
    assert.equal(readRunRecord(root28, rec.runId).fingerprint, fp1, '记录的仍是已确认指纹');
    assert.equal(fs.readFileSync(script28, 'utf8'), v2, '磁盘确实被改成了未确认字节（复现窗口）');
    // validate：重置为 v1 后再次在 import 前改盘——冒烟仍执行已确认字节
    fs.writeFileSync(script28, v1);
    fs.rmSync(marker28, { force: true });
    armMutate();
    const vv = await rt.validate(WS, 'bind28');
    assert.equal(vv.ok, true);
    assert.equal(fs.readFileSync(marker28, 'utf8'), 'v1', '冒烟 import 同样绑定已确认字节');
    assert.equal(vv.fingerprint, fp1);
    assert.equal(fs.readFileSync(script28, 'utf8'), v2, '磁盘再次被改（复现窗口）');
    await until(
      () => !fs.readdirSync(path.dirname(script28)).some((f) => f.startsWith('.exec-')),
      '快照文件已清理'
    );
  } finally {
    wt.Worker = RealWorker;
    syncBuiltinESMExports();
    fs.rmSync(root28, { recursive: true, force: true });
  }
  console.log('ok: r2-W1 import 前改盘不生效（start/validate 快照执行 + 快照清理）');
}

// ---------- 29) r2-W1：结构化资源贯穿真队列——取消后创建失败带 sessionId 仍补关/记账 ----------
{
  const qRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r2res-'));
  writeWorkflow('qres', 'description: 组合', `export default async (wf) => { await wf.delegate({ isolate: false, task: '组合场景' }); await wf.ask('等'); };\n`, qRoot);
  const qctx = {
    config: { get: () => ({ workspaces: [{ id: WS, path: qRoot }] }) },
    sessions: { listByWorkspace: () => [] },
    notify: { push() {} }
  };
  const mkCombo = (closeFails) => {
    const runnerCalls = [];
    let gateResolve;
    const gate = new Promise((r) => {
      gateResolve = r;
    });
    queueMod.resetDelegateQueueForTests();
    // 生产形态（delegate.ts → r2 队列贯穿）：会话建出后投递失败，错误带 sessionId
    queueMod.bindDelegateRunner(async (_ctx, input) => {
      runnerCalls.push(input.task);
      await gate;
      const err = new Error('Worker task delivery failed (session queued-created-session; session retained): 注入');
      err.sessionId = 'queued-created-session';
      throw err;
    });
    const bridge = bridgeMod.createQueuedDelegateBridge((res) => ({
      sessionId: res.session?.id,
      taskId: res.session?.meta?.creationKey
    }));
    const st = newState();
    if (closeFails) st.toolFail = (name, args) => name === 'sessions.delete' && args.sessionIds.includes('queued-created-session');
    const rt = new WorkflowRuntime({
      workspaceIds: () => [WS],
      workspaceRoot: (ws) => (ws === WS ? qRoot : undefined),
      emit: (ws, e) => st.events.push({ ws, ...e }),
      delegate: async (_ws, input, ctl) => {
        const { queueId } = queueMod.enqueueDelegate(qctx, WS, { task: input.task, creationKey: input.creationKey, isolate: input.isolate });
        return bridge.waitQueued(queueId, ctl);
      },
      executeTool: async (_ws, name, args) => {
        st.tools.push({ name, args });
        return sessionTool(st, name, args);
      },
      ensureTrusted: async () => true,
      trustState: () => 'trusted',
      setInterval: () => 0,
      clearInterval() {}
    });
    return { st, rt, runnerCalls, release: () => gateResolve() };
  };
  // closeSessions:true：真队列出口的带资源失败仍补关+记账
  {
    const { st, rt, runnerCalls, release } = mkCombo(false);
    const rec = await rt.startRun(WS, 'qres', {});
    await until(() => queueMod.listDelegateQueue(WS).length === 1, '入队');
    void queueMod.drainDelegateQueue(WS);
    await until(() => runnerCalls.length >= 1 && queueMod.listDelegateQueue(WS).length === 0, '创建中');
    const out = await rt.cancel(WS, rec.runId, '测', { closeSessions: true });
    assert.equal((out.lateDelegates ?? []).length, 1);
    release();
    await until(() => st.tools.some((t) => t.name === 'sessions.delete' && t.args.sessionIds.includes('queued-created-session')), '队列贯穿补关');
    const saved = readRunRecord(qRoot, rec.runId);
    assert.ok((saved.sessions ?? []).includes('queued-created-session'), '队列出口的已建会话记入归属');
    assert.ok(saved.log.some((l) => /迟到失败（会话已建出）/.test(l.text)), '迟到失败（带资源）写日志');
    assert.equal(runnerCalls.length, 1, '不重派');
  }
  // closeSessions:false：保留会话但记账（审计归属不丢）
  {
    const { st, rt, runnerCalls, release } = mkCombo(false);
    const rec = await rt.startRun(WS, 'qres', {});
    await until(() => queueMod.listDelegateQueue(WS).length === 1, '入队2');
    void queueMod.drainDelegateQueue(WS);
    await until(() => runnerCalls.length >= 1 && queueMod.listDelegateQueue(WS).length === 0, '创建中2');
    await rt.cancel(WS, rec.runId, '测', { closeSessions: false });
    release();
    await until(() => (readRunRecord(qRoot, rec.runId).sessions ?? []).includes('queued-created-session'), '保留记账');
    assert.ok(!st.tools.some((t) => t.args?.sessionIds?.includes('queued-created-session')), '未补关');
  }
  queueMod.resetDelegateQueueForTests();
  fs.rmSync(qRoot, { recursive: true, force: true });
  console.log('ok: r2-W1 结构化资源贯穿真队列（true 补关 / false 记账）');
}

// ---------- 30) r2-P2：确认期间定义重载（新增必填参数）后按最终定义重验 ----------
{
  const aRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r2args-'));
  const dir = path.join(aRoot, '.muster', 'workflows', 'rearg');
  writeWorkflow('rearg', 'description: 参数重验', `export default async () => 'ok';\n`, aRoot);
  const st = newState();
  let mutated = false;
  const rt = new WorkflowRuntime({
    workspaceIds: () => [WS],
    workspaceRoot: (ws) => (ws === WS ? aRoot : undefined),
    emit: (ws, e) => st.events.push({ ws, ...e }),
    delegate: async () => ({ sessionId: 'x' }),
    executeTool: async () => ({ ok: true }),
    ensureTrusted: async () => {
      if (!mutated) {
        mutated = true;
        // 首次确认等待期间：WORKFLOW.md 加了必填参数（定义重载）
        fs.writeFileSync(
          path.join(dir, 'WORKFLOW.md'),
          `---\nname: rearg\ndescription: 参数重验\nargs: requiredArg\n---\n说明\n`
        );
      }
      return true;
    },
    trustState: () => 'never',
    setInterval: () => 0,
    clearInterval() {}
  });
  await assert.rejects(rt.startRun(WS, 'rearg', {}), /requiredArg/, '按最终定义重验必填参数');
  assert.equal(mutated, true, '定义确实在确认期间重载');
  assert.equal(listRunRecords(aRoot).filter((r) => r.name === 'rearg').length, 0, '未创建 run');
  // 补齐参数后可正常启动（新定义路径可用）
  const rec = await rt.startRun(WS, 'rearg', { requiredArg: 'v' });
  await until(() => readRunRecord(aRoot, rec.runId)?.status === 'completed', '带参启动完成');
  fs.rmSync(aRoot, { recursive: true, force: true });
  console.log('ok: r2-P2 确认期间新增必填参数按最终定义重验');
}

// ---------- 31) r2-P2：taskkill 回退日志脱敏（整行命令与参数数组两种形态） ----------
if (process.platform === 'win32') {
  const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-r2tok-'));
  const prevBin = process.env.MUSTER_TASKKILL_BIN;
  process.env.MUSTER_TASKKILL_BIN = path.join(tRoot, 'no-such-taskkill.exe');
  // An unavailable legacy taskkill binary cannot disable Job ownership. Fixtures self-expire,
  // including when an assertion fails, so it cannot hold the runner's pipes forever.
  const park = (token) => `const s='${token}'; setTimeout(()=>{}, 1500);`;
  const assertSanitized = (root, runId, token) => {
    const saved = readRunRecord(root, runId);
    assert.ok(saved.log.some((l) => /停止本 run 的外部命令/.test(l.text)), '回退日志存在');
    assert.ok(!JSON.stringify(saved.log).includes(token), `合成 token 不落盘（${token}）`);
    assert.ok(!JSON.stringify(saved).includes(token), '整份 run 记录不含 token');
  };
  try {
    // 形态一：args 数组（带合成 secret 的 -e 代码）
    writeWorkflow(
      'tok1',
      'description: 脱敏1',
      `export default async (wf) => await wf.run(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(park('RTOK_ARRAY_SECRET'))}]);\n`,
      tRoot
    );
    {
      const st = newState();
      const rt = makeRuntime(st, tRoot);
      const rec = await rt.startRun(WS, 'tok1', {});
      await delay(500);
      await rt.cancel(WS, rec.runId, '测');
      await until(() => (readRunRecord(tRoot, rec.runId)?.log ?? []).some((l) => /停止本 run 的外部命令/.test(l.text)), '回退已发生');
      assertSanitized(tRoot, rec.runId, 'RTOK_ARRAY_SECRET');
      assert.ok(!JSON.stringify(readRunRecord(tRoot, rec.runId).log).includes('RTOK_ARRAY_SECRET'), 'container stop logs exclude command arguments');
    }
    // 形态二：整行命令（shell 形态，secret 在命令串内）
    const wholeLine = `"${process.execPath}" -e "${park('RTOK_LINE_SECRET')}"`;
    writeWorkflow('tok2', 'description: 脱敏2', `export default async (wf) => await wf.run(${JSON.stringify(wholeLine)});\n`, tRoot);
    {
      const st = newState();
      const rt = makeRuntime(st, tRoot);
      const rec = await rt.startRun(WS, 'tok2', {});
      await delay(500);
      await rt.cancel(WS, rec.runId, '测');
      await until(() => (readRunRecord(tRoot, rec.runId)?.log ?? []).some((l) => /停止本 run 的外部命令/.test(l.text)), '回退已发生2');
      assertSanitized(tRoot, rec.runId, 'RTOK_LINE_SECRET');
    }
  } finally {
    if (prevBin === undefined) delete process.env.MUSTER_TASKKILL_BIN;
    else process.env.MUSTER_TASKKILL_BIN = prevBin;
    for (let i = 0; i < 20; i++) {
      try {
        fs.rmSync(tRoot, { recursive: true, force: true });
        break;
      } catch {
        await delay(150);
      }
    }
  }
  console.log('ok: r2-P2 container shutdown logs exclude secrets in array and whole-line commands');
}

// ---------- P3-F02：wf.call 崩溃窗口的幽灵子任务自愈 ----------
{
  // 场景（docs/audits/reliability/dynamic-workflow.md F-02）：wf.call 在 startRun 落盘后、
  // memo 写盘前崩溃——重启时父活跃但 memo 无该子，父续跑会另起新子 run；旧 running 子
  // 记录无人接手。resumeAll 必须把它标 interrupted 自愈，否则面板永久「运行中」。
  writeWorkflow('gkid', 'description: 幽灵子', `export default async (wf) => { await wf.ask('子等'); };\n`);
  writeWorkflow('gdad', 'description: 幽灵父', `export default async (wf) => { await wf.call('gkid', {}); };\n`);
  const st = newState();
  const rt = makeRuntime(st);
  const dad = await rt.startRun(WS, 'gdad', {});
  await until(() => listRunRecords(wsRoot).some((r) => r.name === 'gkid'), '子 run 起来');
  const ghostKid = listRunRecords(wsRoot).find((r) => r.name === 'gkid');
  await rt.shutdown();
  // 模拟崩溃窗口：shutdown 落盘后，从父记录里抹掉 call 记账（等价于 memo 写盘前崩溃）
  const dadRec = readRunRecord(wsRoot, dad.runId);
  for (const [k, v] of Object.entries(dadRec.memo ?? {})) {
    if (v && typeof v === 'object' && '__child' in v) delete dadRec.memo[k];
  }
  writeRunRecord(wsRoot, dadRec);
  const st2 = newState();
  const rt2 = makeRuntime(st2);
  rt2.resumeAll();
  await until(
    () => readRunRecord(wsRoot, ghostKid.runId)?.status === 'interrupted',
    '父活跃但 memo 无该子 → 幽灵记录自愈为 interrupted'
  );
  assert.match(readRunRecord(wsRoot, ghostKid.runId).error, /记账缺失|未接上/);
  // 父续跑确实另起了新子（新 runId），不复用幽灵记录
  await until(
    () => listRunRecords(wsRoot).some((r) => r.name === 'gkid' && r.runId !== ghostKid.runId),
    '父续跑另起新子 run'
  );
  await rt2.shutdown();
  console.log('ok: P3-F02 幽灵子任务自愈（父活跃但 memo 无该子 → interrupted）');
}

fs.rmSync(wsRoot, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('workflow-runtime: all ok');
