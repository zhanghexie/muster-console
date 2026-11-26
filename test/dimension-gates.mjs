/**
 * R-14 一期·交验前置门：维度命中矩阵 / i18n 增量对账 / motion 静态检查 /
 * 红灯快照与看板过滤 / override 留痕格式 / 调度教学注入。
 * Run: node test/dimension-gates.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dimension-gates-'));
const compile = createSharedCompiler(root, tmp);

const dg = await import(pathToFileURL(compile('shared/dimensionGates.ts')).href);
const {
  i18nGateHit,
  motionGateHit,
  isLocaleFile,
  runI18nGate,
  runMotionGate,
  checkMotionConstantSync,
  splitUnifiedDiff,
  extractTCallKeys,
  extractLocaleKeys,
  hasRedGate,
  isDimensionGateRedSession,
  dimensionGateBadgeLabel,
  dimensionGateDetailText,
  dimensionGateOverrideNote,
  DIMENSION_GATE_OVERRIDE_PREFIX,
  parseDimensionGateConfig
} = dg;

/* ---------------- 1. 维度命中矩阵（路径 pattern） ---------------- */
assert.equal(i18nGateHit(['src/shared/i18n/locales/en.ts']), true);
assert.equal(i18nGateHit(['src/shared/i18n/locales/fragments/main.ts']), true);
assert.equal(i18nGateHit(['src\\shared\\i18n\\locales\\en.ts']), true, '反斜杠路径须归一');
assert.equal(i18nGateHit(['src/renderer/src/panels/BoardPanel.tsx']), true, '.ts/.tsx 改动产生 t() 检查面');
assert.equal(i18nGateHit(['src/renderer/src/styles/board.css']), false, '纯 CSS 不进 i18n 门');
assert.equal(i18nGateHit(['README.md']), false);

assert.equal(isLocaleFile('src/shared/i18n/locales/en.ts'), true);
assert.equal(isLocaleFile('src/shared/i18n/index.ts'), true);
assert.equal(isLocaleFile('src/main/sessions.ts'), false);

assert.equal(motionGateHit(['src/renderer/src/styles/board.css']), true);
assert.equal(motionGateHit(['styles\\left.css']), true);
assert.equal(motionGateHit(['src/renderer/src/components/motion.tsx']), true);
assert.equal(motionGateHit(['src/renderer/src/components/Motion.tsx']), false, '大小写敏感');
assert.equal(motionGateHit(['src/main/sessions.ts']), false);
assert.equal(motionGateHit([]), false);

/* ---------------- 2. diff 行解析 ---------------- */
const diffText = [
  'diff --git a/a.css b/a.css',
  'index 1..2 100644',
  '--- a/a.css',
  '+++ b/a.css',
  '@@ -1,2 +1,3 @@',
  ' .old {',
  '-  color: red;',
  '+  color: blue;',
  '+  transition: all 0.3s;'
].join('\n');
const split = splitUnifiedDiff(diffText);
assert.deepEqual(split.added, ['  color: blue;', '  transition: all 0.3s;']);
assert.deepEqual(split.removed, ['  color: red;']);
assert.deepEqual(splitUnifiedDiff('').added, []);

/* ---------------- 3. i18n 增量对账 ---------------- */
// zh 侧（源码新增 t() 调用）、en 侧（词条表）夹具
const i18nBase = {
  changedPaths: ['src/renderer/src/panels/Demo.tsx'],
  addedByFile: [
    { file: 'src/renderer/src/panels/Demo.tsx', lines: ["const a = t('已有词条');", "const b = t('全新词条');"] }
  ],
  localeKeys: ['已有词条']
};
const red1 = runI18nGate(i18nBase, 1);
assert.equal(red1.status, 'red', '新增 t() key 缺英文词条须红灯');
assert.equal(red1.id, 'i18n');
assert.equal(red1.problems.length, 1);
assert.match(red1.problems[0], /全新词条/);
assert.match(red1.problems[0], /Demo\.tsx/);

