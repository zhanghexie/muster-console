/**
 * PromptTasksManager.update：runtime 未变时不校验 enabled
 * 运行: node test/prompt-tasks-manager.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptm-'));
const compile = createSharedCompiler(root, tmp);
const managerOut = compile('main/tasks/manager.ts');
const { PromptTasksManager } = await import(pathToFileURL(managerOut).href);
const { WORKER_DELEGATION_CONTRACT } = await import(pathToFileURL(compile('shared/workerBrief.ts')).href);
const usageStatsOut = compile('shared/usageStats.ts');
const { usageDayKey } = await import(pathToFileURL(usageStatsOut).href);

const tasks = [];
const taskRuns = [];
const store = {
  loadPromptTasks: () => tasks.map((t) => ({ ...t, schedule: { ...t.schedule } })),
  savePromptTasks: (next) => {
    tasks.length = 0;
    tasks.push(...next.map((t) => ({ ...t, schedule: { ...t.schedule } })));
  },
  loadTaskRuns: () => taskRuns.map((r) => ({ ...r })),
  saveTaskRuns: (next) => {
    taskRuns.length = 0;
    taskRuns.push(...next.map((r) => ({ ...r })));
  },
};
const config = {
  get: () => ({ activeWorkspaceId: 'default', workspaces: [{ id: 'default', path: tmp }] })
};
const sessions = {
  list: () => [],
  createScheduledTaskSession: () => {},
  updateScheduledTaskSession: () => {},
  removeScheduledSession: () => {},
  touchScheduledSession: () => {},
  isChatRuntime: () => false,
  createTerminal: async () => ({ id: 'sess-test' })
};
const runtimes = {
  entries: {
    'claude-code': { id: 'claude-code', enabled: false },
    'cursor-cli': { id: 'cursor-cli', enabled: true },
    broken: { id: 'broken', enabled: false }
  },
  get(id) {
    return this.entries[id];
  }
};
const notifyPushes = [];
const notifyStub = { push: (input) => notifyPushes.push(input) };

const mgr = new PromptTasksManager(store, config, sessions, runtimes, notifyStub);
const created = mgr.create({
  name: 't1',
  runtime: 'cursor-cli',
  prompt: 'hello',
  schedule: { kind: 'daily', time: '09:00' },
  mode: 'terminal',
  modelParameters: { reasoning: 'budget-3' }
});
assert.deepEqual(created.modelParameters, { reasoning: 'budget-3' });
mgr.update(created.id, { modelParameters: { strategy: 'six' } });
assert.deepEqual(tasks[0].modelParameters, { strategy: 'six' });
assert.throws(() => mgr.update(created.id, { name: 'must not persist', modelParameters: { strategy: 6 } }), /INVALID_MODEL_PARAMETERS/);
assert.equal(created.name, 't1');
assert.deepEqual(created.modelParameters, { strategy: 'six' });
mgr.update(created.id, { modelParameters: {} });
assert.deepEqual(created.modelParameters, {}, 'explicit follow-default survives persistence');
created.runtime = 'claude-code';
tasks[0] = created;

const updated = mgr.update(created.id, {
  prompt: 'updated prompt',
  runtime: 'claude-code',
  schedule: { kind: 'daily', time: '10:00' }
});
assert.equal(updated.prompt, 'updated prompt');
assert.equal(updated.runtime, 'claude-code');
assert.equal(updated.schedule.time, '10:00');
console.log('ok: update unchanged disabled runtime skips assert');

assert.throws(
  () =>
    mgr.update(created.id, {
      runtime: 'broken',
      prompt: 'switch to disabled'
    }),
  /runtime 未注册或已禁用/
);
console.log('ok: update to different disabled runtime still rejected');

// ---------- create 默认停用 / enabled 显式生效 ----------
const t2 = mgr.create({
  name: 't2',
  runtime: 'cursor-cli',
  prompt: 'p',
  schedule: { kind: 'daily', time: '09:00' }
});
assert.equal(t2.enabled, false);
assert.equal(t2.mode, 'terminal', '新建默认 terminal');
assert.equal(t2.nextRunAt, undefined);
const t3 = mgr.create({
  name: 't3',
  runtime: 'cursor-cli',
  prompt: 'p',
  schedule: { kind: 'daily', time: '09:00' },
  enabled: true,
  mode: 'terminal'
});
assert.equal(t3.enabled, true);
assert.ok(t3.nextRunAt && t3.nextRunAt > Date.now());
assert.ok(mgr.timers.has(t3.id));
console.log('ok: create 默认停用，enabled:true 建立即排');

// ---------- update 非法 schedule：抛错且内存/落盘都不残留坏值 ----------
assert.throws(() => mgr.update(t3.id, { schedule: { kind: 'daily', time: '9:00' } }), /时间格式应为 HH:mm/);
assert.equal(t3.schedule.time, '09:00');
assert.equal(tasks.find((x) => x.id === t3.id).schedule.time, '09:00');
assert.ok(mgr.timers.has(t3.id), 'update 抛错后任务仍保持 armed');
console.log('ok: update 非法 schedule 不污染内存/存储');

// ---------- runNow 成败都重挂定时器 ----------
await mgr.runNow(t3.id);
assert.equal(t3.lastResult, 'ok');
assert.ok(mgr.timers.has(t3.id));
const originalCreateTerminal = sessions.createTerminal;
sessions.createTerminal = async () => {
  throw new Error('boom');
};
await assert.rejects(() => mgr.runNow(t3.id), /boom/);
assert.equal(t3.lastResult, 'error');
assert.ok(t3.lastError.includes('boom'));
assert.ok(mgr.timers.has(t3.id), 'runNow 失败后也重挂');
sessions.createTerminal = originalCreateTerminal;
mgr.disable(t3.id);
console.log('ok: runNow 成败均重挂并更新 lastResult');

// ---------- 运行记录：成功/失败各一条，携带 sessionId ----------
const t3Runs = mgr.listRuns(t3.id);
assert.equal(t3Runs.length, 2);
assert.equal(t3Runs[0].status, 'error', '最新在前');
assert.equal(t3Runs[0].mode, 'terminal');
assert.ok(t3Runs[0].error.includes('boom'));
assert.equal(t3Runs[1].status, 'ok');
assert.equal(t3Runs[1].sessionId, 'sess-test');
assert.ok(t3Runs[1].durationMs >= 0);
assert.ok(notifyPushes.some((n) => n.kind === 'error' && n.text.includes('boom')), '失败推工作区通知');
console.log('ok: runNow 落运行记录并推失败通知');

// ---------- 错过的计划时间记 missed ----------
t3.enabled = true;
t3.lastRunAt = undefined;
t3.nextRunAt = Date.now() - 60_000;
mgr.arm(t3); // private 在转译后可直接调用
const missed = mgr.listRuns(t3.id).filter((r) => r.status === 'missed');
assert.equal(missed.length, 1);
assert.equal(missed[0].mode, 'missed');
assert.ok(missed[0].startedAt <= Date.now() - 60_000);
assert.ok(notifyPushes.some((n) => n.label === '错过运行'));
// 下次 arm 不再重复记 missed
mgr.arm(t3);
assert.equal(mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length, 1);
mgr.disable(t3.id);
console.log('ok: 错过计划时间记 missed 且不重复');

// ---------- 定时器早触发（时钟偏差）：刚执行过的槽位不得误判为 missed ----------
// 真实场景：setTimeout 比 Date.now() 早几毫秒触发，run() 把 lastRunAt 落在槽位前，
// arm() 若按 lastRunAt < missedAt 判定就会给刚跑完的一轮记假 missed
t3.enabled = true;
const firedSlotAt = Date.now() - 2; // 刚过去的计划槽位
t3.lastRunAt = firedSlotAt - 2; // 那轮运行因早触发落在了槽位前 2ms
t3.nextRunAt = firedSlotAt;
const missedBefore = mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length;
mgr.arm(t3);
assert.equal(
  mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length,
  missedBefore,
  'lastRunAt 落在容差内不记 missed'
);
assert.ok(t3.nextRunAt > Date.now(), 'nextRunAt 仍被推到下一次');
mgr.disable(t3.id);
console.log('ok: 早触发的槽位不误判为 missed');

// ---------- 容差外的 lastRunAt 仍记 missed（真实错过不漏报） ----------
t3.enabled = true;
t3.lastRunAt = Date.now() - 70_000; // 上次运行远早于该槽位（超出 5s 容差）
t3.nextRunAt = Date.now() - 60_000;
mgr.arm(t3);
assert.equal(mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length, missedBefore + 1);
mgr.disable(t3.id);
console.log('ok: 容差外的旧 lastRunAt 仍记 missed');

// ---------- 该任务无头运行进行中时不记 missed（排队待跑不算错过） ----------
t3.mode = 'headless';
t3.enabled = true;
t3.lastRunAt = Date.now() - 70_000;
t3.nextRunAt = Date.now() - 60_000;
mgr.headlessInFlight.add(t3.id);
mgr.arm(t3);
assert.equal(
  mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length,
  missedBefore + 1,
  '无头在途不记 missed'
);
mgr.headlessInFlight.delete(t3.id);
mgr.disable(t3.id);
console.log('ok: 无头运行在途不记 missed');

// ---------- run 后 nextRunAt 基准不早于当前时刻（源头修复） ----------
const ranAt = Date.now() - 5;
const nextAfterRun = mgr.nextRunAtFrom(t3, ranAt);
assert.ok(nextAfterRun > ranAt, '下一次严格晚于本轮开始');
assert.ok(nextAfterRun >= Date.now(), '下一次不指向过去（早触发时不得回指刚触发的槽位）');
console.log('ok: nextRunAtFrom 基准取 max(startedAt, now)');

// ---------- T3.4 confirm：记 missed + pending，不执行 ----------
t3.mode = 'terminal';
t3.missedPolicy = 'confirm';
t3.enabled = true;
t3.lastRunAt = Date.now() - 70_000;
t3.nextRunAt = Date.now() - 60_000;
t3.missedPendingConfirm = undefined;
let catchUpRuns = 0;
const origTerm = sessions.createTerminal;
sessions.createTerminal = async () => {
  catchUpRuns += 1;
  return { id: 'sess-catch' };
};
mgr.arm(t3);
assert.equal(t3.missedPendingConfirm, true);
assert.ok(
  mgr.listRuns(t3.id).some((r) => r.status === 'missed' && String(r.error).includes('等待确认补跑'))
);
assert.equal(catchUpRuns, 0, 'confirm 不自动执行');
mgr.disable(t3.id);
console.log('ok: confirm 策略记 pending 不补跑');

// ---------- T3.4 catch-up：补跑一次且不记 missed ----------
t3.missedPolicy = 'catch-up';
t3.enabled = true;
t3.lastRunAt = Date.now() - 70_000;
t3.nextRunAt = Date.now() - 60_000;
const missedCountBeforeCatch = mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length;
mgr.arm(t3);
await new Promise((r) => setTimeout(r, 40));
assert.equal(catchUpRuns, 1, 'catch-up 立即执行');
assert.equal(
  mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length,
  missedCountBeforeCatch,
  '补跑不记 missed'
);
sessions.createTerminal = origTerm;
mgr.disable(t3.id);
t3.missedPolicy = 'skip';
console.log('ok: catch-up 补跑且不记 missed');

// ---------- T3.4 唤醒重评 + keep-awake blocker ----------
const power = {
  started: 0,
  stopped: 0,
  resume: null,
  startPreventAppSuspension() {
    this.started += 1;
    return 7;
  },
  stop() {
    this.stopped += 1;
  },
  onResume(cb) {
    this.resume = cb;
    return () => {
      this.resume = null;
    };
  }
};
mgr.bindPower(power);
t3.enabled = true;
t3.missedPolicy = 'skip';
t3.lastRunAt = Date.now() - 70_000;
t3.nextRunAt = Date.now() - 60_000;
const missedBeforeWake = mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length;
power.resume();
assert.equal(mgr.listRuns(t3.id).filter((r) => r.status === 'missed').length, missedBeforeWake + 1);
t3.nextRunAt = Date.now() + 60_000;
mgr.arm(t3);
assert.ok(power.started >= 1, '临近触发申 blocker');
mgr.disable(t3.id);
mgr.syncKeepAwake();
mgr.stop();
assert.ok(power.stopped >= 1);
mgr.start();
console.log('ok: 唤醒重评错过 + keep-awake 生命周期');

// ---------- 运行记录裁剪：每任务上限 50 ----------
for (let i = 0; i < 55; i++) {
  mgr.recordRun({ id: `prune-${i}`, taskId: t2.id, mode: 'missed', status: 'missed', startedAt: 1000 + i });
}
const t2Runs = mgr.listRuns(t2.id);
assert.equal(t2Runs.length, 50);
assert.ok(t2Runs.some((r) => r.id === 'prune-54'), '保留最新');
assert.ok(!t2Runs.some((r) => r.id === 'prune-0'), '裁掉最旧');
console.log('ok: 运行记录按任务裁剪到 50 条');

// ---------- headless 已退役：新建默认 terminal、显式传入拒绝、启动 purge ----------
assert.throws(
  () =>
    mgr.create({
      name: 'no-hl',
      runtime: 'cursor-cli',
      prompt: 'p',
      schedule: { kind: 'daily', time: '09:00' },
      mode: 'headless'
    }),
  /不再支持无头/
);
assert.throws(() => mgr.update(t2.id, { mode: 'headless' }), /不再支持无头/);
console.log('ok: create/update 拒绝 headless');

{
  const seed = [
    {
      id: 'keep-term',
      name: '保留终端',
      workspaceId: 'default',
      runtime: 'cursor-cli',
      prompt: 'keep me',
      schedule: { kind: 'daily', time: '09:00' },
      mode: 'terminal',
      enabled: false,
      createdAt: 1
    },
    {
      id: 'drop-hl',
      name: '夜间巡检',
      workspaceId: 'default',
      runtime: 'cursor-cli',
      prompt: '请汇总今日看板并给调度写一封简报，列出需要你的会话',
      schedule: { kind: 'daily', time: '22:00' },
      mode: 'headless',
      enabled: true,
      createdAt: 2
    }
  ];
  const removed = [];
  const seedStore = {
    loadPromptTasks: () => seed.map((t) => ({ ...t, schedule: { ...t.schedule } })),
    savePromptTasks: (next) => {
      seed.length = 0;
      seed.push(...next.map((t) => ({ ...t, schedule: { ...t.schedule } })));
    },
    loadTaskRuns: () => [],
    saveTaskRuns: () => {},
  };
  const seedSessions = {
    list: () => [],
    createScheduledTaskSession: () => {},
    updateScheduledTaskSession: () => {},
    removeScheduledSession: (id) => removed.push(id),
    touchScheduledSession: () => {},
    isChatRuntime: () => false,
    createTerminal: async () => ({ id: 'sess' })
  };
  const seedMgr = new PromptTasksManager(seedStore, config, seedSessions, runtimes);
  const purged = seedMgr.listPurgedHeadless();
  assert.equal(purged.length, 1);
  assert.equal(purged[0].name, '夜间巡检');
  assert.match(purged[0].promptPreview, /请汇总今日看板/);
  assert.equal(seedMgr.list().length, 1);
  assert.equal(seedMgr.list()[0].id, 'keep-term');
  assert.deepEqual(removed, ['drop-hl']);
  seedMgr.stop();
  console.log('ok: 启动 purge 存量 headless 并保留 terminal');
}

const h1 = mgr.create({
  name: 'h1',
  runtime: 'cursor-cli',
  prompt: 'hp',
  schedule: { kind: 'daily', time: '09:00' },
  enabled: true
});
assert.equal(h1.mode, 'terminal');
mgr.disable(h1.id);
console.log('ok: 新建默认 terminal');

// ---------- GUI（chat surface）runtime：terminal 模式经宿主 send 注入任务 ----------
// 回归：createTerminal 对 chat runtime 忽略 initialPrompt，契约与完整任务必须经 AgentSessionHost.send
runtimes.entries['gui-test'] = { id: 'gui-test', enabled: true };
const guiSends = [];
mgr.bindGuiHost({
  send: async (sessionId, text, images, opts) => {
    guiSends.push({ sessionId, text, images, opts });
    return { ok: true };
  }
});
const prevIsChat = sessions.isChatRuntime;
sessions.isChatRuntime = (id) => id === 'gui-test' || id === 'pi';
const g1 = mgr.create({
  name: 'g1',
  runtime: 'gui-test',
  prompt: 'gui task body',
  schedule: { kind: 'daily', time: '09:00' },
  mode: 'terminal',
  enabled: true
});
await mgr.runNow(g1.id);
assert.equal(g1.lastResult, 'ok');
assert.equal(guiSends.length, 1, 'GUI runtime 任务经宿主 send 注入');
assert.equal(guiSends[0].sessionId, 'sess-test');
assert.equal(guiSends[0].text, `${WORKER_DELEGATION_CONTRACT}\n\ngui task body`);
assert.equal(guiSends[0].images, undefined);
assert.deepEqual(guiSends[0].opts, { fromInject: true });
assert.equal(mgr.listRuns(g1.id)[0].status, 'ok');
mgr.disable(g1.id);
console.log('ok: GUI runtime 任务经 AgentSessionHost.send 注入');

{
  const captured = [];
  const prevCreate = sessions.createTerminal;
  sessions.createTerminal = async (opts) => {
    captured.push(opts);
    return { id: 'sess-meta' };
  };
  mgr.bindGuiHost({ send: async () => ({ ok: true }) });
  runtimes.entries.pi = { id: 'pi', enabled: true };
  const gMeta = mgr.create({
    name: 'g-meta',
    runtime: 'pi',
    prompt: 'p',
    schedule: { kind: 'daily', time: '09:00' },
    configurePermissions: true,
    guiMode: 'auto',
    thinking: 'high',
    providerId: 'cursor',
    modelId: 'grok-4.6',
    enabled: true
  });
  await mgr.runNow(gMeta.id);
  assert.equal(captured[0].inheritMeta.guiMode, 'auto');
  assert.equal(captured[0].inheritMeta.configurePermissions, true);
  assert.equal(captured[0].inheritMeta.thinkingLevel, 'high');
  assert.deepEqual(captured[0].inheritMeta.modelOverride, {
    providerId: 'cursor',
    modelId: 'grok-4.6'
  });
  const nativeConfig = { identity: { runtimeId: 'gui-test', sourceKey: 'fixture-source' },
    selections: [{ id: 'mode', value: 'engine-build' }, { id: 'review', value: false }] };
  const external = mgr.create({ name: 'external', prompt: 'p', runtime: 'gui-test', schedule: { kind: 'daily', time: '09:00' }, configurePermissions: true, nativeConfig });
  await mgr.runNow(external.id);
  assert.deepEqual(captured[1].inheritMeta.nativeConfig, nativeConfig);
  assert.equal(captured[1].inheritMeta.guiMode, undefined);
  assert.equal(captured[1].inheritMeta.configurePermissions, true);
  const automatic = mgr.update(external.id, { configurePermissions: false });
  assert.equal(automatic.configurePermissions, false);
  assert.deepEqual(automatic.nativeConfig, nativeConfig);
  await mgr.runNow(external.id);
  assert.equal(captured[2].inheritMeta.configurePermissions, false);
  assert.equal(mgr.update(external.id, { nativeConfig: null }).nativeConfig, undefined);
  assert.throws(() => mgr.create({ name: 'legacy', prompt: 'p', runtime: 'gui-test', schedule: { kind: 'daily', time: '09:00' }, configurePermissions: true, guiMode: 'auto' }), /权限档/);
  runtimes.entries.codex = { id: 'codex', enabled: true };
  const cliOptions = { permission: 'on-request', mode: 'read-only', model: 'gpt-5' };
  const terminal = mgr.create({ name: 'configured-terminal', prompt: 'p', runtime: 'codex', schedule: { kind: 'daily', time: '09:00' },
    configurePermissions: true, cliLaunchOptions: cliOptions });
  await mgr.runNow(terminal.id);
  assert.deepEqual(captured[3].cliLaunchOptions, cliOptions);
  assert.equal(captured[3].inheritMeta.configurePermissions, true);
  const archived = { ...cliOptions, permission: 'old-permission' };
  assert.deepEqual(mgr.update(terminal.id, { configurePermissions: false, cliLaunchOptions: archived }).cliLaunchOptions, archived);
  await mgr.runNow(terminal.id);
  assert.deepEqual(captured[4].cliLaunchOptions, archived);
  assert.equal(captured[4].inheritMeta.configurePermissions, false);
  sessions.createTerminal = prevCreate;
  mgr.disable(gMeta.id);
  console.log('ok: terminal 拉起透传 inheritMeta（guiMode/模型/思考档）');
}

// GUI send 失败（ok:false）按本轮执行失败收尾：记错误 + 推通知
mgr.bindGuiHost({ send: async () => ({ ok: false, error: '排队已满' }) });
const g2 = mgr.create({
  name: 'g2',
  runtime: 'gui-test',
  prompt: 'p',
  schedule: { kind: 'daily', time: '09:00' },
  mode: 'terminal',
  enabled: true
});
await assert.rejects(() => mgr.runNow(g2.id), /排队已满/);
assert.equal(g2.lastResult, 'error');
assert.ok(g2.lastError.includes('排队已满'));
assert.ok(notifyPushes.some((n) => n.kind === 'error' && n.text.includes('排队已满')), 'GUI 注入失败推通知');
mgr.disable(g2.id);
// 宿主未绑定：明确报错而不是静默空会话
mgr.bindGuiHost(null);
const g3 = mgr.create({
  name: 'g3',
  runtime: 'gui-test',
  prompt: 'p',
  schedule: { kind: 'daily', time: '09:00' },
  mode: 'terminal',
  enabled: true
});
await assert.rejects(() => mgr.runNow(g3.id), /GUI 会话宿主未就绪/);
mgr.disable(g3.id);
sessions.isChatRuntime = prevIsChat;
delete runtimes.entries['gui-test'];
console.log('ok: GUI 注入失败/宿主未绑定记执行失败');

// ---------- 构造函数隔离坏任务（不卡启动） ----------
const badTasks = [
  {
    id: 'bad1',
    name: 'bad',
    workspaceId: 'default',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'daily', time: '9:00' },
    enabled: true,
    createdAt: Date.now()
  }
];
const store2 = {
  loadPromptTasks: () => badTasks.map((t) => ({ ...t, schedule: { ...t.schedule } })),
  loadTaskRuns: () => [],
  saveTaskRuns: () => {},
  savePromptTasks: (next) => {
    badTasks.length = 0;
    badTasks.push(...next.map((t) => ({ ...t, schedule: { ...t.schedule } })));
  },
};
const mgr2 = new PromptTasksManager(store2, config, sessions, runtimes);
assert.equal(badTasks[0].enabled, false, '坏任务被自动停用');
assert.equal(badTasks[0].nextRunAt, undefined);
assert.match(badTasks[0].lastError, /任务配置无效/);
console.log('ok: 坏任务不阻断构造并自动停用');

// ---------- 无头计数口径：execHeadless 收口（成败都计、启动即败也计） ----------
// 回归：code-index 索引助手也走 runHeadlessPiTask，计数必须收在 manager（只计定时任务）；
// 启动即败（runner 抛错）也要计数，否则卡片计数与 task-runs 列表对不上
const usageCounts = [];
mgr.bindHeadless({ usage: { recordHeadlessRun: (ok) => usageCounts.push(ok) } }, async (task) => {
  if (task.name === 'h-crash') throw new Error('pi load failed');
  return task.name === 'h-ok2'
    ? { ok: true, output: 'o', durationMs: 1 }
    : { ok: false, error: 'x', durationMs: 1 };
});
const hOk2 = mgr.create({
  name: 'h-ok2',
  runtime: 'cursor-cli',
  prompt: 'p',
  schedule: { kind: 'daily', time: '09:00' },
  enabled: true
});
hOk2.mode = 'headless';
const hCrash = mgr.create({
  name: 'h-crash',
  runtime: 'cursor-cli',
  prompt: 'p',
  schedule: { kind: 'daily', time: '09:00' },
  enabled: true
});
hCrash.mode = 'headless';
await mgr.runNow(hOk2.id);
await mgr.runNow(hCrash.id);
await new Promise((r) => setTimeout(r, 150)); // 等串行链排空
assert.deepEqual(usageCounts, [true, false], '成功与启动即败各计一次，口径与列表同源');
assert.equal(mgr.listRuns(hCrash.id)[0].status, 'error', '启动即败也进列表');
mgr.disable(hOk2.id);
mgr.disable(hCrash.id);
console.log('ok: 无头计数收口在 manager（含启动即败）');

// ---------- 僵尸 running：构造恢复时统一标中断并落盘 ----------
const zombieSaved = [];
const zombieRuns = () => [
  { id: 'z1', taskId: 't-zombie', mode: 'headless', status: 'running', startedAt: Date.now() - 60_000 },
  { id: 'z2', taskId: 't-zombie', mode: 'headless', status: 'ok', startedAt: Date.now() - 120_000, finishedAt: Date.now() - 100_000 }
];
const store3 = {
  loadPromptTasks: () => [],
  loadTaskRuns: zombieRuns,
  saveTaskRuns: (next) => zombieSaved.push(next.map((r) => ({ ...r }))),
  savePromptTasks: () => {},
};
const mgr3 = new PromptTasksManager(store3, config, sessions, runtimes);
const zRuns = mgr3.listRuns('t-zombie');
assert.equal(zRuns[0].status, 'error', 'running 恢复即标中断');
assert.match(zRuns[0].error, /应用重启，任务中断/);
assert.ok(zRuns[0].finishedAt > zRuns[0].startedAt, '中断用当前时刻作 finishedAt');
assert.ok((zRuns[0].durationMs ?? 0) >= 59_000, '中断时长不为 0');
assert.equal(zRuns[1].status, 'ok', '非 running 不动');
assert.equal(zombieSaved.length, 1, '恢复时落盘一次');
const zombieCounts = [];
mgr3.bindHeadless({ usage: { recordHeadlessRun: (ok) => zombieCounts.push(ok) } }, async () => ({ ok: true }));
assert.deepEqual(zombieCounts, [false], '中断无头补记日桶一次');
mgr3.bindHeadless({ usage: { recordHeadlessRun: (ok) => zombieCounts.push(ok) } }, async () => ({ ok: true }));
assert.deepEqual(zombieCounts, [false], '二次 bind 不重复计');
console.log('ok: 僵尸 running 构造恢复标中断');

// ---------- 统计聚合：范围过滤 + 分页 + 按任务聚合 ----------
{
  const tStat = mgr.create({
    name: 'stat-task',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'daily', time: '09:00' }
  });
  const DAY = 86_400_000;
  // 聚合按 finishedAt 的日桶过滤；用本地正午避免午夜运行时 +5 秒越到次日。
  const d0 = new Date().setHours(12, 0, 0, 0);
  const d3 = d0 - 3 * DAY;
  const d1 = d0 - 1 * DAY;
  mgr.recordRun({ id: 's1', taskId: tStat.id, mode: 'headless', status: 'ok', startedAt: d3, finishedAt: d3 + 5000, durationMs: 5000 });
  mgr.recordRun({ id: 's2', taskId: tStat.id, mode: 'headless', status: 'error', startedAt: d1, finishedAt: d1 + 3000, durationMs: 3000 });
  mgr.recordRun({ id: 's3', taskId: tStat.id, mode: 'headless', status: 'ok', startedAt: d0, finishedAt: d0 + 4000, durationMs: 4000 });

  const full = { fromKey: usageDayKey(d3), toKey: usageDayKey(d0) };
  const agg = mgr.aggregateRunsByTask({ mode: 'headless', ...full }).find((x) => x.taskId === tStat.id);
  assert.equal(agg.total, 3);
  assert.equal(agg.ok, 2);
  assert.equal(agg.error, 1);
  assert.equal(agg.avgDurationMs, 4000);
  assert.equal(agg.taskName, 'stat-task');

  // 仅昨天窗口：只剩一条失败
  const yday = { fromKey: usageDayKey(d1), toKey: usageDayKey(d1) };
  const aggY = mgr.aggregateRunsByTask({ mode: 'headless', ...yday }).find((x) => x.taskId === tStat.id);
  assert.equal(aggY.total, 1);
  assert.equal(aggY.error, 1);
  // 窗口外完全不含
  assert.equal(
    mgr.aggregateRunsByTask({ mode: 'headless', fromKey: '2020-01-01', toKey: '2020-01-02' }).length,
    0
  );

  // 分页：范围内分页返回 + total 全量
  const page1 = mgr.listRunsAcrossTasks({ mode: 'headless', ...full, offset: 0, limit: 2 });
  assert.equal(page1.rows.length, 2, '页大小生效');
  assert.ok(page1.total >= 3, 'total 是全量');
  assert.ok(page1.rows[0].startedAt >= page1.rows[1].startedAt, '倒序');
  const page2 = mgr.listRunsAcrossTasks({ mode: 'headless', ...full, offset: page1.rows.length, limit: 2 });
  assert.ok(page2.rows.every((r) => !page1.rows.some((p) => p.id === r.id)), '翻页不重叠');
  assert.equal(mgr.listRunsAcrossTasks({ mode: 'headless', fromKey: '2020-01-01', toKey: '2020-01-02' }).total, 0);

  // 按状态全量计数：不随分页截断（running 判据）
  mgr.recordRun({ id: 's-run', taskId: tStat.id, mode: 'headless', status: 'running', startedAt: Date.now() });
  assert.equal(
    mgr.countRunsByStatus('running', { mode: 'headless', ...full }),
    1,
    'running 全量计数'
  );
  assert.equal(
    mgr.countRunsByStatus('running', { mode: 'headless', fromKey: '2020-01-01', toKey: '2020-01-02' }),
    0,
    '窗口外不计'
  );
  mgr.recordRun({ id: 's-done', taskId: tStat.id, mode: 'headless', status: 'ok', startedAt: Date.now(), finishedAt: Date.now(), durationMs: 10 });
  assert.equal(
    mgr.countRunsByStatus('ok', { mode: 'headless', ...full }) >= 3,
    true,
    'ok 计数含全部成功'
  );

  // 跨日：列表/聚合按结束日，与日桶对齐（23:00 起、次日 00:10 结束 → 计入结束日）
  const y23 = new Date();
  y23.setDate(y23.getDate() - 1);
  y23.setHours(23, 0, 0, 0);
  const t010 = new Date();
  t010.setHours(0, 10, 0, 0);
  mgr.recordRun({
    id: 's-cross',
    taskId: tStat.id,
    mode: 'headless',
    status: 'ok',
    startedAt: y23.getTime(),
    finishedAt: t010.getTime(),
    durationMs: t010.getTime() - y23.getTime()
  });
  const endDay = usageDayKey(t010.getTime());
  const startDay = usageDayKey(y23.getTime());
  const idsEnd = mgr
    .listRunsAcrossTasks({ mode: 'headless', fromKey: endDay, toKey: endDay })
    .rows.map((r) => r.id);
  assert.ok(idsEnd.includes('s-cross'), '跨日运行按结束日计入列表');
  const idsStart = mgr
    .listRunsAcrossTasks({ mode: 'headless', fromKey: startDay, toKey: startDay })
    .rows.map((r) => r.id);
  assert.ok(!idsStart.includes('s-cross'), '跨日运行不计入开始日列表');
}
console.log('ok: 统计聚合（范围/分页/按任务）');

// ---------- T3.1 trigger 模型：读时迁移 + 事件触发不吃定时器 ----------
{
  // 存量任务无 trigger：读入归一为 time，行为不变（挂 timer）
  const legacyTasks = [
    {
      id: 'legacy1',
      name: 'legacy',
      workspaceId: 'default',
      runtime: 'cursor-cli',
      prompt: 'p',
      schedule: { kind: 'daily', time: '09:00' },
      enabled: true,
      createdAt: Date.now()
    }
  ];
  const storeLegacy = {
    loadPromptTasks: () => legacyTasks.map((tk) => ({ ...tk, schedule: { ...tk.schedule } })),
    savePromptTasks: (next) => {
      legacyTasks.length = 0;
      legacyTasks.push(...next.map((tk) => ({ ...tk, schedule: { ...tk.schedule } })));
    },
    loadTaskRuns: () => [],
    saveTaskRuns: () => {},
  };
  const mgrLegacy = new PromptTasksManager(storeLegacy, config, sessions, runtimes);
  assert.equal(Object.hasOwn(legacyTasks[0], 'trigger'), false, '存量定时任务不携带已删除的字段');
  assert.ok(legacyTasks[0].nextRunAt > Date.now(), 'time 语义照旧：仍挂下一次时刻');
  assert.ok(mgrLegacy.timers.has('legacy1'), 'time 语义照旧：定时器已挂');
  mgrLegacy.stop();
  console.log('ok: 存量定时任务恢复并保持定时行为');


}

// ---------- O12 决策门：目标=调度会话（headless 调度域）且调度 needs_you → 本次跳过、保持 due ----------
{
  // 「目标是调度会话」= headless 模式（跑调度提示词 + 调度工具面 + <wsId>:tasks 桶，
  // 等于从旁开调度回合）；terminal 模式拉独立 Worker 会话不碰调度，不受门限制。
  const phaseByWs = new Map([['default', 'needs_you']]);
  let gateFired = 0;
  mgr.bindHeadless(
    {
      schedulerStatus: {
        get: (id) =>
          id === 'default' ? { workspaceId: id, phase: phaseByWs.get(id), ts: 1 } : undefined
      }
    },
    async (task) => {
      gateFired += 1;
      return { ok: true, output: `dg:${task.name}`, durationMs: 1 };
    }
  );

  const dg = mgr.create({
    name: 'dg-hold',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    enabled: true
  });
  dg.mode = 'headless';
  // 挂一个 50ms 后触发的真实定时槽（不走 arm 的错过窗口分支）
  dg.lastRunAt = Date.now() - 10_000;
  const dueAt = Date.now() + 50;
  dg.nextRunAt = dueAt;
  mgr.arm(dg);
  await new Promise((r) => setTimeout(r, 180)); // 等 50ms 定时器触发（defer 挂 30s 重试）
  assert.equal(gateFired, 0, '调度 needs_you 时定时触发不执行');
  assert.equal(dg.nextRunAt, dueAt, 'nextRunAt 保持 due（不推下一次）');
  assert.equal(
    mgr.listRuns(dg.id).length,
    0,
    '不落任何运行记录（不是 missed/skipped——错过策略不动）'
  );
  assert.ok(mgr.timers.has(dg.id), '重试定时器仍挂（下轮再试）');

  // runNow 手动触发不受决策门限制（人为发起）
  await mgr.runNow(dg.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(gateFired, 1, 'runNow 手动触发照常执行');
  assert.ok(dg.nextRunAt > Date.now(), '正常执行后推进下次时刻');

  // 调度相位移出 needs_you（切 idle/done）→ 定时触发照常执行
  phaseByWs.set('default', 'idle');
  dg.lastRunAt = Date.now() - 10_000;
  dg.nextRunAt = Date.now() + 50;
  mgr.arm(dg);
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(gateFired, 2, '调度离开 needs_you 后放行');
  assert.ok(dg.lastResult === 'ok');
  mgr.disable(dg.id);

  // terminal 模式不进门：调度 needs_you 也照常拉起
  phaseByWs.set('default', 'needs_you');
  let termFired = 0;
  const origCreate = sessions.createTerminal;
  sessions.createTerminal = async () => {
    termFired += 1;
    return { id: 'sess-dg' };
  };
  const dgTerm = mgr.create({
    name: 'dg-term',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    enabled: true,
    mode: 'terminal'
  });
  dgTerm.lastRunAt = Date.now() - 10_000;
  dgTerm.nextRunAt = Date.now() + 50;
  mgr.arm(dgTerm);
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(termFired, 1, 'terminal 模式（独立 Worker）不受决策门限制');
  sessions.createTerminal = origCreate;
  mgr.disable(dgTerm.id);

  // 状态源缺失/读失败 → fail-open（不挡）
  mgr.bindHeadless(
    {
      schedulerStatus: {
        get: () => {
          throw new Error('status boom');
        }
      }
    },
    async (task) => {
      gateFired += 1;
      return { ok: true, durationMs: 1 };
    }
  );
  const dgFailOpen = mgr.create({
    name: 'dg-failopen',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    enabled: true
  });
  dgFailOpen.mode = 'headless';
  dgFailOpen.lastRunAt = Date.now() - 10_000;
  dgFailOpen.nextRunAt = Date.now() + 50;
  mgr.arm(dgFailOpen);
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(gateFired, 3, '状态读失败当不挡（fail-open）');
  mgr.disable(dgFailOpen.id);
  console.log('ok: O12 决策门（headless needs_you 跳过保持 due / runNow 直通 / 移出放行 / fail-open）');
}

// ---------- O12 决策门暂缓 × 系统唤醒：过期不误判错过，门解除后重试真跑 ----------
{
  // 场景：暂缓中系统睡眠唤醒（evaluateMissedOnWake → arm 见 nextRunAt 已过期）——
  // 暂缓链上的 due 不是「错过」：skip 不记 missed、catch-up 不绕门补跑、confirm 不弹确认，
  // nextRunAt 保持；门解除后 30s 重试真正执行。普通过期任务（无标记且门开）照旧判错过。
  const phaseByWs = new Map([['default', 'needs_you']]);
  let gateRuns = 0;
  mgr.bindHeadless(
    {
      schedulerStatus: {
        get: (id) =>
          id === 'default' ? { workspaceId: id, phase: phaseByWs.get(id), ts: 1 } : undefined
      }
    },
    async (task) => {
      gateRuns += 1;
      return { ok: true, output: `wake:${task.name}`, durationMs: 1 };
    }
  );

  const mkHoldTask = (name, missedPolicy) => {
    const task = mgr.create({
      name,
      runtime: 'cursor-cli',
      prompt: 'p',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      enabled: true,
      missedPolicy
    });
    task.mode = 'headless';
    return task;
  };
  const holdSkip = mkHoldTask('hold-skip', 'skip');
  const holdCatch = mkHoldTask('hold-catch', 'catch-up');
  const holdConfirm = mkHoldTask('hold-confirm', 'confirm');

  // 走真实暂缓链：短定时槽触发 → deferForDecisionGate 挡下（打暂缓标记 + 挂 30s 重试）
  const armDue = (task) => {
    task.lastRunAt = Date.now() - 70_000;
    const dueAt = Date.now() + 50;
    task.nextRunAt = dueAt;
    mgr.arm(task);
    return dueAt;
  };
  const dueSkip = armDue(holdSkip);
  const dueCatch = armDue(holdCatch);
  const dueConfirm = armDue(holdConfirm);
  await new Promise((r) => setTimeout(r, 180)); // 等 50ms 定时器触发（全部被门挡下）
  assert.equal(gateRuns, 0, '暂缓中不执行');
  assert.ok(mgr.decisionGateDeferred.has(holdSkip.id), '暂缓标记已打');
  assert.ok(mgr.timers.has(holdSkip.id), '30s 重试定时器已挂');

  // 模拟系统唤醒：evaluateMissedOnWake → arm 对过期任务重评错过窗口
  const notifyBeforeWake = notifyPushes.length;
  mgr.evaluateMissedOnWake();
  assert.equal(gateRuns, 0, '唤醒后门未解除仍不执行');
  assert.equal(mgr.listRuns(holdSkip.id).length, 0, 'skip 不记 missed');
  assert.equal(mgr.listRuns(holdCatch.id).length, 0, 'catch-up 不补跑（无任何运行记录）');
  assert.equal(mgr.listRuns(holdConfirm.id).length, 0, 'confirm 不记 missed');
  assert.equal(holdConfirm.missedPendingConfirm, undefined, 'confirm 不弹补跑确认');
  assert.equal(holdSkip.nextRunAt, dueSkip, 'skip：nextRunAt 保持 due');
  assert.equal(holdCatch.nextRunAt, dueCatch, 'catch-up：nextRunAt 保持 due');
  assert.ok(mgr.timers.has(holdSkip.id), '重试定时器重挂');
  assert.equal(notifyPushes.length, notifyBeforeWake, '不推「错过运行」通知');

  // 重启兜底：内存标记随进程丢失（清空模拟），「此刻仍 needs_you」同样不判错过
  mgr.decisionGateDeferred.clear();
  mgr.evaluateMissedOnWake();
  assert.equal(mgr.listRuns(holdSkip.id).length, 0, '重启兜底：仍 blocked 不记 missed');
  assert.equal(holdSkip.nextRunAt, dueSkip, '重启兜底：nextRunAt 保持');
  assert.ok(mgr.decisionGateDeferred.has(holdSkip.id), '兜底路径重新打上暂缓标记');

  // 门解除后 30s 重试真正执行（直接调 retry tick 模拟重试定时器到点）
  phaseByWs.set('default', 'idle');
  mgr.decisionGateRetryTick(holdSkip);
  await new Promise((r) => setTimeout(r, 120)); // 等无头串行链排空
  assert.equal(gateRuns, 1, '门解除后重试真跑');
  assert.equal(holdSkip.lastResult, 'ok');
  assert.ok(holdSkip.nextRunAt > Date.now(), '真跑后推进下次时刻');
  assert.ok(!mgr.decisionGateDeferred.has(holdSkip.id), '放行后清暂缓标记');

  // 普通过期任务（门开、无标记）：错过判定不受影响（不因 headless 模式被误豁免）
  const plainOverdue = mkHoldTask('plain-overdue', 'skip');
  plainOverdue.lastRunAt = Date.now() - 70_000;
  plainOverdue.nextRunAt = Date.now() - 60_000;
  mgr.arm(plainOverdue);
  assert.ok(
    mgr.listRuns(plainOverdue.id).some((r) => r.status === 'missed'),
    '无暂缓的普通过期任务照旧记 missed'
  );
  mgr.disable(plainOverdue.id);
  mgr.disable(holdSkip.id);
  mgr.disable(holdCatch.id);
  mgr.disable(holdConfirm.id);
  assert.equal(mgr.decisionGateDeferred.size, 0, 'disable 清暂缓标记（无泄漏）');
  console.log('ok: 决策门暂缓×系统唤醒不误判错过（skip/catch-up/confirm）+ 门解除重试真跑');
}

// ---------- X1-F02：O12 决策门也认 C2 内存 ask 卡（单一等人谓词） ----------
{
  const asks = new Map([['default', { workspaceId: 'default', reason: 'askQuestion', questionId: 'q1', since: 1 }]]);
  let gateFired = 0;
  // 上一块共享的 mgr 已 disable 收尾；这里复用同一 store/tasks 重建干净管理器
  const mgrC2 = new PromptTasksManager(store, config, sessions, runtimes, notifyStub);
  mgrC2.bindHeadless(
    {
      schedulerStatus: { get: () => undefined }, // C1 持久账无 needs_you
      orchestrator: { getHumanWait: (id) => asks.get(id) ?? null }
    },
    async (task) => {
      gateFired += 1;
      return { ok: true, durationMs: 1 };
    }
  );
  const t = mgrC2.create({
    name: 'c2-hold', runtime: 'cursor-cli', prompt: 'p',
    schedule: { kind: 'interval', intervalMinutes: 60 }, enabled: true
  });
  t.mode = 'headless';
  t.lastRunAt = Date.now() - 10_000;
  const dueAt = Date.now() + 50;
  t.nextRunAt = dueAt;
  mgrC2.arm(t);
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(gateFired, 0, 'X1-F02：C2 ask 卡挂起（无 C1 needs_you）时定时触发同样暂缓');
  assert.equal(t.nextRunAt, dueAt, '保持 due');
  asks.delete('default'); // 用户作答，卡解除
  t.lastRunAt = Date.now() - 10_000;
  t.nextRunAt = Date.now() + 50;
  mgrC2.arm(t);
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(gateFired, 1, 'ask 卡解除后放行');
  mgrC2.disable(t.id);
  console.log('ok: O12 决策门认 C2 ask 卡（X1-F02 单一谓词）');
}

// ---------- prompt-tasks F-02：半配模型降级写进本次运行记录（任务级可见） ----------
{
  const mgrD = new PromptTasksManager(store, config, sessions, runtimes, notifyStub);
  const t = mgrD.create({
    name: 'half-model', runtime: 'cursor-cli', prompt: 'p',
    schedule: { kind: 'daily', time: '09:00' }, enabled: true,
    providerId: 'cursor' // 只给一半：modelId 缺失 → 降级不覆盖模型
  });
  await mgrD.runNow(t.id);
  const runs = mgrD.listRuns(t.id).filter((r) => r.status === 'ok');
  assert.equal(runs.length, 1, '降级不阻断执行（本轮 ok）');
  assert.match(runs[0].error, /模型只配置了一半/, 'F-02：降级提示写进运行记录');
  assert.equal(t.lastResult, 'ok', '任务本体不记失败');
  mgrD.disable(t.id);
  console.log('ok: F-02 半配模型降级入运行记录');
}

mgr.stop();
console.log('prompt-tasks-manager: ok');
