/**
 * 轻量动态工作流（dynamic-workflow W1）纯逻辑 + 事件泵接线：
 * - WORKFLOW.md 解析（名字/目录一致、description 必填、args 可选标记、上限钳位）与启动参数校验
 * - 自动记账键：同内容不同键序同键、同步骤第 n 次出现序号递增
 * - 上限：存活时长扣除等人时间；派活次数与时长超限原因
 * - waitFor：条件解析（kind 必填、拼错字段拒绝）、sessionId 匹配、会话相位快照判定
 * - 问人：问题卡映射与作答回写形状（单选/多选/自定义）
 * - 输入框命令解析与展开；简易 glob
 * - 订阅策略：workflow 默认（待答/失败/中断属底线、完成唤醒、启动/阶段捎带）；sessionId 可写进规则
 * - 事件泵旁听点：策略判定之前（被 mute 的事件也看得到）、会话相位原始流转带 sessionId
 * 运行: node test/workflow.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-pure-'));
const compile = createSharedCompiler(root, tmp);

const wf = await import(pathToFileURL(compile('shared/workflow.ts')).href);
const cmd = await import(pathToFileURL(compile('shared/workflowCommand.ts')).href);
const { decidePolicyAction, parseSubscriptionPolicy } = await import(pathToFileURL(compile('shared/subscriptionPolicy.ts')).href);
const { OrchestratorEventPump } = await import(pathToFileURL(compile('main/orchestrator/events.ts')).href);

// ---------- 1) WORKFLOW.md 解析 ----------
{
  const ok = wf.parseWorkflowDoc(
    '---\nname: review-then-merge\ndescription: "派活后互审"\nargs: task, reviewer?\nmaxDelegates: 4\nmaxHours: 12\n---\n\n正文说明\n',
    'review-then-merge'
  );
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.def.description, '派活后互审', '引号剥掉');
  assert.deepEqual(ok.def.args, [
    { name: 'task', optional: false },
    { name: 'reviewer', optional: true }
  ]);
  assert.equal(ok.def.maxDelegates, 4);
  assert.equal(ok.def.maxHours, 12);
  assert.equal(ok.def.body, '正文说明');

  const dflt = wf.parseWorkflowDoc('---\ndescription: x\n---\n', 'demo');
  assert.equal(dflt.def.name, 'demo', '缺 name 取目录名');
  assert.equal(dflt.def.maxDelegates, wf.WORKFLOW_LIMITS.defaultMaxDelegates);
  assert.equal(dflt.def.maxHours, wf.WORKFLOW_LIMITS.defaultMaxHours);

  const clamp = wf.parseWorkflowDoc('---\ndescription: x\nmaxDelegates: 999\nmaxHours: -1\n---\n', 'demo');
  assert.equal(clamp.def.maxDelegates, wf.WORKFLOW_LIMITS.ceilingMaxDelegates, '超天花板钳位');
  assert.equal(clamp.def.maxHours, wf.WORKFLOW_LIMITS.defaultMaxHours, '非正数回默认');
  assert.equal(clamp.warnings.length, 2);

  assert.match(wf.parseWorkflowDoc('---\nname: other\ndescription: x\n---\n', 'demo').errors[0], /目录名/);
  assert.match(wf.parseWorkflowDoc('---\nname: demo\n---\n', 'demo').errors[0], /description/);
  assert.match(wf.parseWorkflowDoc('无 frontmatter', 'demo').errors[0], /frontmatter/);
  assert.match(wf.parseWorkflowDoc('---\ndescription: x\n---\n', 'Bad_Name').errors[0], /小写/);

  assert.deepEqual(wf.validateWorkflowArgs(ok.def, { task: 'x' }), []);
  assert.deepEqual(wf.validateWorkflowArgs(ok.def, { task: '  ' }), ['缺少必填参数 task']);
  console.log('ok: WORKFLOW.md 解析与参数校验');
}

// ---------- 2) 自动记账键 ----------
{
  assert.equal(wf.stableStringify({ b: 1, a: [2, { d: 1, c: 0 }] }), wf.stableStringify({ a: [2, { c: 0, d: 1 }], b: 1 }));
  const c1 = new wf.WorkflowMemoCounter();
  const k1 = c1.next('delegate', { task: 'x', name: 'a' });
  const k2 = c1.next('delegate', { name: 'a', task: 'x' });
  const k3 = c1.next('ask', { question: 'q' });
  assert.notEqual(k1, k2, '同内容第二次出现序号不同');
  assert.ok(k1.endsWith('#1') && k2.endsWith('#2') && k3.endsWith('#1'));
  const c2 = new wf.WorkflowMemoCounter();
  assert.equal(c2.next('delegate', { task: 'x', name: 'a' }), k1, '重跑时同顺序命中同一键');
  console.log('ok: 自动记账键稳定且按出现次序编号');
}

// ---------- 3) 上限 ----------
{
  const rec = {
    startedAt: 0,
    humanWaitMs: 2 * 3_600_000,
    humanWaitSince: 10 * 3_600_000,
    delegates: 3,
    maxDelegates: 3,
    maxHours: 9
  };
  assert.equal(wf.workflowActiveMs(rec, 11 * 3_600_000), 8 * 3_600_000, '扣除已结清与正在等人的时间');
  assert.equal(wf.workflowBudgetError(rec, 11 * 3_600_000), null);
  assert.match(wf.workflowBudgetError(rec, 11 * 3_600_000, { addingDelegate: true }), /派活次数/);
  delete rec.humanWaitSince;
  assert.match(wf.workflowBudgetError(rec, 12 * 3_600_000), /运行时长/);
  console.log('ok: 上限判定（等人不计时）');
}

// ---------- 4) waitFor 条件 ----------
{
  const { match } = wf.parseWaitMatch({kind:'phase',sessionId:'s1',trigger:['needs_you','error']});
  assert.ok(wf.matchWaitEvent(match,{kind:'phase',sessionId:'s1',trigger:'error'}));
  assert.ok(!wf.matchWaitEvent(match,{kind:'phase',sessionId:'s2',trigger:'error'}));
  assert.ok(wf.phaseSnapshotSatisfies(match,{id:'s1',phase:'needs_you'}));
  assert.ok(!wf.phaseSnapshotSatisfies(match,{id:'s1',phase:'working'}));
  assert.equal(wf.waitMatchSessionId(match),'s1');
  assert.ok(!wf.phaseSnapshotSatisfies(wf.parseWaitMatch({kind:'phase',sessionId:'s1'}).match,{id:'s1',phase:'done'}));
  assert.match(wf.parseWaitMatch({sessionId:'s1'}).errors[0],/kind/);
  assert.match(wf.parseWaitMatch({kind:'phase',sessoinId:'s1'}).errors[0],/未知字段/);
  assert.ok(wf.parseWaitMatch({kind:'task_flip',taskId:'t1'}).errors.length,'旧共享任务条件明确拒绝');
  console.log('ok: waitFor 会话相位、身份过滤与现状快照');
}

// ---------- 5) 问人 ----------
{
  const ask = { askId: 'a1', key: 'k', to: 'human', question: '合入吗？', options: ['合入', '打回'], since: 0 };
  const mapped = wf.buildHumanAskMapped('demo', ask);
  assert.equal(mapped.questions[0].id, 'answer');
  assert.deepEqual(mapped.questions[0].options, [{ label: '合入' }, { label: '打回' }]);
  assert.deepEqual(wf.humanAnswerFromOutcome({ kind: 'answered', answers: [{ id: 'answer', selected: ['合入'] }] }, ask), { ok: true, answer: '合入' });
  assert.deepEqual(wf.humanAnswerFromOutcome({ kind: 'answered', answers: [{ id: 'answer', selected: [], custom: '先等等' }] }, ask), { ok: true, answer: '先等等' });
  assert.deepEqual(
    wf.humanAnswerFromOutcome({ kind: 'answered', answers: [{ id: 'answer', selected: ['a'], custom: 'b' }] }, { ...ask, multi: true }),
    { ok: true, answer: ['a', 'b'] }
  );
  assert.deepEqual(wf.humanAnswerFromOutcome({ kind: 'aborted' }, ask), { ok: false });
  assert.equal(wf.workflowRunCommandLog('npm run test:full -- --full', []), '命令：npm（4 段参数不落日志）');
  assert.equal(wf.workflowRunCommandLog('curl', ['-H', 'Authorization: Bearer sk-x']), '命令：curl（2 段参数不落日志）');
  assert.equal(wf.workflowRunCommandLog('  node  ', []), '命令：node');
  // 回归：multi 空选原先返回 {ok:true, answer:[]}，脚本当成「用户选了空集合」继续跑
  assert.deepEqual(
    wf.humanAnswerFromOutcome({ kind: 'answered', answers: [{ id: 'answer', selected: [], custom: '  ' }] }, { ...ask, multi: true }),
    { ok: false }
  );
  assert.deepEqual(wf.humanAnswerFromOutcome({ kind: 'answered', answers: [{ id: 'answer', selected: [] }] }, ask), { ok: false });
  console.log('ok: 问题卡映射与作答回写');
}

// ---------- 6) 命令与 glob ----------
{
  assert.deepEqual(cmd.parseWorkflowCommand('/workflow-new 竞品调研后找优化点'), { kind: 'new', description: '竞品调研后找优化点' });
  assert.deepEqual(cmd.parseWorkflowCommand('/新建工作流'), { kind: 'new', description: '' });
  assert.deepEqual(cmd.parseWorkflowCommand('/workflow review-then-merge 修复登录超时'), { kind: 'run', name: 'review-then-merge', args: '修复登录超时' });
  assert.deepEqual(cmd.parseWorkflowCommand('/工作流 demo'), { kind: 'run', name: 'demo', args: '' });
  assert.equal(cmd.parseWorkflowCommand('/workflows'), null, '前缀相近的其它命令不误判');
  assert.equal(cmd.parseWorkflowCommand('帮我 /workflow demo'), null, '只认行首命令');
  const create = cmd.expandWorkflowCommand({ kind: 'new', description: 'x' });
  assert.match(create, /~\/\.muster\/skills\/workflow\/SKILL\.md/);
  assert.doesNotMatch(create, /\.muster\/workflows\/README\.md/);
  assert.match(create, /WORKFLOW\.md.*run\.mjs.*host\.workflow\.run.*validate/);
  const skill = fs.readFileSync(path.join(root, 'resources/skills/workflow/SKILL.md'), 'utf8');
  const [, definition] = /### WORKFLOW\.md\s+```markdown\r?\n([\s\S]*?)```/.exec(skill);
  assert.deepEqual(wf.parseWorkflowDoc(definition, 'review-then-merge').errors, []);
  const [, trigger] = /#### 触发[^\n]*\s+```yaml\r?\n([\s\S]*?)```/.exec(skill);
  const triggered = wf.parseWorkflowDoc(`---\nname: demo\ndescription: fixture\n${trigger}---\n`, 'demo');
  assert.deepEqual(triggered.warnings, []);
  assert.ok(triggered.def.schedule && triggered.def.on);
  assert.equal(triggered.def.cooldownMin, 30);
  const [, script] = /### run\.mjs\s+```js\r?\n([\s\S]*?)```/.exec(skill);
  assert.equal(typeof (await import(`data:text/javascript,${encodeURIComponent(script)}`)).default, 'function');
  assert.match(cmd.expandWorkflowCommand({ kind: 'run', name: 'demo', args: 'a' }), /host\.workflow\.run.*list.*start/);
  assert.match(cmd.expandWorkflowCommand({ kind: 'run', name: '', args: '' }), /host\.workflow\.run.*list/);

  const re = wf.globToRegExp('docs/**/*.md');
  assert.ok(re.test('docs/a.md') && re.test('docs/x/y/b.md') && !re.test('docs/a.txt') && !re.test('src/docs/a.md'));
  assert.ok(wf.globToRegExp('src/*.{ts,tsx}').test('src/a.tsx'));
  assert.ok(!wf.globToRegExp('src/*.ts').test('src/x/a.ts'), '* 不跨目录');
  console.log('ok: 输入框命令解析/展开 + glob');
}