// 还原即红：把缺失词条补进词条表 → 绿；删掉 → 红
const green1 = runI18nGate({ ...i18nBase, localeKeys: ['已有词条', '全新词条'] }, 1);
assert.equal(green1.status, 'green', '词条补齐后应绿');
assert.deepEqual(green1.problems, []);

// locale 文件误删仍被引用的 key → 红；未被引用的删除 → 绿
const removedCase = {
  changedPaths: ['src/shared/i18n/locales/en.ts'],
  addedByFile: [{ file: 'src/shared/i18n/locales/en.ts', lines: [] }],
  removedByFile: [
    {
      file: 'src/shared/i18n/locales/en.ts',
      lines: ["  '还在用': 'Still used',", "  '没人用': 'Nobody uses',"]
    }
  ],
  usedKeys: ['还在用'],
  localeKeys: []
};
const red2 = runI18nGate(removedCase, 1);
assert.equal(red2.status, 'red', '删了仍被引用的词条须红灯');
assert.equal(red2.problems.length, 1);
assert.match(red2.problems[0], /还在用/);
const green2 = runI18nGate({ ...removedCase, usedKeys: [] }, 1);
assert.equal(green2.status, 'green', '删未被引用的词条不红');

// 多行 t( 调用：key 行与 t( 不在同一新增行也能抽到
const multiLine = runI18nGate(
  {
    changedPaths: ['src/renderer/src/panels/Demo.tsx'],
    addedByFile: [
      {
        file: 'src/renderer/src/panels/Demo.tsx',
        lines: ['  return (', "    <div>{t(", "      '跨行词条'", '    )}</div>', '  );']
      }
    ],
    localeKeys: []
  },
  1
);
assert.equal(multiLine.status, 'red', '跨行 t() 调用按合并文本抽取');
assert.match(multiLine.problems[0], /跨行词条/);

// 抽取纯函数：标识符前缀不算 t 调用（与 i18n-coverage 同源语义：`.t(` 前是点号不算前缀，照收）
assert.deepEqual(extractTCallKeys("xt('y'); bt('q'); t('z');"), ['z']);
assert.deepEqual(extractLocaleKeys(["  'k1': 'v',", '  "k2": "v",', '  notAKey']), ['k1', 'k2']);
assert.deepEqual(extractLocaleKeys([`const entries = { 'first': 'text with \\\"fake\\\": value', 'second': 'value' }; // 'ignored': 'comment'
/* 'ignored too': 'comment' */
'third': 'value',`]), ['first', 'second', 'third']);
assert.deepEqual(extractLocaleKeys(["  '同一行一': 'one', '同一行二': 'two',"]), ['同一行一', '同一行二']);
const inlineRemoved = runI18nGate({
  changedPaths: ['src/shared/i18n/locales/en.ts'], addedByFile: [],
  removedByFile: [{ file: 'src/shared/i18n/locales/en.ts', lines: ["'不使用': 'x', '仍引用': 'y',"] }],
  usedKeys: ['仍引用'], localeKeys: []
});
assert.equal(inlineRemoved.status, 'red', '同一行后续被删除且仍使用的词条也须拦截');
assert.match(inlineRemoved.problems[0], /仍引用/);

/* ---------------- 4. motion 静态检查 ---------------- */
const motionCase = (lines, extra = {}) =>
  runMotionGate(
    {
      changedPaths: ['src/renderer/src/styles/board.css'],
      addedByFile: [{ file: 'src/renderer/src/styles/board.css', lines }],
      ...extra
    },
    1
  );

