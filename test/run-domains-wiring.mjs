/**
 * R3b 七域 run 化接线离线测试（tool-exposure-resident-run-skill-plan §3 R3）：
 * workflow / runtimes / automations / themes / dispatch（runs.* 改名）/ llm /
 * extensions 七域收敛为单入口 X.run({action, params})。
 * 七域是调度侧工具（不在 hostTools meta preset）：经 catalog 聚合对调度可达
 * （R5：调度面直调 executeTool('X.run')，executor 内展开真实目标），Worker 三面
 * （preset/PTY 白名单/入站 MCP）不新增暴露——
 * 故无 browser-run-tool.mjs 的三面投影断言，改为「不进任何 preset」的边界锁。
 * 1) 装配与枚举：聚合含 7 入口，extensions.run 信封 schema 唯一；
 * 2) 调度可达：executeTool 直调 run 入口 → executor 展开 → 真实目标 handler（替身记录），统计按真实 action；
 * 3) extensions.run 创作动作路由到原执行器，权限按解析后的真实动作评估；
 * 4) runRouter 纯函数展开：下划线/点号名、匿名剥伪造身份、未知 action；
 * 5) 未知 action / 参数错误经 executeTool：可纠正英文错误，不触达 handler。
 * 运行: node test/run-domains-wiring.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-domains-wiring-'));
const compile = createSharedCompiler(root, tmp);
const read = rel => import(pathToFileURL(compile(rel)).href);

// electron 桩包：turnShotCapture 顶层 import { app } from 'electron'（模块级不调用）
{
  const dir = path.join(tmp, 'node_modules', 'electron');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const app = { getPath: () => tmp };\n');
}

// 替身 host handler + 其余 host 桩空（同 test/browser-run-tool.mjs 手法）：
// R5：hosts/discovery 已删，全部 host 置桩（executor 内的 run 展开用真实实现）；八域 host 覆写为记录替身。
const SESSION_ACTIONS = ['select', 'recoverInterrupted', 'restartConversation', 'setModel', 'setThinking', 'setOrchestrated', 'setPinned'];
const RECORDER_HOSTS = {
  sessions: SESSION_ACTIONS.map(action => `sessions.${action}`),
  workflow: ['workflow.list'],
  runtimes: ['runtimes.list', 'runtimes.preflight'],
  services: ['automations.list'],
  themes: ['themes.list', 'themes.activate'],
  cliRuns: ['runs.delegate', 'runs.progress', 'runs.deliver'],
  llm: ['llm.listProviders', 'llm.testConnection'],
  extensions: ['extensions.inspect', 'extensions.list', 'extensions.create', 'extensions.write', 'extensions.submit']
};
const HOST_EXPORT_OF = { sessions: 'sessionsHost', workflow: 'workflowHost', runtimes: 'runtimesHost', services: 'servicesHost', themes: 'themesHost', cliRuns: 'cliRunsHost', llm: 'llmHost', extensions: 'extensionsHost' };
compile('main/capabilities/validateArguments.ts');
compile('main/capabilities/executor.ts');
{
  const validatorFile = path.join(tmp, 'main/capabilities/validateArguments.mjs');
  fs.writeFileSync(validatorFile, fs.readFileSync(validatorFile, 'utf8').replace(
    '@earendil-works/pi-ai/utils/validation',
    pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/utils/validation.js')).href));
}
{
  const source = fs.readFileSync(path.join(root, 'src/main/capabilities/executor.ts'), 'utf8');
  for (const [, exports, filename] of source.matchAll(/import \{ ([^}]+) \} from '\.\/hosts\/([^']+)';/g)) {
    const body = exports.split(',').map((name) => `export const ${name.trim()} = {};`).join('\n');
    fs.writeFileSync(path.join(tmp, `main/capabilities/hosts/${filename}.mjs`), body);
  }
  for (const [file, keys] of Object.entries(RECORDER_HOSTS)) {
    const entries = keys.map(tool => `  '${tool}': (_ctx, args) => {\n    calls.push({ tool: '${tool}', args });\n    return { ok: true, via: '${tool}' };\n  }`).join(',\n');
    fs.writeFileSync(path.join(tmp, `main/capabilities/hosts/${file}.mjs`),
      `export const calls = [];\nexport const ${HOST_EXPORT_OF[file]} = {\n${entries}\n};\n`);
  }
}
/** 各替身 host 模块自持记录数组的汇合视图（按调用序） */
const recorderModules = await Promise.all(Object.keys(RECORDER_HOSTS).map(file =>
  import(pathToFileURL(path.join(tmp, `main/capabilities/hosts/${file}.mjs`)).href)));