// ---------- 7) 订阅策略：workflow 默认与底线 ----------
{
  assert.equal(decidePolicyAction({ kind: 'workflow', trigger: 'started' }).action, 'digest');
  assert.equal(decidePolicyAction({ kind: 'workflow', trigger: 'phase' }).action, 'digest');
  assert.equal(decidePolicyAction({ kind: 'workflow', trigger: 'completed' }).action, 'wake');
  const { policy } = parseSubscriptionPolicy({ rules: [{ id: 'hush-wf', match: { kind: 'workflow' }, action: 'mute' }] });
  for (const trigger of ['ask', 'failed', 'interrupted']) {
    assert.deepEqual(decidePolicyAction({ kind: 'workflow', trigger }, policy), { action: 'wake', ruleId: 'hush-wf', floorOverride: true }, `${trigger} 属底线`);
  }
  assert.equal(decidePolicyAction({ kind: 'workflow', trigger: 'ask_human' }).action, 'digest', '问用户走面板，调度只捎带');
  assert.equal(decidePolicyAction({ kind: 'workflow', trigger: 'trigger_blocked' }).action, 'wake', '触发被拦唤醒调度');
  assert.equal(decidePolicyAction({ kind: 'workflow', trigger: 'ask_human' }, policy).action, 'mute', '问用户不属底线');
  assert.equal(decidePolicyAction({ kind: 'workflow', trigger: 'completed' }, policy).action, 'mute', '完成可由用户静音');
  const bySession = parseSubscriptionPolicy({rules:[{id:'s',match:{kind:'phase',sessionId:'s9'},action:'wake'}]});
  assert.deepEqual(bySession.warnings,[]);
  assert.equal(decidePolicyAction({kind:'phase',sessionId:'s9',trigger:'done'},bySession.policy).action,'wake');
  console.log('ok: workflow 事件默认判定与底线');
}