assert.equal(motionCase(['  transition: all 0.3s ease;']).status, 'red', 'transition: all 违规');
assert.match(motionCase(['  transition: all 0.3s ease;']).problems[0], /transition: all/);
assert.equal(motionCase(['  transition: opacity 120ms var(--ease-out);']).status, 'red', '字面量时长违规');
assert.equal(motionCase(['  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);']).status, 'red', 'cubic-bezier 违规');
assert.equal(motionCase(['  animation: spin 1s linear infinite;']).status, 'red', 'animation 字面量时长违规');
assert.equal(
  motionCase(['  transition: opacity var(--dur-fast) var(--ease-out);']).status,
  'green',
  'token 用法放行'
);
assert.equal(motionCase(['  --dur-fast: 120ms;']).status, 'green', 'token 定义行放行（本体必是字面量）');
assert.equal(motionCase(['  transition: none;']).status, 'green', '无时长字面量放行');
assert.equal(motionCase(['/* 注释 transition: all */']).status, 'green', '注释行跳过');

// MOTION 常量同步（motion.tsx 改动时）
const MOTION_OK = 'export const MOTION = {\n  microMs: 120,\n  exitMs: 200\n} as const;';
const MOTION_BAD = 'export const MOTION = {\n  microMs: 130,\n  exitMs: 200,\n  loopMs: 900\n} as const;';
const BASE_CSS = ':root {\n  --dur-micro: 120ms;\n  --dur-exit: 200ms;\n}';
assert.deepEqual(checkMotionConstantSync(MOTION_OK, BASE_CSS), [], '常量与 token 对齐');
const syncProblems = checkMotionConstantSync(MOTION_BAD, BASE_CSS);
assert.equal(syncProblems.length, 2, '值不一致 + 无对应 token 各一条');
assert.match(syncProblems.join('\n'), /microMs=130/);
assert.match(syncProblems.join('\n'), /loopMs/);

const motionSyncRed = motionCase(['  color: red;'], {
  changedPaths: ['src/renderer/src/components/motion.tsx'],
  motionTsxChanged: true,
  motionTsx: MOTION_BAD,
  baseCss: BASE_CSS
});
assert.equal(motionSyncRed.status, 'red', 'motion.tsx 改动触发常量同步检查');
assert.match(motionSyncRed.problems.join('\n'), /microMs=130/);

/* ---------------- 5. 快照聚合 / 看板过滤 ---------------- */
const snapshot = {
  at: 1,
  trigger: 'needs_you',
  results: [
    { id: 'i18n', status: 'green', checkedFiles: [], problems: [] },
    { id: 'motion', status: 'red', checkedFiles: ['a.css'], problems: ['a.css x'] }
  ]
};
assert.equal(hasRedGate(snapshot), true);
assert.equal(hasRedGate(undefined), false);
assert.equal(hasRedGate({ at: 1, trigger: 'needs_you', results: [] }), false);
assert.match(dimensionGateBadgeLabel(snapshot), /维度门未过：动画/);
assert.match(dimensionGateDetailText(snapshot), /- a\.css x/);
assert.equal(dimensionGateBadgeLabel(undefined), '');

const sess = (extra = {}) => ({
  id: 'aaaaaaaa-1111-4222-8333-444444444444',
  type: 'terminal',
  name: 'R14',
  createdAt: 1,
  launchKind: 'agent',
  lifecycle: 'idle',
  status: 'running',
  phase: { value: 'needs_you', source: 'model', ts: 1 },
  ...extra
});
assert.equal(isDimensionGateRedSession(sess({ dimensionGates: snapshot })), true);
assert.equal(isDimensionGateRedSession(sess({ dimensionGates: snapshot, phase: { value: 'idle', source: 'model', ts: 1 } })), false, '非 needs_you 不算被门挡');
assert.equal(isDimensionGateRedSession(sess()), false, '无门结果不算');
assert.equal(isDimensionGateRedSession(sess({ dimensionGates: { at: 1, trigger: 'needs_you', results: [snapshot.results[0]] } })), false, '纯绿不算');

