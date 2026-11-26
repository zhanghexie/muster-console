/**
 * R2 browser 域 run 化端到端离线测试（tool-exposure-resident-run-skill-plan §3 R2）：
 * 浏览器内部工具收敛为单入口 browser.run({action, params})。
 * 1) 装配与枚举：catalog 聚合含 browser.run，25 原工具保留为内部真源；
 * 2) 三面投影：meta 三 preset 只含 browser.run（空 presets 不投影任何面），
 *    Worker 常驻/PTY 白名单/入站 MCP 同步；GUI catalog 背书面只注册 browser.run；
 * 3) 执行路由（替身 browser handler，其余 host 桩空）：resolve → bindWorkerToolArgs
 *    （真实目标名注入 __browserOwner）→ executeTool 原路径；统计/证据按真实 action；
 * 4) 权限决策表按真实目标展开：读类 ask 门 auto、操作类 ask 门 deny / default auto、
 *    用户规则按目标名生效、R5 后代理名无展开分支（未知工具 fail closed）、未知 action/参数错误可纠正；
 * 5) 调度面 executeTool 直调 run 入口（R5：executor 内展开）与 ACP hostToolGateway（HTTP）同一路由。
 * 运行: node test/browser-run-tool.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-run-tool-'));
const compile = createSharedCompiler(root, tmp);
const read = rel => import(pathToFileURL(compile(rel)).href);

// electron 桩包：turnShotCapture 顶层 import { app } from 'electron'（模块级不调用）
{
  const dir = path.join(tmp, 'node_modules', 'electron');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const app = { getPath: () => tmp };\n');
}

// 替身 browser handler + 其余 host 桩空（同 test/catalog-executor.mjs 手法）：
// executor 先编译（连带 validateArguments），再覆写 hosts/*.mjs。
// R5：hosts/discovery 已删，全部 host 置桩（executor 内的 run 展开用真实实现），
// pi-ai 校验包指回仓库 node_modules（同 test/tool-discovery.mjs）；browser 覆写为记录替身；其余 host 桩空。
const BROWSER_VERBS = ['tabs', 'open', 'close', 'activate', 'navigate', 'snapshot', 'click', 'fill', 'selectOption',
  'pressKey', 'hover', 'movePointer', 'scroll', 'waitFor', 'screenshot', 'evaluate', 'upload', 'drag', 'setViewport', 'dialog',
  'recording', 'cookies', 'storage', 'console', 'network', 'downloads'];
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
    // R5：hosts/discovery 已删；全部 host 置桩（executor 内的 run 展开用真实实现）
    const body = exports.split(',').map((name) => `export const ${name.trim()} = {};`).join('\n');
    fs.writeFileSync(path.join(tmp, `main/capabilities/hosts/${filename}.mjs`), body);
  }
  fs.writeFileSync(
    path.join(tmp, 'main/capabilities/hosts/browser.mjs'),
    'export const browserCalls = [];\n' +
    'export const browserHost = {\n' + BROWSER_VERBS.map(verb =>
      `  'browser.${verb}': (_ctx, args) => {\n` +
      `    browserCalls.push({ tool: 'browser.${verb}', args });\n` +
      (verb === 'open' ? `    return { id: 'tab-new' };\n` : verb === 'screenshot' ? `    return { previewPath: 'E:/tmp/shot.png' };\n` : `    return { ok: true, verb: '${verb}' };\n`) +
      `  }`).join(',\n') + '\n};\n'
  );
  fs.writeFileSync(path.join(tmp, 'main/capabilities/hosts/extensions.mjs'), `
    import { currentAgentSessionId } from '../../agent/agentScope.mjs';
    export const extensionsHost = {
      'extensions.inspect': (_ctx, args) => ({ args, caller: currentAgentSessionId() })
    };
  `);
}
const { browserCalls } = await import(pathToFileURL(path.join(tmp, 'main/capabilities/hosts/browser.mjs')).href);

try {
  // ---------- 1) 装配与枚举 ----------
  const { TOOL_DEFS } = await read('main/capabilities/catalog/registry.ts');
  const names = TOOL_DEFS.map(def => def.name);
  const DIRECT = BROWSER_VERBS.map(verb => `browser.${verb}`);
  for (const name of [...DIRECT, 'browser.run']) assert.ok(names.includes(name), `${name} in catalog`);
  assert.equal(names.filter(name => name.startsWith('browser.')).length, BROWSER_VERBS.length + 1);
  const runDef = TOOL_DEFS.find(def => def.name === 'browser.run');
  assert.deepEqual(runDef.parameters.required, ['action', 'params']);
  assert.deepEqual([...runDef.parameters.properties.action.enum].sort(), [...BROWSER_VERBS].sort());
  assert.match(runDef.description, /Action parameters: read/);
  assert.match(runDef.description, /~\/\.muster\/skills\/browser\/SKILL\.md/);
  assert.equal(runDef.dangerous, false);

  // ---------- 2) 三面投影：preset / 常驻 / PTY 白名单 / 入站 MCP / GUI 注册面 ----------
  const { listHostToolIds, listHostToolMetas, hostToolPermissionClass, hostToolBinding } = await read('shared/hostTools/index.ts');
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    const ids = listHostToolIds(preset);
    assert.ok(ids.includes('browser.run'), `${preset} projects browser.run`);
    for (const id of DIRECT) assert.ok(!ids.includes(id), `${preset} drops direct-call ${id}`);
  }
  // 空 presets 条目不泄漏进任何 preset 面（listHostToolMetas 按 presets.includes 过滤）
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    const metas = listHostToolMetas(preset);
    assert.ok(metas.every(meta => meta.presets.includes(preset)));
    assert.deepEqual(metas.filter(meta => meta.group === 'browser').map(meta => meta.id), ['browser.run']);
  }
  // 权限档/绑定真源仍在（内部按目标名判定）
  assert.equal(hostToolPermissionClass('browser.run'), 'browser');
  assert.equal(hostToolPermissionClass('browser.tabs'), 'read');
  assert.equal(hostToolPermissionClass('browser.click'), 'browser');
  assert.equal(hostToolPermissionClass('browser.movePointer'), 'browser');
  assert.equal(hostToolBinding('browser.run'), undefined, 'binding applies per resolved target, not the entry');

  const { residentHostToolIds } = await read('shared/toolDiscovery.ts');
  const worker = residentHostToolIds('worker');
  assert.ok(worker.includes('browser.run'), 'worker resident gains browser.run');
  assert.ok(!worker.includes('browser.click'), 'direct names leave the resident list');

  const { inboundMcpToolDefs } = await read('main/inboundMcp/toolList.ts');
  for (const preset of ['pty-allowlist', 'acp-subset', 'gui-full']) {
    const defs = inboundMcpToolDefs(preset);
    const entry = defs.find(def => def.name === 'host_browser_run');
    assert.ok(entry, `${preset} inbound MCP projects host_browser_run`);
    assert.deepEqual(entry.inputSchema.required, ['action', 'params']);
    assert.match(entry.description, /SKILL\.md/);
    assert.ok(!defs.some(def => def.name.startsWith('browser_')), `${preset} drops old direct-call browser tools`);
    assert.ok(entry.inputSchema.properties.action.enum.includes('movePointer'));
  }

  const { isWorkerAllowedTool } = await read('main/capabilities/catalog/api.ts');
  assert.ok(isWorkerAllowedTool('browser.run'));
  assert.ok(isWorkerAllowedTool('browser_run'));
  assert.equal(isWorkerAllowedTool('browser.click'), false, 'PTY /v1/tool rejects retired direct names');

  const { buildCatalogHostTools, CATALOG_HOST_TOOL_IDS } = await read('main/agentSession/tools/catalogHostTools.ts');
  assert.ok(CATALOG_HOST_TOOL_IDS.includes('browser.run'));
  assert.ok(!CATALOG_HOST_TOOL_IDS.some(id => DIRECT.includes(id)), 'GUI catalog face registers only the run entry');

  // ---------- 3) GUI 面执行路由（替身 executor；身份绑定按真实目标） ----------
  const usageCalls = [];
  const evidenceCalls = [];
  const sessionOf = id => (id === 'se-1' || id === 'se-acp' ? { workspaceId: 'ws-1', name: 'Worker-1' } : undefined);
  const ctx = {
    sessions: { get: sessionOf },
    usage: { recordToolCall: (name, ok) => usageCalls.push([name, ok]) },
    evidence: { recordBrowserShot: (sessionId, file) => evidenceCalls.push([sessionId, file]) }
  };
  const guiTools = buildCatalogHostTools(ctx);
  const runTool = guiTools.find(tool => tool.id === 'browser.run');
  assert.equal(runTool.permissionClass, 'browser');
  assert.match(runTool.description, /SKILL\.md/);
  const extensions = guiTools.find(tool => tool.id === 'extensions.run');
  const inspected = JSON.parse(await extensions.execute({ action: 'inspect', params: {} }, { sessionId: 'se-1' }));
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.caller, 'se-1');
  assert.equal(inspected.result.args.__actorSessionId, 'se-1');
  await assert.rejects(() => extensions.execute({ action: 'inspect', params: { __actorSessionId: 'forged' } },
    { sessionId: 'se-1' }), /additional properties/);
  await assert.rejects(() => extensions.execute({ action: 'run', params: { id: 'demo', command: 'go' } },
    { sessionId: 'se-1' }), /Unknown action "run"/);

  let payload = JSON.parse(await runTool.execute(
    { action: 'click', params: { tabId: 't1', target: 'e12' } }, { sessionId: 'se-1' }));
  assert.equal(payload.ok, true);
  assert.equal(browserCalls.at(-1).tool, 'browser.click');
  assert.deepEqual(browserCalls.at(-1).args.__browserOwner, { workspaceId: 'ws-1', sessionId: 'se-1' },
    'identity binds on the resolved target name (real bindWorkerToolArgs)');
  assert.ok(usageCalls.some(([name]) => name === 'browser.click'), 'usage records the real action');
  assert.ok(!usageCalls.some(([name]) => name === 'browser.run'), 'run entry itself never enters usage stats');

  payload = JSON.parse(await runTool.execute(
    { action: 'movePointer', params: { tabId: 't1', target: '40.5,70' } }, { sessionId: 'se-1' }));
  assert.equal(payload.ok, true);
  assert.equal(browserCalls.at(-1).tool, 'browser.movePointer');

  payload = JSON.parse(await runTool.execute({ action: 'tabs', params: {} }, { sessionId: 'se-1' }));
  assert.equal(payload.ok, true);
  assert.equal(browserCalls.at(-1).tool, 'browser.tabs');

  payload = JSON.parse(await runTool.execute(
    { action: 'screenshot', params: { tabId: 't1' } }, { sessionId: 'se-1' }));
  assert.equal(payload.ok, true);
  assert.deepEqual(evidenceCalls, [['se-1', 'E:/tmp/shot.png']], 'screenshot evidence still recorded for the resolved target');

  // 未知 action / 参数错误：可纠正英文错误，不触达替身 executor
  const before = browserCalls.length;
  await assert.rejects(
    () => runTool.execute({ action: 'navigte', params: {} }, { sessionId: 'se-1' }),
    /Unknown action "navigte" for browser\.run\. Valid actions: /
  );
  await assert.rejects(
    () => runTool.execute({ action: 'click', params: { target: 'e12' } }, { sessionId: 'se-1' }),
    /Invalid parameters for browser\.run action "click".*required property 'tabId'/
  );
  await assert.rejects(
    () => runTool.execute({ action: 'click', params: [] }, { sessionId: 'se-1' }),
    /requires "params" to be an object/
  );
  assert.equal(browserCalls.length, before, 'routing errors short-circuit before the executor');
  // 模型伪造的身份字段不进目标参数：可信绑定覆盖（bindWorkerToolArgs 按真实目标名）
  payload = JSON.parse(await runTool.execute(
    { action: 'click', params: { tabId: 't2', target: 'e2', __actorSessionId: 'forged', __browserOwner: { workspaceId: 'forged' } } },
    { sessionId: 'se-1' }));
  assert.equal(payload.ok, true);
  assert.equal(browserCalls.at(-1).args.__actorSessionId, undefined, 'forged actor id stripped');
  assert.deepEqual(browserCalls.at(-1).args.__browserOwner, { workspaceId: 'ws-1', sessionId: 'se-1' },
    'forged browser owner overwritten by the trusted binding');

  // 匿名展开（无身份）：剥掉伪造身份字段（runRouter 纯函数）
  const { expandRunToolCall } = await read('main/capabilities/runRouter.ts');
  const anonymous = expandRunToolCall('browser.run', { action: 'click', params: { tabId: 't', target: 'e', __actorSessionId: 'forged', __browserOwner: { sessionId: 'forged' } } });
  assert.equal(anonymous.targetTool, 'browser.click');
  assert.equal(anonymous.args.__actorSessionId, undefined);
  assert.equal(anonymous.args.__browserOwner, undefined);

  // ---------- 4) 权限决策表按真实目标展开 ----------
  const { decideToolCallPermission } = await read('main/agentSession/tools/policy.ts');
  const clickInput = { action: 'click', params: { tabId: 't', target: 'e' } };
  const decide = (engineToolName, input, extra = {}) => decideToolCallPermission({
    mode: 'ask', planExecuting: false, engineToolName, input, cwd: root,
    hostToolIds: ['browser.run'], hostClassOf: () => 'browser', userRules: [], ...extra
  });
  assert.equal(decide('browser_run', { action: 'tabs', params: {} }).decision, 'auto', 'read action passes the ask readonly gate');
  assert.equal(decide('browser_run', clickInput).decision, 'deny', 'operation action denied under the ask readonly gate');
  assert.equal(decide('browser.run', clickInput).decision, 'deny', 'dotted engine name expands the same way');
  assert.equal(decide('mcp__muster__browser_run', clickInput).decision, 'deny', 'prefixed engine name expands too');
  assert.equal(decide('browser_run', clickInput, { mode: 'default' }).decision, 'auto', 'operation action auto in default mode (no approval gate, 2026-09-07/09-11)');
  // 用户规则按真实目标名生效（不能被 run 外壳绕过）
  assert.equal(decide('browser_run', clickInput, { userRules: [{ tool: 'browser.click', action: 'deny', reason: 'blocked' }] }).decision, 'deny');
  assert.match(decide('browser_run', clickInput, { userRules: [{ tool: 'browser.click', action: 'deny', reason: 'blocked' }] }).ruleReason, /blocked/);
  const rewritten = decide('browser_run', clickInput, { userRules: [{ tool: 'browser.click', action: 'rewrite', rewrite: { tabId: 'rewritten' } }] });
  assert.equal(rewritten.updatedInput.params.tabId, 'rewritten', 'target rewrite flows back into the run envelope');
  // 展开失败：可纠正错误作为 deny 理由
  const unknown = decide('browser_run', { action: 'nope', params: {} });
  assert.equal(unknown.decision, 'deny');
  assert.match(unknown.ruleReason, /Unknown action "nope" for browser\.run/);
  assert.match(decide('browser_run', { action: 'click', params: {} }).ruleReason, /required property 'tabId'/);
  // R5：发现层退役——tools.call 代理名不再有展开分支，未知工具 fail closed
  assert.equal(decide('tools_call', { name: 'browser.run', arguments: { action: 'tabs', params: {} } }, { hostToolIds: [], hostClassOf: () => 'dynamic' }).decision, 'prompt');

  // ---------- 5) 调度面直调 run 入口（executor 内展开）与 ACP 网关同一路由 ----------
  const { executeTool } = await read('main/capabilities/executor.ts');
  const schedulerCall = await executeTool(ctx, 'browser.run', JSON.stringify({ action: 'click', params: { tabId: 't9', target: 'e9' } }));
  assert.equal(schedulerCall.ok, true);
  assert.equal(browserCalls.at(-1).tool, 'browser.click');
  assert.ok(usageCalls.some(([name]) => name === 'browser.click' && name !== 'browser.run'), 'scheduler direct run call records the real action in usage');
  // 未知 action / 参数错误：可纠正英文错误，不触达 handler
  const badAction = await executeTool(ctx, 'browser.run', JSON.stringify({ action: 'navigte', params: {} }));
  assert.equal(badAction.ok, false);
  assert.match(badAction.error, /Unknown action "navigte"/);
  const missingParam = await executeTool(ctx, 'browser.run', JSON.stringify({ action: 'click', params: {} }));
  assert.equal(missingParam.ok, false);
  assert.match(missingParam.error, /required property 'tabId'/);

  const { startHostToolGateway } = await read('main/agentSession/drivers/acp/hostToolGateway.ts');
  let mode = 'ask';
  const gateway = await startHostToolGateway({
    sessionId: 'se-acp', cwd: tmp, hostTools: [runTool],
    requestApproval: async () => ({ approved: true }),
    getPolicyState: () => ({ mode, planExecuting: false }),
    log() {}
  });
  const post = body => fetch(gateway.url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: gateway.token, ...body })
  }).then(res => res.json());
  try {
    const denied = await post({ name: 'browser_run', arguments: { action: 'click', params: { tabId: 'tA', target: 'eA' } } });
    assert.equal(denied.isError, true, 'policy denial must be exposed as an ACP error');
    assert.ok(!browserCalls.some(call => call.args.tabId === 'tA'), 'ask-mode operation never reaches the executor over ACP');
    mode = 'default';
    const allowed = await post({ name: 'browser_run', arguments: { action: 'click', params: { tabId: 'tA', target: 'eA' } } });
    assert.equal(allowed.isError, false);
    const acpCall = browserCalls.find(call => call.args.tabId === 'tA');
    assert.equal(acpCall.tool, 'browser.click');
    assert.deepEqual(acpCall.args.__browserOwner, { workspaceId: 'ws-1', sessionId: 'se-acp' },
      'ACP gateway routes through the same catalog host tool (policy auto in default mode)');
  } finally {
    gateway.close();
  }

  console.log('browser-run-tool: OK (catalog assembly, three-face projection, routed execution with identity binding, per-target permission expansion, scheduler direct run call + ACP gateway)');
} finally {
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('browser-run-tool-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