// ---------- 8) 事件泵旁听点 ----------
{
  const workspaces = [{ id: 'w1', path: '/repo' }];
  const sessions = new Map([['s1', { id: 's1', name: 'W', workspaceId: 'w1', orchestrated: true, launchKind: 'agent' }]]);
  const ctx = {
    config: { get: () => ({ workspaces }) },
    workspaces: { list: () => workspaces },
    sessions: { get: (id) => sessions.get(id), list: () => [...sessions.values()], listByWorkspace: () => [...sessions.values()] },
    orchestrator: { isBusy: () => false, send: async () => {} },
    agentSessions: { isBusy: () => false }
  };
  const pump = new OrchestratorEventPump({
    ctx,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {}
  });
  const seen = [];
  const off = pump.addTap((ws, view) => seen.push({ ws, ...view }));
  pump.onTurnEnd('s1');
  assert.equal(pump.peek('w1').length, 0, 'turn_end 被内置规则静音');
  assert.equal(seen.at(-1).kind, 'turn_end', '旁听点在策略判定之前，看得到被静音的事件');
  pump.onFlip({sessionId:'s1',workspaceId:'w1',sessionName:'W',trigger:'needs_you',ts:1000});
  assert.deepEqual({kind:seen.at(-1).kind,sessionId:seen.at(-1).sessionId,trigger:seen.at(-1).trigger},
    {kind:'phase',sessionId:'s1',trigger:'needs_you'},'会话相位可供工作流等待');
  pump.enqueueWorkflow('w1', { runId: 'r1', trigger: 'phase', detail: 'demo 进入阶段' });
  assert.equal(pump.peekDigest('w1').at(-1).kind, 'workflow', '阶段只捎带');
  pump.enqueueWorkflow('w1', { runId: 'r1', trigger: 'ask', detail: 'demo 问你' });
  assert.ok(pump.peek('w1').some((e) => e.kind === 'workflow'), '待答唤醒');
  off();
  const n = seen.length;
  pump.onTurnEnd('s1');
  assert.equal(seen.length, n, '退订后不再旁听');
  console.log('ok: 事件泵旁听点 + workflow 事件入口');
}

