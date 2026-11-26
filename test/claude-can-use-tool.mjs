/**
 * Claude native canUseTool and the Core tool-policy matrix：
 * - 决策表全档位 × Claude 工具类（Read/Write/Bash/MCP/动态/status）
 * - Native choices, exact permission updates, timeout and cancellation
 * 运行: node test/claude-can-use-tool.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-can-use-tool-'));
const compile = createSharedCompiler(root, tmp);

const policyOut = compile('main/agentSession/tools/policy.ts');
const canOut = compile('main/agentSession/drivers/claude/canUseTool.ts');
const { decideToolCallPermission, classifyToolName } = await import(pathToFileURL(policyOut).href);
const { createClaudeCanUseTool } = await import(pathToFileURL(canOut).href);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ws-'));
fs.writeFileSync(path.join(cwd, 'in.txt'), 'x');

const hostToolIds = ['sessions.setStatus', 'bgtasks.shell'];
const hostClassOf = (id) => (id === 'bgtasks.shell' ? 'shell' : 'status');

const decide = (mode, engineToolName, input = {}, planExecuting = false) =>
  decideToolCallPermission({
    mode,
    planExecuting,
    engineToolName,
    input,
    cwd,
    hostToolIds,
    hostClassOf,
    userRules: []
  }).decision;

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};

console.log('\n—— 分类：Claude PascalCase / mcp / 动态 ——');
check('Read/Write/Bash/TodoWrite/ExitPlanMode', () => {
  assert.equal(classifyToolName('Read', hostToolIds, hostClassOf), 'read');
  assert.equal(classifyToolName('Write', hostToolIds, hostClassOf), 'edit');
  assert.equal(classifyToolName('Edit', hostToolIds, hostClassOf), 'edit');
  assert.equal(classifyToolName('MultiEdit', hostToolIds, hostClassOf), 'edit');
  assert.equal(classifyToolName('Bash', hostToolIds, hostClassOf), 'shell');
  assert.equal(classifyToolName('TodoWrite', hostToolIds, hostClassOf), 'status');
  assert.equal(classifyToolName('ExitPlanMode', hostToolIds, hostClassOf), 'status');
  assert.equal(classifyToolName('Glob', hostToolIds, hostClassOf), 'read');
  assert.equal(classifyToolName('Grep', hostToolIds, hostClassOf), 'read');
});
check('mcp__* → mcp；未知 fail-closed prompt', () => {
  assert.equal(classifyToolName('mcp__github__create_issue', hostToolIds, hostClassOf), 'mcp');
  assert.equal(classifyToolName('mcp__github__list_issues', hostToolIds, hostClassOf), 'mcp');
  assert.equal(classifyToolName('MysteryTool', hostToolIds, hostClassOf), null);
  assert.equal(decide('default', 'MysteryTool', {}), 'prompt');
});
check('Pi 驼峰名仍命中（webSearch/askQuestion）', () => {
  assert.equal(classifyToolName('webSearch', hostToolIds, hostClassOf), 'read');
  assert.equal(classifyToolName('askQuestion', hostToolIds, hostClassOf), 'status');
});

const modes = [
  ['default', false],
  ['ask', false],
  ['plan', false],
  ['plan', true],
  ['auto', false]
];

console.log('\n—— 决策表：档位 × 工具类 ——');
const matrix = [
  // [tool, input, expected by mode key]
  ['Read', { file_path: path.join(cwd, 'in.txt') }, { default: 'auto', ask: 'auto', plan: 'auto', 'plan+exec': 'auto', auto: 'auto' }],
  ['Write', { file_path: path.join(cwd, 'in.txt') }, { default: 'auto', ask: 'deny', plan: 'deny', 'plan+exec': 'auto', auto: 'auto' }],
  ['Write', { file_path: path.join(os.tmpdir(), 'outside.txt') }, { default: 'prompt', ask: 'deny', plan: 'deny', 'plan+exec': 'prompt', auto: 'auto' }],
  ['Bash', { command: 'git status' }, { default: 'auto', ask: 'auto', plan: 'auto', 'plan+exec': 'auto', auto: 'auto' }],
  ['Bash', { command: 'npm install' }, { default: 'auto', ask: 'deny', plan: 'deny', 'plan+exec': 'auto', auto: 'auto' }],
  ['TodoWrite', { todos: [] }, { default: 'auto', ask: 'auto', plan: 'auto', 'plan+exec': 'auto', auto: 'auto' }],
  ['mcp__github__list_issues', {}, { default: 'auto', ask: 'auto', plan: 'auto', 'plan+exec': 'auto', auto: 'auto' }],
  ['mcp__github__create_issue', {}, { default: 'prompt', ask: 'deny', plan: 'deny', 'plan+exec': 'prompt', auto: 'auto' }],
  ['ext.pack.run', {}, { default: 'prompt', ask: 'deny', plan: 'deny', 'plan+exec': 'prompt', auto: 'auto' }]
];

for (const [tool, input, expected] of matrix) {
  check(`${tool} ${JSON.stringify(input.command || input.file_path || tool).slice(0, 40)}`, () => {
    for (const [mode, planExecuting] of modes) {
      const key = mode === 'plan' && planExecuting ? 'plan+exec' : mode;
      const got = decide(mode, tool, input, planExecuting);
      assert.equal(got, expected[key], `${mode}${planExecuting ? '+exec' : ''} 期望 ${expected[key]} 实得 ${got}`);
    }
  });
}

console.log('\n—— canUseTool 回放 ——');
const options = (extra = {}) => ({ toolUseID: 'native-tool', signal: new AbortController().signal, ...extra });
const canUse = (requestApproval, extra = {}) => createClaudeCanUseTool({ cwd, hostToolIds, hostClassOf, requestApproval, ...extra });

await checkAsync('native callback keeps exact once and persistent permission choices', async () => {
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'projectSettings' }];
  const approval = canUse(async req => {
    assert.equal(req.toolCallId, 'native-tool');
    assert.equal(req.nativeSource, 'Claude Code');
    assert.deepEqual(req.nativeChoices.map(choice => choice.id), ['allow', 'updatedPermissions', 'deny']);
    assert.equal(req.nativeChoices[1].scope, 'persistent');
    assert.match(req.nativeChoices[1].description, /projectSettings.*Read/);
    return { approved: true, nativeChoiceId: 'updatedPermissions' };
  });
  const result = await approval('Read', { file_path: path.join(cwd, 'in.txt') }, options({ suggestions }));
  assert.equal(result.behavior, 'allow');
  assert.equal(result.updatedPermissions, suggestions);
  assert.equal(result.toolUseID, 'native-tool');
});

await checkAsync('Claude asks for host MCP permission when the SDK requests a decision', async () => {
  const tool = canUse(async req => {
    assert.equal(req.toolName, 'mcp__muster__bgtasks_shell');
    return { approved: false, nativeChoiceId: 'deny', reason: 'User rejected this execution' };
  });
  assert.deepEqual(await tool('mcp__muster__bgtasks_shell', { command: 'npm test' }, options()), {
    behavior: 'deny', message: 'User rejected this execution', toolUseID: 'native-tool'
  });
});

await checkAsync('timeout and cancellation settle only the pending native request', async () => {
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const pending = canUse((_req, signal) => {
      assert.equal(signal.aborted, false);
      return new Promise(() => {});
    }, { timeoutMs: 20 });
    assert.equal((await pending('Read', {}, options())).behavior, 'deny');
    const controller = new AbortController();
    const request = pending('Read', {}, options({ signal: controller.signal }));
    controller.abort();
    assert.equal((await request).behavior, 'deny');
  } finally { clearTimeout(keepAlive); }
});

await checkAsync('a reply from another turn cannot grant the native tool', async () => {
  let turn = 'first';
  const approval = canUse(async () => {
    turn = 'next';
    return { approved: true, nativeChoiceId: 'allow' };
  }, { getTurnId: () => turn });
  assert.equal((await approval('Read', {}, options())).behavior, 'deny');
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log('\nclaude-can-use-tool 全绿');
