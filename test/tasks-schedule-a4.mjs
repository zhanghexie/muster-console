/**
 * T6/T7（S2.4 定时任务缺口）：
 * - once：getNextRunAt 解析 at、成功一次自停（shouldAutoDisableAfterRun）
 * - delayMinutes：与 schedule 互斥，host 真实时钟换算触发点并落到 once
 * - maxRuns：达到次数后自停
 * - 旧任务兼容：无新字段的 daily/weekly/interval 行为不变
 * - catalog 教学文案：相对延迟禁止编成 interval/daily、once 用法、name 保留原话
 * 运行: node test/tasks-schedule-a4.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsched-a4-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/tasks/schedule.ts');
const {
  getNextRunAt,
  scheduleFromDelayMinutes,
  resolveScheduleInput,
  validateMaxRuns,
  shouldAutoDisableAfterRun,
  consumeOnceSlot
} = await import(pathToFileURL(outFile).href);

const MIN = 60_000;

// ---------- once：getNextRunAt 解析 ISODateTime ----------
{
  const at = '2026-03-01T09:00:00.000Z';
  assert.equal(
    getNextRunAt({ kind: 'once', at }),
    Date.parse(at),
    'once 返回 at 的 epoch ms'
  );
  // from 不影响 once 的触发点（唯一槽位就是 at 本身）
  assert.equal(
    getNextRunAt({ kind: 'once', at }, new Date(Date.parse(at) + 3600_000)),
    Date.parse(at),
    'once 的触发点不随 from 漂移'
  );
  for (const bad of ['', '  ', 'not-a-date', '2026-13-45']) {
    assert.throws(() => getNextRunAt({ kind: 'once', at: bad }), /once\.at/, `非法 at 拒绝: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => getNextRunAt({ kind: 'once', at: undefined }), /once\.at/);
  // 事件触发仍不挂定时器
  console.log('ok: once getNextRunAt 解析 / 非法 at 拒绝');
}

// ---------- once 成功一次自停 ----------
{
  const once = { kind: 'once', at: '2026-03-01T09:00:00.000Z' };
  assert.equal(
    shouldAutoDisableAfterRun({ schedule: once, runCount: 1 }),
    true,
    'once 成功一次即自停'
  );
  assert.equal(
    shouldAutoDisableAfterRun({ schedule: once, runCount: 5 }),
    true,
    'once 无论计数多少都停'
  );
  // 未到成功次数（调用方只在成功路径上调用，防御性分支）
  assert.equal(
    shouldAutoDisableAfterRun({ schedule: { kind: 'daily', time: '09:00' }, runCount: 1 }),
    false,
    '无 maxRuns 的周期任务不停'
  );
  console.log('ok: once 成功一次自停');
}

// ---------- delayMinutes：host 真实时钟换算到 once ----------
{
  // 显式注入时钟：触发点 = now + delay（宿主换算，不是模型自算）
  const now = Date.UTC(2026, 2, 1, 8, 0, 0);
  const sched = scheduleFromDelayMinutes(8, now);
  assert.equal(sched.kind, 'once', 'delayMinutes 落成 once');
  assert.equal(
    Date.parse(sched.at),
    now + 8 * MIN,
    '8 分钟后 = now + 8min（host 真实时钟，毫秒级可断言）'
  );

  // 小时级延迟：调用方传 120 分钟（工具描述要求把小时换算成分钟），不落 interval/daily
  const hour = scheduleFromDelayMinutes(120, now);
  assert.equal(hour.kind, 'once');
  assert.equal(Date.parse(hour.at), now + 120 * MIN);

  // 缺省时钟 = Date.now()（host 真实时钟）：前后夹逼断言
  const before = Date.now();
  const live = scheduleFromDelayMinutes(8);
  const after = Date.now();
  const liveAt = Date.parse(live.at);
  assert.ok(liveAt >= before + 8 * MIN && liveAt <= after + 8 * MIN, '未注入 now 时用 Date.now() 换算');

  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => scheduleFromDelayMinutes(bad, now), /delayMinutes/, `非法 delayMinutes 拒绝: ${bad}`);
  }
  assert.throws(() => scheduleFromDelayMinutes(43201, now), /上限/, '超过 30 天上限拒绝');
  assert.equal(
    Date.parse(scheduleFromDelayMinutes(43200, now).at),
    now + 43200 * MIN,
    '恰好 30 天允许'
  );
  console.log('ok: delayMinutes host 真实时钟换算到 once（含小时/非法/上限）');
}

// ---------- resolveScheduleInput：delayMinutes 与 schedule 互斥 ----------
{
  const now = Date.UTC(2026, 2, 1, 8, 0, 0);
  const daily = { kind: 'daily', time: '09:00' };

  // 只给 schedule：原样通过（并完成合法性校验）
  assert.deepEqual(resolveScheduleInput({ schedule: daily }, now), daily);

  // 只给 delayMinutes：落到 once
  const onlyDelay = resolveScheduleInput({ delayMinutes: 8 }, now);
  assert.equal(onlyDelay.kind, 'once');
  assert.equal(Date.parse(onlyDelay.at), now + 8 * MIN);

  // 互斥：同时给两个 → 拒绝
  assert.throws(
    () => resolveScheduleInput({ schedule: daily, delayMinutes: 8 }, now),
    /二选一|不能同时/,
    'delayMinutes 与 schedule 互斥'
  );

  // 两个都不给 → 拒绝
  assert.throws(() => resolveScheduleInput({}, now), /必须提供/, 'schedule 与 delayMinutes 至少一个');

  // once schedule 直接给也要能校验通过
  const once = { kind: 'once', at: '2026-03-02T01:00:00.000Z' };
  assert.deepEqual(resolveScheduleInput({ schedule: once }, now), once);

  // 非法 schedule 被校验拦下（旧路径兼容）
  assert.throws(() => resolveScheduleInput({ schedule: { kind: 'daily', time: '9:00' } }, now), /HH:mm/);
  console.log('ok: resolveScheduleInput 互斥校验 / 至少一个 / 非法 schedule 拦下');
}

// ---------- maxRuns：校验 + 达到次数自停 ----------
{
  assert.equal(validateMaxRuns(undefined), undefined, '缺省不限次');
  assert.equal(validateMaxRuns(3), 3, '正整数通过');
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => validateMaxRuns(bad), /maxRuns/, `非法 maxRuns 拒绝: ${bad}`);
  }

  const daily = { kind: 'daily', time: '09:00' };
  assert.equal(
    shouldAutoDisableAfterRun({ schedule: daily, maxRuns: 3, runCount: 1 }),
    false,
    'maxRuns 未达到 → 不停'
  );
  assert.equal(
    shouldAutoDisableAfterRun({ schedule: daily, maxRuns: 3, runCount: 2 }),
    false,
    'maxRuns 差一次 → 不停'
  );
  assert.equal(
    shouldAutoDisableAfterRun({ schedule: daily, maxRuns: 3, runCount: 3 }),
    true,
    'maxRuns 达到 → 自停'
  );
  assert.equal(
    shouldAutoDisableAfterRun({ schedule: daily, maxRuns: 3, runCount: 4 }),
    true,
    '超过上限也停'
  );
  // interval / weekly 同规则
  assert.equal(
    shouldAutoDisableAfterRun({ schedule: { kind: 'interval', intervalMinutes: 30 }, maxRuns: 1, runCount: 1 }),
    true
  );
  assert.equal(
    shouldAutoDisableAfterRun({
      schedule: { kind: 'weekly', time: '09:00', weekdays: [1] },
      maxRuns: 2,
      runCount: 1
    }),
    false
  );
  console.log('ok: maxRuns 校验与达到次数自停');
}

// ---------- 旧任务兼容 ----------
{
  // 无 maxRuns/delayMinutes/runCount 的存量任务：周期行为不变，不停用
  for (const legacy of [
    { kind: 'daily', time: '09:00' },
    { kind: 'weekly', time: '09:00', weekdays: [1, 3] },
    { kind: 'interval', intervalMinutes: 30 }
  ]) {
    assert.equal(
      shouldAutoDisableAfterRun({ schedule: legacy, runCount: 100 }),
      false,
      `存量 ${legacy.kind} 无 maxRuns 不自停`
    );
  }
  // 存量 schedule 的 getNextRunAt 不受影响
  const at = new Date(2026, 0, 1, 8);
  assert.equal(
    getNextRunAt({ kind: 'interval', intervalMinutes: 30 }, at),
    at.getTime() + 30 * MIN,
    'interval 兼容'
  );
  assert.equal(getNextRunAt({ kind: 'daily', time: '09:00' }, at), new Date(2026, 0, 1, 9).getTime(), 'daily 兼容');
  // resolveScheduleInput 传存量 schedule（无 delayMinutes）直通
  assert.deepEqual(
    resolveScheduleInput({ schedule: { kind: 'daily', time: '08:00' } }, Date.now()),
    { kind: 'daily', time: '08:00' }
  );
  console.log('ok: 旧任务兼容（无新字段不停用 / 老 schedule 计算不变）');
}

// ---------- T7：catalog 教学文案与参数 ----------
{
  const servicesSrc = fs.readFileSync(
    path.join(root, 'src', 'main', 'capabilities', 'catalog', 'services.ts'),
    'utf8'
  );
  // 教学文案：相对延迟禁止编成 interval/daily（R0 英文化后断言英文真源文案）
  assert.match(servicesSrc, /delayMinutes/, 'createScheduled/update 声明 delayMinutes');
  assert.match(servicesSrc, /never encode (?:it as )?interval\/daily/, '描述含「never encode interval/daily」');
  assert.match(servicesSrc, /one-shot/, '描述含 once 用法（one-shot）');
  assert.match(servicesSrc, /kind["']?\s*:\s*["']once["']/, '描述给出 once 形态示例');
  assert.match(servicesSrc, /verbatim phrase/, 'name 教学要求保留用户原话（verbatim phrase）');
  assert.match(servicesSrc, /maxRuns/, '声明 maxRuns');
  assert.match(servicesSrc, /mutually exclusive/, '声明 delayMinutes 与 schedule 互斥');

  // 参数校验（纯函数层）已覆盖；这里断言工具参数 schema 有对应键
  const catalogOut = compile('main/capabilities/catalog/services.ts');
  const { SERVICES_TOOL_DEFS } = await import(pathToFileURL(catalogOut).href);
  const create = SERVICES_TOOL_DEFS.find((d) => d.name === 'automations.create');
  const update = SERVICES_TOOL_DEFS.find((d) => d.name === 'automations.update');
  assert.ok(create && update, 'createScheduled/update 定义存在');
  for (const def of [create, update]) {
    assert.ok(def.parameters.properties.delayMinutes, `${def.name} 含 delayMinutes 参数`);
    assert.ok(def.parameters.properties.maxRuns, `${def.name} 含 maxRuns 参数`);
    assert.ok(def.parameters.properties.schedule, `${def.name} 含 schedule 参数`);
    assert.match(def.parameters.properties.schedule.description, /once/, `${def.name} schedule 描述含 once`);
    assert.ok(
      !def.parameters.required?.includes('schedule') || def.parameters.required.includes('delayMinutes'),
      `${def.name} schedule 不再是唯一必填（delayMinutes 可替代）`
    );
  }
  // create 的 name 参数教学：保留用户原话（R0 英文化后断言 verbatim）
  assert.match(create.parameters.properties.name.description, /verbatim/, 'name 参数描述教保留原话（verbatim）');
  console.log('ok: catalog 教学文案与参数 schema（once/delayMinutes/maxRuns/互斥/原话）');
}

// ---------- C1/C2 回归（评审 critical：once 无限重跑 / 自停未接 terminal） ----------
{
  // consumeOnceSlot：槽位消费后 enabled=false 且 nextRunAt 清空
  const onceTask = {
    schedule: { kind: 'once', at: new Date(Date.now() - 1000).toISOString() },
    enabled: true,
    nextRunAt: Date.now() - 1000
  };
  consumeOnceSlot(onceTask);
  assert.equal(onceTask.enabled, false, 'once 消费后自停');
  assert.equal(onceTask.nextRunAt, undefined, 'once 消费后不再挂 nextRunAt');
  // 周期任务不受影响
  const dailyTask = { schedule: { kind: 'daily', time: '09:00' }, enabled: true, nextRunAt: 1 };
  consumeOnceSlot(dailyTask);
  assert.equal(dailyTask.enabled, true, 'daily 不被 consumeOnceSlot 停用');

  // C2 源码锚：生产 terminal 成功路径必须调 shouldAutoDisableAfterRun（不能只留 headless）
  const managerSrc = fs.readFileSync(path.join(root, 'src', 'main', 'tasks', 'manager.ts'), 'utf8');
  const terminalOkBlock = managerSrc.slice(
    managerSrc.indexOf("task.lastResult = 'ok'"),
    managerSrc.indexOf("run.status = 'ok'")
  );
  assert.match(
    terminalOkBlock,
    /shouldAutoDisableAfterRun/,
    'terminal 成功路径必须接 shouldAutoDisableAfterRun（C2）'
  );
  assert.match(terminalOkBlock, /runCount/, 'terminal 成功路径必须累加 runCount（C2）');

  // C1 源码锚：arm() 对 once 槽位已消费/skip/confirm 必须 return，禁止 0 延迟重挂；
  // 对周期任务 skip/confirm 必须 fall-through 到尾部 setTimeout（复审 critical：漏挂=静默死亡）
  const armStart = managerSrc.indexOf('private arm(task: PromptTask)');
  const armSrc = managerSrc.slice(armStart, managerSrc.indexOf('private startHeadless'));
  assert.match(armSrc, /consumeOnceSlot/, 'arm() 对 once 槽位消费必须 consumeOnceSlot（C1）');
  assert.match(
    armSrc,
    /decision\.action === 'none'[\s\S]*?return;/,
    'arm() none 分支对 once 必须 return（C1）'
  );
  assert.match(
    armSrc,
    /decision\.action === 'catch-up'[\s\S]*?return;/,
    'arm() catch-up 后必须 return，不得落入 0 延迟挂表'
  );
  // 周期任务 skip/confirm：记账后不得整体 return，须落到 setTimeout 挂表
  const skipBlock = armSrc.slice(armSrc.indexOf('skip / confirm'));
  const onceReturnIdx = skipBlock.indexOf('return;');
  const setTimeoutIdx = skipBlock.indexOf('setTimeout(');
  assert.ok(onceReturnIdx >= 0 && setTimeoutIdx > onceReturnIdx, 'skip/confirm 的 return 只能在 once 分支内，周期须落到 setTimeout(');
  assert.match(
    skipBlock.slice(0, onceReturnIdx),
    /schedule\.kind === 'once'/,
    'skip/confirm 的 return 必须包在 once 判定内'
  );
  assert.match(
    armSrc,
    /const delay = Math\.max\(0, task\.nextRunAt - Date\.now\(\)\)/,
    'arm() 尾部必须用推进后的 nextRunAt 挂表'
  );

  // M1：create/update 必须走 validateMaxRuns
  assert.match(managerSrc, /validateMaxRuns\(options\.maxRuns\)/, 'create 必须校验 maxRuns（M1）');
  assert.match(managerSrc, /validateMaxRuns\(patch\.maxRuns\)/, 'update 必须校验 maxRuns（M1）');

  // 2026-09-27 复审回归：once 执行失败不得消费槽位（否则提醒类任务失败即永久死亡，
  // 默认 missedPolicy=skip 下重新 enable 也救不回）
  const noneBlock = armSrc.slice(
    armSrc.indexOf("decision.action === 'none'"),
    armSrc.indexOf("decision.action === 'catch-up'")
  );
  assert.match(
    noneBlock,
    /task\.lastResult === 'error' && !this\.onceFailureRetried\.has\(task\.id\)/,
    'none+once 分支必须先判「失败且未重试过」再决定是否消费槽位'
  );
  assert.match(
    noneBlock,
    /Date\.now\(\) \+ ONCE_FAILURE_RETRY_MS/,
    '失败重试必须挂短延迟（5 分钟），不得 0 延迟重跑'
  );
  assert.match(noneBlock, /ONCE_FAILURE_RETRY_MS/, '引用重试延迟常量');
  // 成功/重新启用/改期清标记（enable 给全新机会）
  assert.match(managerSrc, /task\.lastResult = 'ok';\s*\n\s*task\.lastError = undefined;\s*\n\s*this\.onceFailureRetried\.delete\(task\.id\);/, '成功路径清失败重试标记');
  const enableBlock = managerSrc.slice(managerSrc.indexOf('enable(taskId: string)'), managerSrc.indexOf('disable(taskId: string)'));
  assert.match(enableBlock, /this\.onceFailureRetried\.delete\(taskId\)/, 'enable() 必须清失败重试标记（重新启用=全新机会）');
  // 改 schedule 清 delayMinutes 残留（互斥字段不得跨形态残留）
  assert.match(
    managerSrc,
    /if \(patch\.schedule !== undefined\) \{\s*\n\s*task\.delayMinutes = undefined;/,
    'update 显式改 schedule 时必须清 delayMinutes 残留'
  );

  // M2：UI 保存不得把 once 改写成 daily
  const serviceViewSrc = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'src', 'components', 'ServiceView.tsx'),
    'utf8'
  );
  assert.match(serviceViewSrc, /scheduleKind === 'once'/, 'ServiceView 必须识别 once');
  assert.match(
    serviceViewSrc,
    /scheduleKind === 'once'[\s\S]{0,200}def\?\.schedule/,
    'ServiceView 保存 once 时必须原样保留（M2）'
  );

  console.log('ok: C1/C2/M1/M2 回归（once 自停 / terminal 路径 runCount / validateMaxRuns / UI 保 once）');
}

console.log('tasks-schedule-a4: ok');
