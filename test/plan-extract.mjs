/**
 * planExtract 行为自测：正文提取（Plan:/计划标题 + 编号/复选框步骤 + 块边界）、
 * 工具提交识别（createPlan 等计划类工具名与参数解析）、[DONE:n] 进度标记。
 * 运行: node test/plan-extract.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-extract-'));

// planExtract.ts 零运行时依赖（types 仅 type-only 导入会被擦除），单独转译即可
const entry = path.join(root, 'src/shared/planExtract.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
fs.writeFileSync(path.join(tmp, 'planExtract.mjs'), outputText);

const {
  extractPlan,
  extractPlanStepsLoose,
  markCompletedSteps,
  isPlanToolName,
  planMarkdownFromInput,
  firstPlanHeading
} = await import(pathToFileURL(path.join(tmp, 'planExtract.mjs')).href);

// ── extractPlan：经典「Plan:」正文约定 ──
{
  const text = [
    '我看完了代码，思路如下。',
    '',
    'Plan:',
    '1. 先补测试',
    '2) 再改实现',
    '3. 更新文档',
    '',
    '以上。'
  ].join('\n');
  const p = extractPlan(text);
  assert.ok(p, 'Plan: 块应提取成功');
  assert.equal(p.markdown, 'Plan:\n1. 先补测试\n2) 再改实现\n3. 更新文档');
  assert.deepEqual(
    p.steps.map((s) => s.text),
    ['先补测试', '再改实现', '更新文档']
  );
  assert.deepEqual(
    p.steps.map((s) => s.step),
    [1, 2, 3]
  );
  assert.ok(p.steps.every((s) => !s.completed));
}

// ── extractPlan：「## 计划：xxx」标题 + 复选框 + ### 步骤小节 ──
{
  const text = [
    '前言。',
    '## 计划：认证重构',
    '',
    '目标：把登录逻辑收进一个模块。',
    '### 1. 梳理现状',
    '### 2. 抽出 authService',
    '- [x] 已确认调用方清单',
    '- [ ] 迁移调用点',
    '',
    '## 风险',
    '这里不该算进计划块。'
  ].join('\n');
  const p = extractPlan(text);
  assert.ok(p, '## 计划：标题应识别');
  assert.ok(p.markdown.startsWith('## 计划：认证重构'), '块含标题行');
  assert.ok(!p.markdown.includes('这里不该算进计划块'), 'h2 新节终止计划块');
  assert.equal(p.steps.length, 4);
  assert.equal(p.steps[0].text, '梳理现状');
  assert.equal(p.steps[2].completed, true, '[x] 复选框视为已完成');
  assert.equal(p.steps[3].completed, false);
}

// ── extractPlan：无标题 / 有标题无步骤 → null ──
{
  assert.equal(extractPlan('就是普通回复，没有计划。'), null);
  assert.equal(extractPlan('Plan:\n这里只有一句话说明，没有编号步骤。'), null);
  // 正文里的 plan 单词不在行首，不触发
  assert.equal(extractPlan('the plan is described in plan.md\n1. 这步会被误提吗'), null);
}

// ── extractPlan：分隔线终止计划块；块内说明行保留 ──
{
  const text = ['Plan:', '1. 第一步要做的事情', '说明：先跑基线测试。', '2. 第二步要做的事情', '---', '分隔线之后不属于计划。'].join('\n');
  const p = extractPlan(text);
  assert.ok(p);
  assert.ok(!p.markdown.includes('分隔线之后'), '--- 分隔线终止块');
  assert.ok(p.markdown.includes('说明：先跑基线测试。'), '步骤之间的说明行保留');
  assert.equal(p.steps.length, 2);
}

// ── extractPlan：多个计划块只取第一个（正文提取的既定语义，与防重复挂卡口径一致）──
{
  const text = [
    'Plan:',
    '1. 第一版计划的步骤事项',
    '',
    '## 修订版',
    '',
    'Plan:',
    '1. 第二版计划的步骤事项'
  ].join('\n');
  const p = extractPlan(text);
  assert.ok(p);
  assert.ok(p.markdown.includes('第一版计划'), '取第一个计划块');
  assert.ok(!p.markdown.includes('第二版计划'), '后续计划块不进卡');
  assert.equal(p.steps.length, 1);
}

// ── extractPlan：标题前缀松匹配（无冒号也命中）——已知边界钉桩（与旧实现持平）──
{
  const p = extractPlan(['Plan B 方案说明', '1. 备选方案的步骤事项'].join('\n'));
  assert.ok(p, '「Plan B」行首松匹配会命中（有意取舍：模型标题写法多变）');
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].text, '备选方案的步骤事项');
}

// ── extractPlanStepsLoose：星号复选框 / 上限 20 步截断 ──
{
  const steps = extractPlanStepsLoose('* [X] 已完成的步骤事项\n* [ ] 未完成的步骤事项');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].completed, true);
  const many = Array.from({ length: 25 }, (_, i) => `${i + 1}. 第${i + 1}步要做的事情`).join('\n');
  assert.equal(extractPlanStepsLoose(many).length, 20, '步骤上限 20');
}

// ── extractPlanStepsLoose：工具提交的计划全文（无标题行也能提步骤）──
{
  const plan = ['# Auth Refactor', '', 'Steps:', '1. add tests', '2. extract module'].join('\n');
  const steps = extractPlanStepsLoose(plan);
  assert.equal(steps.length, 2);
  assert.deepEqual(
    steps.map((s) => s.text),
    ['add tests', 'extract module']
  );
  assert.equal(extractPlanStepsLoose('没有可提取步骤的纯文本。').length, 0);
}

// ── markCompletedSteps：[DONE:n] 勾选 ──
{
  const steps = extractPlanStepsLoose('1. 第一步要做的事情\n2. 第二步要做的事情');
  assert.equal(markCompletedSteps('好了 [DONE:1]', steps), true);
  assert.equal(steps[0].completed, true);
  assert.equal(steps[1].completed, false);
  assert.equal(markCompletedSteps('无标记', steps), false);
  assert.equal(markCompletedSteps('[DONE:1] 重复标记', steps), false, '已完成步骤不再变更');
}

// ── isPlanToolName：cursor createPlan 与常见别名/误拼 ──
for (const name of ['createPlan', 'create_plan', 'CREATE PLAN', 'creatplan', 'create-plan', 'exit_plan_mode', 'submit_plan']) {
  assert.ok(isPlanToolName(name), `计划类工具 ${name} 应识别`);
}
for (const name of ['read_file', 'grep', 'bash', 'askQuestion', 'updateTodos']) {
  assert.ok(!isPlanToolName(name), `非计划工具 ${name} 不应误判`);
}

// ── planMarkdownFromInput：cursor createPlan { plan } 形状 ──
{
  const md = '# 重构计划\n\n1. 第一步：梳理现有调用方并补齐回归测试\n2. 第二步：抽出 authService 模块并迁移调用点';
  assert.equal(planMarkdownFromInput({ plan: md }), md);
  assert.equal(planMarkdownFromInput({ markdown: md }), md);
  assert.equal(
    planMarkdownFromInput({ plan: `${md}（plan 字段优先）`, markdown: md }),
    `${md}（plan 字段优先）`,
    'plan/markdown/content/text 按序优先'
  );
  assert.equal(planMarkdownFromInput({ note: '短备注', body: md }), md, '回落首个够长字符串字段');
  assert.equal(planMarkdownFromInput({ plan: '太短' }), null, '过短不算计划');
  assert.equal(planMarkdownFromInput(null), null);
  assert.equal(planMarkdownFromInput('字符串不是对象'), null);
}

// ── firstPlanHeading：工具卡友好标题 ──
{
  assert.equal(firstPlanHeading('# 重构计划\n\n正文'), '重构计划');
  assert.equal(firstPlanHeading('没有标题的文本'), null);
}

console.log('plan-extract: all assertions passed');