const allCalls = () => recorderModules.flatMap(module => module.calls);
const callCount = () => allCalls().length;

const DOMAIN_DIRS = { 'workflow.run': 'workflow', 'runtimes.run': 'runtimes', 'automations.run': 'automations', 'themes.run': 'themes', 'dispatch.run': 'dispatch', 'llm.run': 'llm', 'extensions.run': 'extensions' };

try {
  // ---------- 1) 装配与枚举 ----------
  const { TOOL_DEFS } = await read('main/capabilities/catalog/registry.ts');
  const names = TOOL_DEFS.map(def => def.name);
  assert.equal(new Set(names).size, names.length, 'catalog names stay unique after R3b assembly');
  const { internalizedRunToolDefOf } = await read('main/capabilities/catalog/runTools.ts');
  for (const [runName, skillDir] of Object.entries(DOMAIN_DIRS)) {
    const entries = TOOL_DEFS.filter(def => def.name === runName);
    assert.equal(entries.length, 1, `${runName} appears exactly once in the catalog`);
    const def = entries[0];
    assert.deepEqual(def.parameters.required, ['action', 'params'], `${runName} envelope shape`);
    assert.equal(def.parameters.properties.action.type, 'string');
    assert.ok(def.parameters.properties.action.enum.length > 0, `${runName} action enum is the quick-reference card`);
    assert.equal(def.parameters.properties.params.type, 'object');
    assert.equal(def.dangerous, false, `${runName} entry only routes`);
    assert.match(def.description, new RegExp(`~\\/\\.muster\\/skills\\/${skillDir}\\/SKILL\\.md`), `${runName} description points at its skill doc`);
  }
  // extensions.run 信封：聚合只见信封；命令动作已退役，不再有同名内化原 def
  const envelope = TOOL_DEFS.find(def => def.name === 'extensions.run');
  assert.deepEqual([...envelope.parameters.properties.action.enum].sort(), ['bindProject', 'create', 'inspect', 'list', 'removeFile', 'retryReview', 'submit', 'write']);
  assert.equal(internalizedRunToolDefOf('extensions.run'), undefined, 'no self-collision after the command action retirement');
  assert.equal(internalizedRunToolDefOf('browser.run'), undefined, 'no phantom internalized defs for non-colliding entries');

  // 调度侧边界锁：八域入口不进任何 preset 面（Worker 三面不新增暴露）
  const { listHostToolIds } = await read('shared/hostTools/index.ts');
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    const ids = listHostToolIds(preset);
    for (const runName of Object.keys(DOMAIN_DIRS)) assert.equal(ids.includes(runName), runName === 'extensions.run', `${preset} exposes only the extensions entry to workers`);
  }
  const { isWorkerAllowedTool } = await read('main/capabilities/catalog/api.ts');
  assert.equal(isWorkerAllowedTool('workflow.run'), false, 'PTY /v1/tool rejects scheduler-side run entries');
  const { inboundMcpToolDefs } = await read('main/inboundMcp/toolList.ts');
  for (const preset of ['pty-allowlist', 'acp-subset', 'gui-full']) {
    const defs = inboundMcpToolDefs(preset);
    for (const runName of Object.keys(DOMAIN_DIRS)) {
      assert.equal(defs.some(def => def.name === `host_${runName.replaceAll('.', '_')}`), ['extensions.run', 'llm.run'].includes(runName), `${preset} inbound MCP exposes permitted worker domains`);
    }
  }

  // ---------- 2) 调度可达：executeTool 直调 run 入口 → 展开真实目标 handler（替身记录） ----------
  const usageCalls = [];
  const confirmCalls = [];
  let confirmDecision = { confirmed: true };
  const ctx = {
    resolveBubbleWorkspaceId: () => 'ws-1',
    config: { get: () => ({ workspaces: [{ id: 'ws-1', path: tmp }] }) },
    workspaces: { list: () => [{ id: 'ws-1', name: 'Fixture', path: tmp }] },
    sessions: { get: id => (id === 'se-1' ? { workspaceId: 'ws-1', name: 'Worker-1' } : undefined) },
    usage: { recordToolCall: (name, ok) => usageCalls.push([name, ok]) },
    ui: { confirm: async (title, body, opts) => { confirmCalls.push({ title, body, opts }); return confirmDecision; } }
  };
  // R5：调度面直调 executeTool('X.run')，executor 内展开真实目标（原 tools.call 路由已退役）
  const { executeTool } = await read('main/capabilities/executor.ts');
  const callRun = (name, action, params) => executeTool(ctx, name, JSON.stringify({ action, params }));

  const cases = [
    ['workflow.run', 'list', {}, 'workflow.list', {}],
    ['runtimes.run', 'preflight', { id: 'pi' }, 'runtimes.preflight', { id: 'pi' }],
    ['automations.run', 'list', {}, 'automations.list', {}],
    ['themes.run', 'activate', { id: 'dark' }, 'themes.activate', { id: 'dark' }],
    ['dispatch.run', 'delegate', { runId: 'r1', task: 'brief', isolation: 'shared' }, 'runs.delegate', { runId: 'r1', task: 'brief', isolation: 'shared' }],
    ['llm.run', 'testConnection', { providerId: 'p1' }, 'llm.testConnection', { providerId: 'p1' }],
    ['extensions.run', 'list', {}, 'extensions.list', {}]
  ];
  for (const [name, action, params, target, expectedArgs] of cases) {
    const result = await callRun(name, action, params);
    assert.equal(result.ok, true, `${name} ${action} routes through`);
    assert.deepEqual(allCalls().at(-1), { tool: target, args: expectedArgs }, `${name} action "${action}" expands to ${target}`);
  }
  // 使用统计按真实 action（入口名不进排行）
  for (const [, , , target] of cases) assert.ok(usageCalls.some(([name]) => name === target), `usage records ${target}`);
  assert.ok(!usageCalls.some(([name]) => name.endsWith('.run')), 'run envelopes never enter usage stats');

  // ---------- 3) extensions.run 创作动作 → 原执行器；权限按解析后的真实动作评估 ----------
  assert.equal(confirmCalls.length, 0, 'no confirm gate fired for the routing tests above');
  const extResult = await callRun('extensions.run', 'create', { id: 'ext-1', scope: 'global' });
  assert.equal(extResult.ok, true);
  assert.deepEqual(allCalls().at(-1), { tool: 'extensions.create', args: { id: 'ext-1', scope: 'global' } }, 'action "create" reaches the extension authoring executor');
  assert.equal(confirmCalls.length, 0, 'authoring actions own their code review; no extra confirm gate');
  // Policy must evaluate the resolved authoring action, not try to parse its
  // parameters as a new envelope.
  const { decideToolCallPermission } = await read('main/agentSession/tools/policy.ts');
  const extPolicy = (mode, action, params, rules = []) => decideToolCallPermission({
    mode, planExecuting: false, engineToolName: 'extensions.run', input: { action, params },
    cwd: root, hostToolIds: ['extensions.run'], hostClassOf: () => 'shell', userRules: rules
  });
  assert.equal(extPolicy('ask', 'list', {}).decision, 'auto');
  const restricted = extPolicy('ask', 'create', { id: 'ext-1', scope: 'global' });
  assert.equal(restricted.decision, 'deny');
  assert.doesNotMatch(restricted.ruleReason ?? '', /requires a string "action"/);
  const rewritten = extPolicy('default', 'create', { id: 'ext-1', scope: 'global' }, [{ tool: 'extensions.create', action: 'rewrite', rewrite: { id: 'ext-2' } }]);
  assert.equal(rewritten.updatedInput.params.id, 'ext-2', 'action-level rewrites return to the envelope');
  // Package review, stale-candidate rejection and review deduplication are exercised
  // against the real extension coordinator in extensions-review.mjs. Here, verify
  // that authoring actions reach their respective hosts with the full parameters.
  for (const [action, params] of [
    ['create', { id: 'ext-1', scope: 'global' }],
    ['write', { draftId: 'draft-1', path: 'extension.json', text: '{}' }],
    ['submit', { draftId: 'draft-1' }]
  ]) {
    const result = await callRun('extensions.run', action, params);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(allCalls().at(-1), { tool: `extensions.${action}`, args: params });
  }

  // Session management keeps discriminated params resident and uses the original handlers/gates.
  const sessionDef = TOOL_DEFS.find(def => def.name === 'sessions.run');
  assert.deepEqual(sessionDef.parameters.properties.action.enum, SESSION_ACTIONS);
  assert.doesNotMatch(sessionDef.description, /SKILL|Action parameters: read/);
  assert.equal(sessionDef.parameters.oneOf.length, 7);
  const { validateDiscoveredArguments } = await read('main/capabilities/validateArguments.ts');
  const { residentHostToolIds } = await read('shared/toolDiscovery.ts');
  for (const action of SESSION_ACTIONS) {
    const target = TOOL_DEFS.find(def => def.name === `sessions.${action}`);
    const branch = sessionDef.parameters.oneOf.find(branch => branch.properties.action.enum[0] === action);
    assert.equal(branch.description, target.description);
    for (const [key, schema] of Object.entries(target.parameters.properties)) {
      assert.deepEqual((branch.properties.params.properties[key] ?? sessionDef.parameters.properties.params.properties[key]), schema, `${action}.${key} remains resident`);
    }
    assert.deepEqual([...sessionDef.parameters.properties.params.required, ...(branch.properties.params.required ?? [])], target.parameters.required);
    assert.ok(!residentHostToolIds('scheduler').includes(target.name));
    const params = { sessionId: 'se-1', ...(action === 'setPinned' ? { pinned: false } : {}),
      ...(action === 'setOrchestrated' ? { orchestrated: false } : {}) };
    await validateDiscoveredArguments('sessions.run', sessionDef.parameters, { action, params });
    const result = await callRun('sessions.run', action, params);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(recorderModules[0].calls.at(-1), { tool: target.name, args: params });
  }
  await assert.rejects(() => validateDiscoveredArguments('sessions.run', sessionDef.parameters,
    { action: 'setPinned', params: { sessionId: 'se-1' } }));
  await assert.rejects(() => validateDiscoveredArguments('sessions.run', sessionDef.parameters,
    { action: 'setThinking', params: { sessionId: 'se-1', level: 'invalid' } }));
  const sessionCallsBefore = callCount();
  confirmDecision = { confirmed: false, cancelledBy: 'button' };
  assert.equal((await callRun('sessions.run', 'restartConversation', { sessionId: 'se-1' })).ok, false);
  assert.equal(callCount(), sessionCallsBefore, 'cancelled restart cannot reach its handler');
  confirmDecision = { confirmed: true };
  assert.equal((await callRun('sessions.run', 'setPinned', { sessionId: 'se-1' })).ok, false);
  assert.equal((await callRun('sessions.run', 'delete', { sessionIds: ['se-1'] })).ok, false);
  assert.equal(callCount(), sessionCallsBefore, 'bad params and non-management actions cannot execute');
  assert.equal(isWorkerAllowedTool('sessions.run'), false);
  assert.ok(!residentHostToolIds('worker').includes('sessions.run'));
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    assert.ok(!listHostToolIds(preset).includes('sessions.run'));
    assert.ok(!inboundMcpToolDefs(preset).some(def => def.name === 'sessions_run'));
  }

  // ---------- 4) runRouter 纯函数展开 ----------
  const { expandRunToolCall } = await read('main/capabilities/runRouter.ts');
  const underscore = expandRunToolCall('themes_run', { action: 'list', params: {} });
  assert.equal(underscore.targetTool, 'themes.list', 'underscore engine names expand too');
  const prefixed = expandRunToolCall('mcp__muster__llm_run', { action: 'listProviders', params: {} });
  assert.equal(prefixed.targetTool, 'llm.listProviders', 'prefixed engine names expand too');
  assert.throws(
    () => expandRunToolCall('workflow.run', { action: 'nopes', params: {} }),
    /Unknown action "nopes" for workflow\.run\. Valid actions: /
  );

  // ---------- 5) 未知 action / 参数错误经 executeTool：可纠正错误，不触达 handler ----------
  const reachable = callCount();
  const emptyAction = await callRun('extensions.run', undefined, undefined);
  assert.equal(emptyAction.ok, false);
  assert.match(emptyAction.error, /extensions\.run requires a string "action"\. Valid actions:/);
  const arrayParams = await executeTool(ctx, 'extensions.run', JSON.stringify({ action: 'list', params: [] }));
  assert.equal(arrayParams.ok, false);
  assert.match(arrayParams.error, /requires "params" to be an object/);
  assert.equal(callCount(), reachable, 'routing errors short-circuit before the handlers');
  // Worker 三面不新增暴露：调度侧入口不进任何 preset / PTY 白名单（边界锁已在第 1 节）
  for (const name of Object.keys(DOMAIN_DIRS)) assert.equal(isWorkerAllowedTool(name), name === 'extensions.run', `${name} worker visibility`);

  console.log('run-domains-wiring: OK (7-domain assembly with unique names, scheduler reachability via direct executeTool run calls, extension routing with caller permissions, runRouter expansion, correctable errors)');
} finally {
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('run-domains-wiring-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
