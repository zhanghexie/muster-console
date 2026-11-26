/**
 * GUI Worker 用户工具规则（tool-rules.json）自测：
 * - 典型用例：deny rm -rf / git push --force；allow npm test
 * - 规则优先级（数组首条命中）
 * - deny 在 auto 档仍确定性拦截
 * - 与三档决策表叠加顺序（用户层 → 三档表；rewrite 后落入三档表）
 * - shell 参数匹配与 isReadOnlyShellCommand 同构（引号内危险词不误伤）
 * 运行: node test/gui-worker-tool-rules.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-tool-rules-'));

const compile = createSharedCompiler(root, tmp);
const guiWorkerPolicyOut = compile('shared/guiWorkerPolicy.ts');
const {
  normalizeGuiUserToolRules,
  parseGuiUserToolRulesJson,
  shellCommandMatchesParamPattern,
  matchUserToolRules,
  decideWithUserToolRules,
  decideToolPermission
} = await import(pathToFileURL(guiWorkerPolicyOut).href);

const policyOut = compile('main/agentSession/tools/policy.ts');
const { decideToolCallPermission, loadGuiUserToolRules } = await import(
  pathToFileURL(policyOut).href
);

const TYPICAL = normalizeGuiUserToolRules({
  version: 1,
  rules: [
    {
      id: 'deny-rm-rf',
      params: { command: 'rm -rf' },
      action: 'deny',
      reason: '禁止 rm -rf'
    },
    {
      id: 'deny-force-push',
      params: { command: 'git push --force' },
      action: 'deny',
      reason: '禁止 force push'
    },
    {
      id: 'allow-npm-test',
      params: { command: 'npm test' },
      action: 'allow'
    }
  ]
});

// ---------- 归一 / 解析 ----------
assert.equal(normalizeGuiUserToolRules(null).length, 0);
assert.equal(normalizeGuiUserToolRules({ rules: [{ action: 'nope' }] }).length, 0);
assert.equal(parseGuiUserToolRulesJson('{not-json').length, 0, '坏 JSON fail-open');
assert.equal(TYPICAL.length, 3);

// ---------- shell 模式同构：引号感知 ----------
assert.equal(shellCommandMatchesParamPattern('rm -rf /tmp/x', 'rm -rf'), true);
assert.equal(shellCommandMatchesParamPattern('sudo rm -rf /', 'rm -rf'), true);
assert.equal(
  shellCommandMatchesParamPattern("grep 'rm -rf' f", 'rm -rf'),
  false,
  '引号内危险词不命中'
);
assert.equal(
  shellCommandMatchesParamPattern('git push origin main --force', 'git push --force'),
  true,
  '有序子序列拦中间夹参的 force push'
);
assert.equal(shellCommandMatchesParamPattern('git push --force-with-lease', 'git push --force'), false);
assert.equal(shellCommandMatchesParamPattern('npm test -- --grep x', 'npm test'), true);

// ---------- 典型用例（纯函数层） ----------
{
  const denyRm = matchUserToolRules(TYPICAL, 'Bash', { command: 'rm -rf dist' });
  assert.equal(denyRm?.action, 'deny');
  assert.equal(denyRm?.rule.id, 'deny-rm-rf');

  const denyForce = matchUserToolRules(TYPICAL, 'bash', {
    command: 'git push --force origin main'
  });
  assert.equal(denyForce?.action, 'deny');
  assert.equal(denyForce?.rule.id, 'deny-force-push');

  const allowTest = matchUserToolRules(TYPICAL, 'Shell', { command: 'npm test' });
  assert.equal(allowTest?.action, 'allow');
}

// ---------- allow 链式命令：逐段全称（每个顶层段都须命中模式），堵链式提权 ----------
// （回归：allow 沿用 deny 的「段内子序列」宽松语义时，npm test && rm -rf x 会整链放行；
//   还原修复时本组「不放行 / 回落三档表」断言转红）
{
  const rules = normalizeGuiUserToolRules([
    { id: 'allow-npm', params: { command: '/^npm\\b/' }, action: 'allow' }
  ]);
  const base = (toolInput) =>
    decideToolPermission({
      mode: 'default',
      permissionClass: 'shell',
      shellCommand: String(toolInput.command ?? '')
    });
  assert.equal(
    matchUserToolRules(rules, 'Bash', { command: 'npm test && rm -rf x' }),
    null,
    'allow 规则不放行链式里的非命中段'
  );
  assert.equal(
    matchUserToolRules(rules, 'Bash', { command: 'rm -rf x && npm test' }),
    null,
    '顺序颠倒同样不放行'
  );
  assert.equal(
    matchUserToolRules(rules, 'Bash', { command: 'npm test && npm run build' })?.action,
    'allow',
    '全段命中才放行'
  );
  const decided = decideWithUserToolRules({
    rules,
    engineToolName: 'Bash',
    toolInput: { command: 'npm test && rm -rf x' },
    baseDecide: base
  });
  // 现行三档表：default 档 shell 自动放行（guiWorkerPolicy.ts「shell 自动放行」，仅显式用户规则另判）
  assert.equal(decided.decision, 'auto', '链式带非命中段回落三档表（default 档 shell=auto）');
  const denyChain = decideWithUserToolRules({
    rules: TYPICAL,
    engineToolName: 'Bash',
    toolInput: { command: 'npm test && rm -rf x' },
    baseDecide: base
  });
  assert.equal(denyChain.decision, 'deny', 'deny 宽松语义不动：链式里的 rm -rf 仍确定性拦');
}

// ---------- 规则优先级：首条命中 ----------
{
  const rules = normalizeGuiUserToolRules([
    { id: 'first-allow', params: { command: 'npm test' }, action: 'allow' },
    { id: 'second-deny', params: { command: 'npm test' }, action: 'deny' }
  ]);
  const hit = matchUserToolRules(rules, 'Bash', { command: 'npm test' });
  assert.equal(hit?.rule.id, 'first-allow', '数组顺序=优先级');
}

// ---------- deny 确定性：auto 档也拦 ----------
{
  const r = decideWithUserToolRules({
    rules: TYPICAL,
    engineToolName: 'Bash',
    toolInput: { command: 'rm -rf /' },
    baseDecide: () => 'auto'
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.ruleReason, '禁止 rm -rf');
}

// ---------- 与三档表叠加：allow 越过 default 的 shell prompt ----------
{
  const base = (toolInput) =>
    decideToolPermission({
      mode: 'default',
      permissionClass: 'shell',
      shellCommand: String(toolInput.command ?? '')
    });
  assert.equal(base({ command: 'npm test' }), 'auto', '无用户规则时 default 档 shell=auto');
  const allowed = decideWithUserToolRules({
    rules: TYPICAL,
    engineToolName: 'Bash',
    toolInput: { command: 'npm test' },
    baseDecide: base
  });
  assert.equal(allowed.decision, 'auto', 'allow 短路三档表');
}

// ---------- allow 越过 ask 只读门控 ----------
{
  const base = (toolInput) =>
    decideToolPermission({
      mode: 'ask',
      permissionClass: 'shell',
      shellCommand: String(toolInput.command ?? '')
    });
  assert.equal(base({ command: 'npm test' }), 'deny', 'ask 档 npm test 本为 deny');
  const allowed = decideWithUserToolRules({
    rules: TYPICAL,
    engineToolName: 'Bash',
    toolInput: { command: 'npm test' },
    baseDecide: base
  });
  assert.equal(allowed.decision, 'auto');
}

// ---------- ask 动作强制 prompt（即使 auto 档） ----------
{
  const rules = normalizeGuiUserToolRules([
    { params: { command: 'npm install' }, action: 'ask', reason: '装依赖需确认' }
  ]);
  const r = decideWithUserToolRules({
    rules,
    engineToolName: 'Bash',
    toolInput: { command: 'npm install' },
    baseDecide: () => 'auto'
  });
  assert.equal(r.decision, 'prompt');
  assert.equal(r.ruleReason, '装依赖需确认');
}

// ---------- rewrite 后落入三档表 ----------
{
  const rules = normalizeGuiUserToolRules([
    {
      id: 'strip-force',
      params: { command: 'git push --force' },
      action: 'rewrite',
      rewrite: { command: 'git push' }
    }
  ]);
  const r = decideWithUserToolRules({
    rules,
    engineToolName: 'Bash',
    toolInput: { command: 'git push --force origin main' },
    baseDecide: (toolInput) => {
      assert.equal(toolInput.command, 'git push');
      return decideToolPermission({
        mode: 'default',
        permissionClass: 'shell',
        shellCommand: String(toolInput.command)
      });
    }
  });
  assert.equal(r.decision, 'auto', 'rewrite 后落入三档表（default 档 shell=auto）');
  assert.equal(r.updatedInput.command, 'git push');
  assert.equal(r.ruleId, 'strip-force');
}

// ---------- enabled=false 跳过 ----------
{
  const rules = normalizeGuiUserToolRules([
    { params: { command: 'rm -rf' }, action: 'deny', enabled: false },
    { params: { command: 'rm -rf' }, action: 'allow' }
  ]);
  const hit = matchUserToolRules(rules, 'Bash', { command: 'rm -rf x' });
  assert.equal(hit?.action, 'allow');
}

// ---------- policy 接线：读盘 + 典型用例 ----------
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-rules-ws-'));
  const meta = path.join(cwd, '.muster');
  fs.mkdirSync(meta);
  fs.writeFileSync(
    path.join(meta, 'tool-rules.json'),
    JSON.stringify({ version: 1, rules: TYPICAL }, null, 2),
    'utf8'
  );
  assert.equal(loadGuiUserToolRules(cwd).length, 3);

  const hostClassOf = () => 'status';
  const denyRm = decideToolCallPermission({
    mode: 'auto',
    planExecuting: false,
    engineToolName: 'Bash',
    input: { command: 'rm -rf /' },
    cwd,
    hostToolIds: [],
    hostClassOf
  });
  assert.equal(denyRm.decision, 'deny', 'auto 档仍拦 rm -rf');
  assert.equal(denyRm.ruleReason, '禁止 rm -rf');

  const denyForce = decideToolCallPermission({
    mode: 'auto',
    planExecuting: false,
    engineToolName: 'command_execution',
    input: { command: 'git push --force' },
    cwd,
    hostToolIds: [],
    hostClassOf
  });
  assert.equal(denyForce.decision, 'deny');

  const allowNpm = decideToolCallPermission({
    mode: 'default',
    planExecuting: false,
    engineToolName: 'Bash',
    input: { command: 'npm test' },
    cwd,
    hostToolIds: [],
    hostClassOf
  });
  assert.equal(allowNpm.ruleId, 'allow-npm-test', '用户 allow 仍命中，不误判为用户拒绝');
  // rm 高危独立审查移入 safety 子系统，policy 层不再兜（本测试只锁 policy 层语义）
  assert.equal(allowNpm.decision, 'auto', '用户 allow 短路三档表；高危独立审查由 safety 子系统另行拦截');

  // 显式 [] 跳过读盘
  const noRules = decideToolCallPermission({
    mode: 'auto',
    planExecuting: false,
    engineToolName: 'Bash',
    input: { command: 'rm -rf /' },
    cwd,
    hostToolIds: [],
    hostClassOf,
    userRules: []
  });
  assert.equal(noRules.ruleId, undefined, 'userRules:[] 确实跳过读盘，不命中磁盘 deny');
  assert.equal(noRules.decision, 'auto', '移除用户 deny 后 policy 层放行；高危审查在 safety 子系统');
  const readonly = decideToolCallPermission({ mode:'ask', planExecuting:false, engineToolName:'Bash', input:{command:'rm -rf /'}, cwd, hostToolIds:[], hostClassOf, userRules:[] });
  assert.equal(readonly.decision,'deny','readonly 硬拒绝不能因安全审查变为prompt');
  const ordinary = decideToolCallPermission({ mode:'auto', planExecuting:false, engineToolName:'Bash', input:{command:'git status'}, cwd, hostToolIds:[], hostClassOf, userRules:[] });
  assert.equal(ordinary.decision,'auto','已知只读普通命令仍直接放行');
}

console.log('ok   gui-worker-tool-rules.mjs');
