/**
 * W5 回归：runtime 禁用/注销的执行前置失败进统一任务记账。
 * 修复前：assertRuntimeEnabled 在创建 TaskRun 与 try 之前抛出——runNow 拒绝但
 * runs=0、lastError/lastResult 空、无失败通知；定时入口只剩外层日志。
 * 修复后：manual/interval/once/event 四类入口的失败都进 TaskRun（status=error）、
 * lastResult='error'/lastError=原因、按原策略推「执行失败」通知；不新建会话、
 * 成功次数（runCount）不增加、once/maxRuns 槽位不被误消耗；恢复 runtime 后可重试。
 * 运行: node test/prompt-task-preflight-accounting.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptm-preflight-'));
const compile = createSharedCompiler(root, tmp);
const { PromptTasksManager, ONCE_FAILURE_RETRY_MS } = await import(
  pathToFileURL(compile('main/tasks/manager.ts')).href
);

function makeHarness() {
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
    get: () => ({ activeWorkspaceId: 'ws1', workspaces: [{ id: 'ws1', path: tmp }] })
  };
  const created = [];
  const sessions = {
    list: () => [],
    listByWorkspace: () => [],
    createScheduledTaskSession: () => {},
    updateScheduledTaskSession: () => {},
    removeScheduledSession: () => {},
    touchScheduledSession: () => {},
    isChatRuntime: () => false,
    createTerminal: async (opts) => {
      const id = `sess-${created.length + 1}`;
      created.push({ id, name: opts.name });
      return { id };
    }
  };
  const runtimes = {
    entries: { 'cursor-cli': { id: 'cursor-cli', enabled: true } },
    get(id) {
      return this.entries[id];
    }
  };
  const notifyPushes = [];
  const mgr = new PromptTasksManager(store, config, sessions, runtimes, { push: (x) => notifyPushes.push(x) });
  const disableRuntime = () => {
    runtimes.entries['cursor-cli'] = { id: 'cursor-cli', enabled: false };
  };
  const enableRuntime = () => {
    runtimes.entries['cursor-cli'] = { id: 'cursor-cli', enabled: true };
  };
  return { mgr, tasks, taskRuns, created, notifyPushes, disableRuntime, enableRuntime };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1) manual（runNow）：前置失败进统一记账 ----------
{
  const h = makeHarness();
  const task = h.mgr.create({
    name: 'manual',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'daily', time: '09:00' },
    mode: 'terminal',
    enabled: true
  });
  h.disableRuntime();
  await assert.rejects(h.mgr.runNow(task.id), /runtime 未注册或已禁用/);
  assert.equal(task.lastResult, 'error', 'lastResult 记为 error');
  assert.match(task.lastError, /runtime 未注册或已禁用/);
  const runs = h.mgr.listRuns(task.id);
  assert.equal(runs.length, 1, '落了一条运行记录');
  assert.equal(runs[0].status, 'error');
  assert.equal(runs[0].sessionId, undefined, '未创建会话');
  assert.deepEqual(h.created, [], '未拉起任何终端会话');
  assert.equal(task.runCount ?? 0, 0, '成功次数不增加');
  assert.ok(
    h.notifyPushes.some((n) => n.kind === 'error' && /执行失败/.test(n.label)),
    '按原策略推失败通知'
  );
  // 恢复 runtime 后可重试
  h.enableRuntime();
  await h.mgr.runNow(task.id);
  assert.equal(task.lastResult, 'ok');
  assert.equal(h.created.length, 1, '恢复后重试成功拉起');
  h.mgr.stop();
  console.log('ok: W5 manual 入口失败记账 + 恢复后可重试');
}

// ---------- 2) interval：定时器到点的前置失败同样记账 ----------
{
  const h = makeHarness();
  const task = h.mgr.create({
    name: 'interval',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    mode: 'terminal',
    enabled: true
  });
  h.disableRuntime();
  // 把下一次运行拉近到 40ms 后，重挂定时器走真实 timer 入口
  task.nextRunAt = Date.now() + 40;
  h.mgr.arm(task);
  await delay(300);
  const runs = h.mgr.listRuns(task.id);
  assert.equal(runs.length, 1, '定时入口落了失败记录');
  assert.equal(runs[0].status, 'error');
  assert.match(task.lastError, /runtime 未注册或已禁用/);
  assert.equal(task.runCount ?? 0, 0, '不增加成功次数');
  assert.ok(task.nextRunAt > Date.now(), '失败后排到未来槽位（可重试）');
  assert.ok(h.mgr.timers.has(task.id), '失败后定时器重挂');
  h.mgr.stop();
  console.log('ok: W5 interval 入口失败记账并重排');
}

// ---------- 3) once：失败不吃掉重试规则（5 分钟后重试，不消费槽位自停） ----------
{
  const h = makeHarness();
  const task = h.mgr.create({
    name: 'once',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'once', at: new Date(Date.now() + 40).toISOString() },
    mode: 'terminal',
    enabled: true
  });
  h.disableRuntime();
  await delay(300);
  const runs = h.mgr.listRuns(task.id);
  assert.equal(runs.length, 1, 'once 入口落了失败记录');
  assert.equal(runs[0].status, 'error');
  assert.equal(task.enabled, true, '前置失败不消费 once 槽位、任务不自停');
  assert.ok(task.nextRunAt <= Date.now() + ONCE_FAILURE_RETRY_MS + 50 && task.nextRunAt > Date.now(), '按失败重试规则排 5 分钟');
  assert.ok(h.mgr.timers.has(task.id), '重试定时器已挂');
  // 恢复 runtime 后重试成功（把重试槽拉近验证可重试）
  h.enableRuntime();
  task.nextRunAt = Date.now() + 40;
  h.mgr.arm(task);
  await delay(300);
  assert.equal(task.lastResult, 'ok', '恢复后重试成功');
  assert.equal(h.created.length, 1);
  h.mgr.stop();
  console.log('ok: W5 once 入口失败不误耗槽位、恢复后按策略重试');
}

// ---------- 5) 源目录失效路径不回归（仍在统一记账内） ----------
{
  const h = makeHarness();
  const task = h.mgr.create({
    name: 'src',
    runtime: 'cursor-cli',
    prompt: 'p',
    schedule: { kind: 'daily', time: '09:00' },
    mode: 'terminal',
    enabled: true
  });
  // 创建时已捕获默认根；模拟“根移除/错配”后把快照指向不存在的 rootId
  task.sourceRoot = { rootId: 'root-gone', path: path.join(tmp, 'gone'), cwd: path.join(tmp, 'gone') };
  h.tasks[0] = task;
  await assert.rejects(h.mgr.runNow(task.id), /source folder|根目录|目录/);
  const runs = h.mgr.listRuns(task.id);
  assert.equal(runs.length, 1, '源目录失败同样有运行记录');
  assert.equal(runs[0].status, 'error');
  assert.deepEqual(h.created, []);
  h.mgr.stop();
  console.log('ok: W5 源目录失效仍走统一失败记账');
}

{
  const h = makeHarness(); let finishCreate;
  const task = h.mgr.create({ name: 'shutdown-launch', runtime: 'cursor-cli', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, mode: 'terminal', enabled: true });
  h.mgr.sessions.createTerminal = () => new Promise(resolve => { finishCreate = resolve; });
  h.mgr.sessions.isChatRuntime = () => true;
  let sent = 0; h.mgr.bindGuiHost({ send: async () => { sent++; return { ok: true }; } });
  const run = h.mgr.runNow(task.id).catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishCreate, 'function');
  let stopped = false; const shutdown = h.mgr.shutdown().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false, 'shutdown retains an accepted session launch');
  finishCreate({ id: 'late-created-session' });
  assert.ok(await run instanceof Error); await shutdown;
  assert.equal(sent, 0, 'late launch never injects after shutdown admission closes');
  assert.equal(h.mgr.listRuns(task.id)[0].sessionId, 'late-created-session', 'actual created session remains in the task result');
}
{
  const h = makeHarness(); const held = new Set(); let fail = true;
  h.mgr.create({ name: 'power-owner', runtime: 'cursor-cli', prompt: 'p', schedule: { kind: 'interval', intervalMinutes: 1 }, mode: 'terminal', enabled: true });
  h.mgr.bindPower({ startPreventAppSuspension: () => { held.add(42); return 42; }, onResume: () => () => {}, stop: id => { if (fail) throw Error('fixture blocker release denied'); held.delete(id); } });
  assert.equal(held.has(42), true);
  await assert.rejects(h.mgr.shutdown(), /Prompt task shutdown failed/); assert.equal(held.has(42), true);
  fail = false; await h.mgr.shutdown(); assert.equal(held.size, 0, 'failed power owner is retained and a successful retry clears the error');
}
{
  const h = makeHarness(); let releaseCreate, stopping, drained = false;
  const held = new Promise(resolve => { releaseCreate = resolve; });
  const task = h.mgr.create({ name: 'sync-stop', runtime: 'cursor-cli', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, mode: 'terminal', enabled: true });
  h.mgr.sessions.createTerminal = () => { stopping = h.mgr.shutdown().then(() => { drained = true; }); return held; };
  const accepted = h.mgr.runNow(task.id).catch(error => error);
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.ok(stopping);
    assert.equal(drained, false, 'synchronous createTerminal callback cannot escape the accepted launch set');
  } finally { releaseCreate({ id: 'synchronous-stop-session' }); await accepted; await stopping; }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('prompt-task-preflight-accounting: all ok');
