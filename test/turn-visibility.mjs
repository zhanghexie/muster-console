/**
 * A4 轮级工具可见性（zcode-adoption-plan A4）：
 * 1) shared/turnVisibility 纯映射全分支（三回合类型 + fail-open 边界）；
 * 2) 与 catalog 真实工具面对账（隐藏面覆盖 / 保留面不误伤 / 组级地图联动过滤）；
 * 3) 接线源码锚守卫（还原转红：把 piProvider 的接线摘掉，第 6 节即红）。
 * 运行: node test/turn-visibility.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-visibility-'));
const compile = createSharedCompiler(root, tmp);

const turnVisibility = await import(
  pathToFileURL(compile('shared/turnVisibility.ts')).href
);
const {
  resolveTurnHiddenTools,
  schedulerTurnKindFromTurnScope,
  catalogGroupOf,
  isToolDefHidden,
  hiddenToolNames
} = turnVisibility;

// ---------- 1) 回合类型标签映射（runPiTurn 作用域 → 调度回合类型） ----------
assert.equal(schedulerTurnKindFromTurnScope('user'), 'interactive');
assert.equal(schedulerTurnKindFromTurnScope('headless'), 'prompt-task');
assert.equal(schedulerTurnKindFromTurnScope('host'), 'event-wake');
assert.equal(schedulerTurnKindFromTurnScope(undefined), 'interactive', '缺省=用户对话轮');
console.log('ok  1) turnKind → SchedulerTurnKind 映射');

// ---------- 2) 过滤映射全分支 ----------
const empty = (h) => h.groups.length === 0 && h.tools.length === 0;
assert.ok(empty(resolveTurnHiddenTools('interactive')), '交互轮全量');
assert.ok(empty(resolveTurnHiddenTools('event-wake')), '事件唤醒轮不裁（共享会话防缓存打穿）');
assert.ok(empty(resolveTurnHiddenTools('unknown-kind')), '未知类型 fail-open');
assert.ok(empty(resolveTurnHiddenTools(undefined)), '缺省 fail-open');
assert.ok(empty(resolveTurnHiddenTools(null)), 'null fail-open');
assert.ok(empty(resolveTurnHiddenTools('')), '空串 fail-open');

const pt = resolveTurnHiddenTools('prompt-task');
assert.ok(!empty(pt), 'prompt-task 轮有裁剪');
// 定时任务写组整组隐藏（防递归自建，D8 核心）
for (const g of ['automations', 'runtimes', 'llm', 'offPeak']) {
  assert.ok(pt.groups.includes(g), `prompt-task 整组隐藏 ${g}`);
}
// 派活/合入/任务表写定点隐藏
for (const name of [
  'sessions.create',
  'sessions.integrate',
  'sessions.requestIntegrate',
  'sessions.message',
  'sessions.review'
]) {
  assert.ok(pt.tools.includes(name), `prompt-task 定点隐藏 ${name}`);
}
console.log('ok  2) 三回合类型 × 过滤映射（含 fail-open 边界）');

// ---------- 3) 纯函数工具级判定 ----------
assert.equal(catalogGroupOf('sessions.observe'), 'sessions');
assert.equal(catalogGroupOf('intent'), 'intent', '无点号裸名自成一组');
assert.equal(isToolDefHidden({ name: 'automations.create' }, pt), true, '组命中');
assert.equal(isToolDefHidden({ name: 'sessions.create' }, pt), true, '定点命中');
assert.equal(isToolDefHidden({ name: 'sessions.observe' }, pt), false, '保读');
assert.equal(isToolDefHidden({ name: 'ext.demo.ping' }, pt), false, 'ext.* 动态工具不裁');
const expanded = hiddenToolNames(
  [{ name: 'automations.runNow' }, { name: 'tasks.list' }, { name: 'sessions.message' }],
  pt
);
assert.deepEqual(expanded, ['automations.runNow', 'sessions.message'], '展开=组内命中+定点，去重保序');

// Bug A 注册面：八域 run 入口归入其域组；隐藏面裁到域内任一定点动词 → 入口整体隐藏
// （入口 schema 枚举全部 action，注册面无法按 action 拆分——保住入口即放回被裁动词）
assert.equal(catalogGroupOf('workflow.run'), 'workflow', '常规入口前缀即域组');
assert.equal(catalogGroupOf('dispatch.run'), 'runs', '改名入口（runs.* 域）归入真实域组');
assert.equal(isToolDefHidden({ name: 'workflow.run' }, pt), true, 'workflow.run 整体隐藏（域内 start/reply/askHuman/cancel 被裁）');
for (const name of ['automations.run', 'runtimes.run', 'llm.run']) {
  assert.equal(isToolDefHidden({ name }, pt), true, `整组隐藏域的入口随组隐藏 ${name}`);
}
for (const name of ['browser.run', 'themes.run', 'dispatch.run', 'extensions.run']) {
  assert.equal(isToolDefHidden({ name }, pt), false, `未裁域入口不误伤 ${name}`);
}
assert.equal(isToolDefHidden({ name: 'workflow.list' }, pt), false, '读动词本身不在隐藏面（执行面按真实目标另复核写动词）');
assert.equal(
  isToolDefHidden({ name: 'dispatch.run' }, { groups: [], tools: ['runs.delegate'] }),
  true,
  '改名域内定点动词被裁 → 入口整体隐藏'
);
console.log('ok  3) catalogGroupOf / isToolDefHidden / hiddenToolNames（含 run 入口归组）');

// ---------- 4) 与真实 catalog 对账（隐藏覆盖 + 保留不误伤） ----------
const catalog = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);
const allDefs = catalog.TOOL_DEFS;
const hiddenNames = new Set(hiddenToolNames(allDefs, pt));
const visible = allDefs.filter((d) => !hiddenNames.has(d.name));

// 整组隐藏的组在 catalog 里真实存在且被全组覆盖（组名漂移即红）
for (const g of pt.groups) {
  const inGroup = allDefs.filter((d) => catalogGroupOf(d.name) === g);
  if (g === 'offPeak') continue; // 占位组：本仓暂无，见 turnVisibility 注释
  assert.ok(inGroup.length > 0, `隐藏组 ${g} 在 catalog 中存在（组改名须同步映射）`);
  assert.ok(
    inGroup.every((d) => hiddenNames.has(d.name)),
    `隐藏组 ${g} 全组覆盖`
  );
}
// 计划保留面：读 + 管道/事实/事件
for (const name of [
  'sessions.observe',
  'sessions.observe',
  'sessions.search',
  'sessions.observe',
  'sessions.readMessages',
  'sessions.setStatus',
  'sessions.observe',
  'events.subscribe',
  'events.unsubscribe',
  'events.register',
  'events.emit',
  'events.review'
]) {
  assert.ok(visible.some((d) => d.name === name), `保留 ${name}（prompt-task 轮不得误伤）`);
}
// Bug A 注册面：被裁动词的 run 入口必须进 excludeTools 展开名单（piProvider 两处
// 注册面消费 hiddenToolNames/isToolDefHidden——入口不隐藏则被裁动词经 action 复活）
assert.ok(hiddenNames.has('workflow.run'), 'workflow.run 进隐藏展开名单（入口整体排除）');
assert.ok(!hiddenNames.has('workflow.list'), '读动词不在 prompt-task 隐藏面');
console.log('ok  4) prompt-task 隐藏/保留面与 catalog 对账');

// ---------- 5) 附录联动过滤（A6 后 dynamic 段=白名单全文条目 + 指引，无组行） ----------
const full = catalog.catalogAppendixText();
const pruned = catalog.catalogAppendixText(pt);
// A6 后组级地图本体撤出 system prompt（组职责走 Available tools 行内标注），附录里
// 任何回合类型都不该再出现组行——这是新现实的钉子，组行回归即红
assert.doesNotMatch(full, /\[services\] \d+ 个工具/, '组行已从 system prompt 撤出（A6）');
assert.match(full,/mcp\.search/);
assert.match(full,/mcp\.call/);
assert.doesNotMatch(pruned, /\[services\]/, '被裁组不出现在附录任何形态里');
assert.doesNotMatch(pruned, /- tasks\.delegate：/, '定点被裁工具从白名单行消失');
assert.doesNotMatch(pruned, /- chat\.injectBrief：/);
assert.ok(pruned.includes('call them directly'), '指引行保留（被裁场景不空段）');
console.log('ok  5) catalogAppendixText 按隐藏面过滤 + 组行恒不在 system prompt');

// ---------- 6) 接线源码锚守卫（还原转红） ----------
// 自查方式：把 piProvider 里 A4 接线摘掉（schedulerTurnKind/turnHidden/excludeTools/
// 注册投影任一拆掉，或 systemPrompt 不再把 hiddenTools 传给组级地图），本节即红。
// 源码文本锚是最接近「链路接线」的可离线守卫（真会话依赖 electron/模型，同 compact-breaker 口径）。
const piSrc = fs.readFileSync(path.join(root, 'src/main/agent/providers/piProvider.ts'), 'utf8');
assert.ok(
  piSrc.includes('schedulerTurnKindFromTurnScope(') &&
    piSrc.includes("args.headless ? 'headless' : 'user'"),
  '会话创建处必须经 schedulerTurnKindFromTurnScope 打回合类型标签（词表对齐单源）'
);
assert.ok(
  !piSrc.includes("args.headless ? 'prompt-task' : 'interactive'"),
  '不得绕过词表对齐函数在会话创建处内联硬编码回合类型'
);
assert.ok(
  piSrc.includes('const turnHidden = resolveTurnHiddenTools(schedulerTurnKind);'),
  '回合类型必须经 resolveTurnHiddenTools 映射为隐藏面'
);
assert.ok(
  piSrc.includes('...(excludedApiTools.length > 0 ? { excludeTools: excludedApiTools } : {}),'),
  'pi createAgentSession 必须按隐藏面传 excludeTools'
);
assert.ok(
  piSrc.includes('schedulerProjectedCatalog(hidden)') && piSrc.includes('for (const def of ordered) registerOne(def)'),
  '工具注册面必须与隐藏面同源收窄（经 schedulerProjectedCatalog 投影后注册）'
);
assert.ok(
  piSrc.includes('hiddenTools: turnHidden'),
  'Catalog 附录必须与工具面同源过滤（system prompt 不宣传被裁工具）'
);
const spSrc = fs.readFileSync(path.join(root, 'src/main/agent/systemPrompt.ts'), 'utf8');
assert.ok(
  spSrc.includes('buildCatalogAppendix(opts?.hiddenTools)'),
  'Catalog 附录必须接收隐藏面'
);
// Bug A 执行面（双层第二层）：run 展开出真实目标后按当前回合隐藏面复核。
// 自查方式：把 executor 里 currentSchedulerTurnHidden 复核块撤掉，本组即红
// （行为级断言在 test/scheduler-hidden-tools.mjs）。
const execSrc = fs.readFileSync(path.join(root, 'src/main/capabilities/executor.ts'), 'utf8');
assert.ok(
  execSrc.includes('const turnHidden = currentSchedulerTurnHidden();') &&
    execSrc.includes('isToolDefHidden({ name: dotName }, turnHidden)'),
  'executor 必须在 run 展开/直调路径上按当前回合隐藏面复核生效名'
);
assert.ok(
  execSrc.includes("schedulerTurnKindFromTurnScope('headless')"),
  'executor 回合类型必须经词表对齐单源推导，不得内联硬编码'
);
console.log('ok  6) piProvider/systemPrompt/executor 接线源码锚');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] turn-visibility');