const {
  gatedFromNeedsYouColumn,
  isNeedsYouPeekSession
} = await import(pathToFileURL(compile('shared/boardReview.ts')).href);
assert.equal(gatedFromNeedsYouColumn(sess({ dimensionGates: snapshot })), true);
assert.equal(gatedFromNeedsYouColumn(sess()), false);
assert.equal(isNeedsYouPeekSession(sess({ dimensionGates: snapshot }), 10), false, '红灯不进探出条');
assert.equal(isNeedsYouPeekSession(sess(), 10), true, '无红灯照常探出');

/* ---------------- 6. override 留痕 + 配置骨架 ---------------- */
assert.equal(dimensionGateOverrideNote(''), DIMENSION_GATE_OVERRIDE_PREFIX);
assert.match(dimensionGateOverrideNote('en 缺 key: a, b'), /^dimension-gate-override：en 缺 key/);
assert.ok(dimensionGateOverrideNote('x'.repeat(300)).length <= DIMENSION_GATE_OVERRIDE_PREFIX.length + 1 + 160);

assert.deepEqual(parseDimensionGateConfig({ disabled: ['i18n'] }).disabled, ['i18n']);
assert.deepEqual(parseDimensionGateConfig({ disabled: ['nope', 'motion'] }).disabled, ['motion'], '未知维度忽略');
assert.deepEqual(parseDimensionGateConfig(null).disabled, []);
assert.deepEqual(parseDimensionGateConfig({}).disabled, []);
assert.deepEqual(parseDimensionGateConfig('{bad json').disabled, []);

/* ---------------- 7. 调度教学注入（对齐 integrate-approval 提示词测试先例） ---------------- */
{
  const { buildDefaultDispatcherAppendBody } = await import(
    pathToFileURL(compile('main/agent/systemPrompt.ts')).href
  );
  const body = buildDefaultDispatcherAppendBody();
  assert.match(body, /red dimension-gate light/, '调度正文须含交验前置门教学段');
  assert.match(body, /red dimension-gate light/,);
  assert.match(body, /sessions\.review decision=rejected/);
  assert.match(body, /force acceptance/);
  assert.match(body, /self-check the usual dimensions/, '教学段须引导验收前自查编译/测试/规约');
}

/* ---------------- 8. 宿主接线（源码守卫；还原即红：删掉接线断言即失败） ---------------- */
const sessionsSrc = fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8');
assert.match(sessionsSrc, /needs_you' && s\.orchestrated === true/, '门只在编排会话 needs_you 触发（手工会话不进门）');
assert.match(sessionsSrc, /this\.scheduleDimensionGates\(s\)/, 'setPhase 须调度维度门');
assert.match(sessionsSrc, /collectDimensionGates/, '改动收集走 runner');
assert.match(sessionsSrc, /s\.dimensionGates = snapshot/, '结果须落会话 meta');
assert.match(sessionsSrc, /noteDimensionGateRed\(/, '红灯须入队编排事件通知调度');
assert.match(sessionsSrc, /DIM_GATE_COOLDOWN_MS/, '重复上报须冷却去重');

const hostsSrc = fs.readFileSync(
  path.join(root, 'src/main/capabilities/hosts/sessions.ts'),
  'utf8'
);
const blockIdx = hostsSrc.indexOf("if (args.decision === 'passed')");
const gateIdx = hostsSrc.indexOf('skipDimensionGate !== true');
const overrideIdx = hostsSrc.indexOf('dimensionGateOverrideNote(');
assert.ok(blockIdx >= 0 && gateIdx > blockIdx, 'passed 分支须先做维度门硬阻断判定');
assert.ok(overrideIdx > blockIdx, '强制验收须留 override 痕');
assert.match(hostsSrc, /clearDimensionGates\(s\.id\)/, '打回/验收后须清门结果（下次 needs_you 重跑）');

const eventsSrc = fs.readFileSync(path.join(root, 'src/main/orchestrator/events.ts'), 'utf8');
assert.match(eventsSrc, /noteDimensionGateRed/, '编排事件泵须有红灯通知入口');
assert.match(eventsSrc, /dim_gate_red/, '事件 kind 须为 dim_gate_red');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] dimension-gates');