// ---------- 9) 触发声明 + W2–W4 纯函数 ----------
{
  assert.deepEqual(wf.parseWorkflowSchedule('daily 2:00'), { schedule: { kind: 'daily', time: '02:00' } });
  assert.deepEqual(wf.parseWorkflowSchedule('weekly 5,1,1 09:30'), { schedule: { kind: 'weekly', time: '09:30', weekdays: [1, 5] } });
  assert.deepEqual(wf.parseWorkflowSchedule('every 2h'), { schedule: { kind: 'interval', intervalMinutes: 120 } });
  assert.match(wf.parseWorkflowSchedule('every 3m').error, /至少 5 分钟/);
  assert.match(wf.parseWorkflowSchedule('weekly 7 09:00').error, /0–6/);
  assert.match(wf.parseWorkflowSchedule('hourly').error, /无法识别/);
  assert.equal(wf.describeWorkflowSchedule({ kind: 'interval', intervalMinutes: 30 }), '每 30 分钟');

  assert.deepEqual(wf.parseWorkflowOn('{"kind":"phase","trigger":"error"}').match, {kind:'phase',trigger:'error'});
  assert.match(wf.parseWorkflowOn('{"kind":"workflow"}').error, /连锁/);
  assert.match(wf.parseWorkflowOn('kind: phase').error, /JSON/);

  const trig = wf.parseWorkflowDoc('---\ndescription: x\nschedule: every 30m\ncooldown: 5\n---\n', 'demo');
  assert.deepEqual(trig.warnings, []);
  assert.deepEqual(trig.def.schedule, { kind: 'interval', intervalMinutes: 30 });
  assert.equal(trig.def.cooldownMin, 5);
  assert.equal(wf.parseWorkflowDoc('---\ndescription: x\n---\n', 'demo').def.cooldownMin, wf.WORKFLOW_LIMITS.defaultCooldownMin);
  const needArgs = wf.parseWorkflowDoc('---\ndescription: x\nargs: task\nschedule: daily 02:00\n---\n', 'demo');
  assert.equal(needArgs.def.schedule, undefined, '有必填参数时定时不生效');
  assert.match(needArgs.warnings[0], /必填参数 task/);
  const evArgs = wf.parseWorkflowDoc('---\ndescription: x\nargs: event, note?\non: {"kind":"fact"}\n---\n', 'demo');
  assert.deepEqual(evArgs.def.on, { kind: 'fact' }, '必填只有 event 时事件触发生效');
  const badOn = wf.parseWorkflowDoc('---\ndescription: x\nargs: task\non: {"kind":"fact"}\n---\n', 'demo');
  assert.equal(badOn.def.on, undefined);
  assert.match(badOn.warnings[0], /on 未生效/);

  const pm = wf.parseWaitMatch({ kind: 'phase', sessionId: 's1', trigger: ['needs_you', 'done'] }).match;
  assert.equal(wf.waitMatchSessionId(pm), 's1');
  assert.ok(wf.phaseSnapshotSatisfies(pm, { id: 's1', phase: 'done' }));
  assert.ok(!wf.phaseSnapshotSatisfies(pm, { id: 's1', phase: 'running' }));
  assert.ok(!wf.phaseSnapshotSatisfies(pm, { id: 's2', phase: 'done' }), '会话不符不快照');
  assert.ok(!wf.phaseSnapshotSatisfies(wf.parseWaitMatch({ kind: 'phase', sessionId: 's1' }).match, { id: 's1', phase: 'done' }), '没写 trigger 不快照');

  const id1 = wf.workflowDelegateTaskId('run-a', 'delegate:x#1');
  assert.equal(id1, wf.workflowDelegateTaskId('run-a', 'delegate:x#1'), '同 run 同步骤 id 稳定');
  assert.notEqual(id1, wf.workflowDelegateTaskId('run-b', 'delegate:x#1'));
  assert.notEqual(id1, wf.workflowDelegateTaskId('run-a', 'delegate:x#2'));
  assert.match(id1, /^wf-[0-9a-z]+$/);

  const day = 86400_000;
  const now = 100 * day;
  const run = (runId, status, endedAt, parentRunId) => ({ runId, status, updatedAt: endedAt, endedAt, ...(parentRunId ? { parentRunId } : {}) });
  const recs = [
    run('new', 'completed', now - day),
    run('mid', 'failed', now - 2 * day),
    run('old', 'completed', now - 40 * day),
    run('live', 'running', now - 90 * day),
    run('kid-of-mid', 'completed', now - 2 * day, 'mid'),
    run('kid-of-live', 'completed', now - 90 * day, 'live'),
    run('kid-of-old', 'completed', now - 40 * day, 'old')
  ];
  assert.deepEqual(wf.selectWorkflowRunsToPrune(recs, now).sort(), ['kid-of-old', 'old'], '超期删除，子 run 跟随父');
  assert.deepEqual(wf.selectWorkflowRunsToPrune(recs, now, { keep: 1 }).sort(), ['kid-of-mid', 'kid-of-old', 'mid', 'old'], '超条数删除；活跃父下的子 run 保留');

  assert.deepEqual(
    wf.parseWorkflowTriggerState('{"demo":{"anchorAt":1,"lastSkip":{"at":2,"reason":"r"},"junk":true,"disabled":true},"off":{"disabled":"yes"},"Bad Name":{},"x":3}'),
    { demo: { anchorAt: 1, lastSkip: { at: 2, reason: 'r' }, disabled: true }, off: {} }
  );
  assert.deepEqual(wf.parseWorkflowTriggerState('not json'), {});
  console.log('ok: 触发声明解析 + 相位快照 + 确定性任务 id + 保留策略 + 触发状态');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('workflow: all ok');
