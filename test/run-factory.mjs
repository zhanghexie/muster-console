/**
 * R1 run 路由基建离线单测（tool-exposure-resident-run-skill-plan §3 R1）：
 * 九域 action 枚举与 catalog 真实定义对账、browser 权限分档、params 校验、
 * 未知 action、绑定注入（默认 actor/self + 可注入）。
 * 工厂零接线：本测试只 import 工厂与 registry 数据，不触任何注册面。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-factory-'));
const compile = createSharedCompiler(root, tmp);
const read = relative => import(pathToFileURL(compile(relative)).href);
try {
  const { TOOL_DEFS } = await read('main/capabilities/catalog/registry.ts');
  const {
    RUN_TOOL_DOMAIN_SPECS, buildRunToolDomain, buildRunToolDomains,
    resolveRunToolCall, executeRunToolCall
  } = await read('main/capabilities/catalog/runFactory.ts');

  // R2 起九域 run 入口已并入 catalog 聚合：重建时先剥**入口 def**（按引用判定——
  // extensions 域入口名 extensions.run 与域内动词 run 的原工具同名，且同名原 def 已被
  // registry 聚合内化剥除，按名剥会连入口信封一起误杀）；被内化的同名原 def 不在聚合里，
  // 经 internalizedRunToolDefOf 从域动作表补回真源，保证九域对账口径 = 聚合 ∪ 内化原 def。
  const { RUN_TOOL_DEFS, internalizedRunToolDefOf } = await read('main/capabilities/catalog/runTools.ts');
  const entryDefs = new Set(RUN_TOOL_DEFS);
  const internalizedOriginals = RUN_TOOL_DEFS
    .map(def => internalizedRunToolDefOf(def.name))
    .filter(Boolean);
  const defs = [...TOOL_DEFS.filter(def => !entryDefs.has(def)), ...internalizedOriginals];

  const domains = buildRunToolDomains(RUN_TOOL_DOMAIN_SPECS, defs);
  const byRun = name => domains.find(domain => domain.runName === name);
  const sorted = values => [...values].sort();
  const verbsOf = domain => domain.actions.map(entry => entry.action);

  // ---------- 1. 八域枚举完整性：与 catalog 真实定义对账（计划 §2.3） ----------
  const expected = {
    'browser.run': ['open', 'close', 'activate', 'navigate', 'click', 'fill', 'selectOption', 'pressKey',
      'hover', 'movePointer', 'scroll', 'waitFor', 'screenshot', 'evaluate', 'upload', 'drag', 'setViewport', 'dialog',
      'recording', 'cookies', 'storage', 'tabs', 'snapshot', 'console', 'network', 'downloads'],
    'workflow.run': ['start', 'list', 'get', 'validate', 'reply', 'askHuman', 'cancel'],
    'runtimes.run': ['list', 'register', 'get', 'update', 'remove', 'restoreBuiltins', 'preflight'],
    'automations.run': ['create', 'update', 'delete', 'list', 'runNow', 'setEnabled'],
    'themes.run': ['list', 'get', 'create', 'update', 'activate', 'remove'],
    'llm.run': ['listProviders', 'upsertProvider', 'setDefault', 'testConnection'],
    'extensions.run': ['inspect', 'list', 'bindProject', 'create', 'write', 'removeFile', 'submit', 'retryReview'],
    'dispatch.run': ['delegate', 'get', 'progress', 'ask', 'deliver', 'fail'],
    'desktop.run': ['list', 'look', 'act', 'focus', 'launch'],
    'panel.run': ['list', 'open', 'split', 'focus', 'close'],
    'github.run': ['repository', 'list', 'detail', 'files', 'threads', 'create', 'publish']
  };
  assert.deepEqual(sorted(domains.map(domain => domain.runName)), sorted(Object.keys(expected)));
  for (const [runName, actions] of Object.entries(expected)) {
    const domain = byRun(runName);
    assert.ok(domain, `domain ${runName} built`);
    assert.deepEqual(sorted(verbsOf(domain)), sorted(actions), `${runName} action enum reconciles with plan §2.3`);
    assert.equal(domain.actions.length, actions.length, `${runName} has no duplicate verbs`);
    // 生成 schema 的枚举与 action 表一致（模型可见词表 = 路由词表）
    assert.deepEqual(sorted(domain.def.parameters.properties.action.enum), sorted(actions), `${runName} schema enum matches action table`);
    for (const entry of domain.actions) {
      assert.ok(entry.def, `${runName} action ${entry.action} carries the real ToolDef`);
      assert.ok(TOOL_DEFS.some(def => def.name === entry.targetTool), `${entry.targetTool} exists in catalog`);
    }
  }
  const github = byRun('github.run');
  assert.equal(github.actions.find(item => item.action === 'detail').permissionClass, 'read');
  for (const action of ['create', 'publish']) {
    assert.equal(github.actions.find(item => item.action === action).permissionClass, 'edit');
    assert.equal(github.actions.find(item => item.action === action).def.dangerous, true);
  }
  assert.throws(() => resolveRunToolCall(github, { action: 'list', params: { filter: 'authored', workspaceId: 'other' } }), /additional properties/);
  assert.throws(() => resolveRunToolCall(github, { action: 'publish', params: { event: 'APPROVE' } }), /version/);

  // 脚本 Driver 注册与信任状态不公开；llm.quota 仍是常驻排除项。
  // R3b 起聚合含各域入口：catalogCount = 原工具数 + 1 个入口（extensions 域另少 1 个
  // 同名内化原 def：2 原工具 + 入口 = 2，名字仍唯一）。
  const catalogCount = prefix => TOOL_DEFS.filter(def => def.name.startsWith(`${prefix}.`)).length;
  assert.equal(catalogCount('runtimes'), 8, '7 actions + runtimes.run entry');
  assert.equal(byRun('runtimes.run').actions.length, 7);
  for (const resident of ['registerDriver', 'driverTrustStatus']) {
    assert.ok(!TOOL_DEFS.some(def => def.name === `runtimes.${resident}`), `runtimes.${resident} is hidden`);
  }
  assert.ok(verbsOf(byRun('runtimes.run')).includes('register'), 'manifest registration is available through the runtime domain');
  assert.equal(catalogCount('llm'), 6, '5 originals + llm.run entry');
  assert.equal(byRun('llm.run').actions.length, 4);
  assert.ok(!verbsOf(byRun('llm.run')).includes('quota'), 'llm.quota stays resident direct-call');

  // 生成 ToolDef 形态：{action: enum, params: object}、英文本本、技能路径提示、非危险
  const browser = byRun('browser.run');
  assert.deepEqual(browser.def.parameters.required, ['action', 'params']);
  assert.equal(browser.def.parameters.properties.params.type, 'object');
  assert.equal(browser.def.parameters.properties.action.type, 'string');
  assert.match(browser.def.description, /Action parameters: read/);
  assert.match(browser.def.description, /~\/\.muster\/skills\/browser\/SKILL\.md/);
  assert.equal(browser.def.dangerous, false, 'run entry only routes; per-action confirm gates stay on real executors');
  assert.equal(browser.def.summary, RUN_TOOL_DOMAIN_SPECS.find(spec => spec.prefix === 'browser.').purpose);

  // ---------- 2. browser 权限分档路由（读类 read vs 操作类 browser） ----------
  const classOfVerb = verb => browser.actions.find(entry => entry.action === verb).permissionClass;
  for (const readVerb of ['tabs', 'snapshot', 'console', 'network', 'downloads']) {
    assert.equal(classOfVerb(readVerb), 'read', `browser.${readVerb} routes as read class`);
  }
  for (const actionVerb of ['open', 'click', 'fill', 'screenshot', 'evaluate', 'cookies', 'storage', 'dialog', 'recording', 'movePointer']) {
    assert.equal(classOfVerb(actionVerb), 'browser', `browser.${actionVerb} routes as browser class`);
  }
  for (const entry of browser.actions) {
    assert.ok(entry.permissionClass === 'read' || entry.permissionClass === 'browser', 'every browser action keeps its tier');
  }

  // ---------- 3. 按 action 展开真实目标 + params 校验 ----------
  const click = resolveRunToolCall(browser, { action: 'click', params: { tabId: 't1', target: 'e12' } });
  assert.equal(click.targetTool, 'browser.click');
  assert.deepEqual(click.args, { tabId: 't1', target: 'e12' });
  const tabs = resolveRunToolCall(browser, { action: 'tabs', params: {} });
  assert.equal(tabs.targetTool, 'browser.tabs');
  assert.deepEqual(tabs.args, {});
  // 校验通过不改动调用方对象（浅拷贝）
  const source = { tabId: 't2', target: 'e1' };
  resolveRunToolCall(browser, { action: 'click', params: source });
  assert.deepEqual(Object.keys(source), ['tabId', 'target']);

  // 失败：缺必填（错误文案以 schemaValidation 当前输出为准）
  assert.throws(
    () => resolveRunToolCall(browser, { action: 'click', params: { target: 'e12' } }),
    /Invalid parameters for browser\.run action "click".*must have required property 'tabId'/
  );
  // 失败：类型错误（指出参数与期望类型）
  assert.throws(
    () => resolveRunToolCall(browser, { action: 'click', params: { tabId: 5, target: 'e12' } }),
    /params\/tabId must be string/
  );
  // 失败：枚举越界（列出合法值）
  assert.throws(
    () => resolveRunToolCall(browser, { action: 'console', params: { tabId: 't', level: 'debug' } }),
    /params\/level must be equal to one of the allowed values/
  );
  // 失败：params 不是对象
  assert.throws(
    () => resolveRunToolCall(browser, { action: 'click', params: [] }),
    /action "click" requires "params" to be an object; pass \{\}/
  );
  assert.throws(
    () => resolveRunToolCall(browser, { action: 'click' }),
    /requires "params" to be an object/
  );
  // 失败：嵌套必填（workflow.start 的 task）
  assert.throws(
    () => resolveRunToolCall(byRun('workflow.run'), { action: 'start', params: {} }),
    /must have required property/
  );
  // oneOf（browser.setViewport：宽高组合或 reset）
  assert.equal(resolveRunToolCall(browser, { action: 'setViewport', params: { tabId: 't', reset: true } }).targetTool, 'browser.setViewport');
  assert.equal(resolveRunToolCall(browser, { action: 'setViewport', params: { tabId: 't', width: 800, height: 600 } }).targetTool, 'browser.setViewport');
  assert.throws(
    () => resolveRunToolCall(browser, { action: 'setViewport', params: { tabId: 't' } }),
    /params must match exactly one schema in oneOf/
  );
  // 深层对象：automations.create 的 schedule.kind 一次成形
  assert.throws(
    () => resolveRunToolCall(byRun('automations.run'), {
      action: 'create', params: { name: 'n', prompt: 'p', runtime: 'r', schedule: { kind: 'weird' } }
    }),
    /params\/schedule\/kind must be equal to constant/
  );
  assert.equal(
    resolveRunToolCall(byRun('automations.run'), {
      action: 'create', params: { name: 'n', prompt: 'p', runtime: 'r', schedule: { kind: 'once', at: '2026-10-23T09:00:00+08:00' } }
    }).targetTool,
    'automations.create'
  );

  // ---------- 4. 未知 action：明确报错并列出合法枚举 ----------
  assert.throws(
    () => resolveRunToolCall(browser, { action: 'navigte', params: {} }),
    /Unknown action "navigte" for browser\.run\. Valid actions: .*open.*waitFor/
  );
  assert.throws(
    () => resolveRunToolCall(browser, { params: {} }),
    /requires a string "action"\. Valid actions:/
  );
  assert.throws(
    () => resolveRunToolCall(browser, { action: 42, params: {} }),
    /requires a string "action"/
  );

  // ---------- 6. 绑定注入（默认 actor/self + 可注入 bindArgs/checkPermission/execute） ----------
  const boundDomain = buildRunToolDomain({
    ...RUN_TOOL_DOMAIN_SPECS.find(spec => spec.prefix === 'browser.'),
    bindingOf: target => (target === 'browser.tabs' ? 'actor' : target === 'browser.open' ? 'self' : undefined)
  }, TOOL_DEFS);
  const seen = [];
  const record = args => { seen.push(args); return `ran:${JSON.stringify(args)}`; };
  const run = (rawArgs, deps) => executeRunToolCall(boundDomain, rawArgs, { caller: 'ctx' }, {
    execute: (targetTool, args) => { seen.push(targetTool); return record(args); },
    ...deps
  });

  // actor 绑定：注入 __actorSessionId
  await run({ action: 'tabs', params: {} }, { sessionId: 's1' });
  assert.equal(seen[0], 'browser.tabs');
  assert.equal(seen[1].__actorSessionId, 's1', 'actor binding injects the authenticated session id');
  // self 绑定：强制 sessionId，丢弃 externalSessionId
  await run({ action: 'open', params: { url: 'https://example.com', sessionId: 'spoofed', externalSessionId: 'spoofed' } }, { sessionId: 's1' });
  assert.equal(seen[3].sessionId, 's1', 'self binding forces the caller session id');
  assert.equal(seen[3].externalSessionId, undefined);
  // 无绑定工具：剥掉模型伪造的身份字段
  await run({ action: 'click', params: { tabId: 't', target: 'e1', __actorSessionId: 'forged', __browserOwner: 'forged' } }, { sessionId: 's1' });
  assert.equal(seen[5].__actorSessionId, undefined, 'forged actor ids are stripped');
  assert.equal(seen[5].__browserOwner, undefined, 'forged browser owner is stripped');
  // 需要身份但缺失 → fail-closed
  await assert.rejects(
    () => run({ action: 'tabs', params: {} }, {}),
    /browser\.tabs via browser\.run requires an authenticated caller identity \(actor binding\)/
  );
  // 注入式 bindArgs（接线时换成 workerBinding.bindWorkerToolArgs）：优先于默认绑定
  seen.length = 0;
  await run({ action: 'click', params: { tabId: 't', target: 'e1' } }, {
    bindArgs: (targetTool, args) => ({ ...args, bound: true, targetTool })
  });
  assert.equal(seen[1].bound, true, 'custom bindArgs replaces the default binding');
  assert.equal(seen[1].targetTool, 'browser.click');
  // 注入式权限门：拒绝时英文理由透传，executor 不被触达
  seen.length = 0;
  await assert.rejects(
    () => run({ action: 'click', params: { tabId: 't', target: 'e1' } }, {
      sessionId: 's1',
      checkPermission: () => ({ allowed: false, reason: 'read-only session mode' })
    }),
    /browser\.run → browser\.click denied: read-only session mode/
  );
  assert.deepEqual(seen, [], 'denied calls never reach the executor');
  // 权限门看到的是绑定后的参数
  let inspected;
  await run({ action: 'tabs', params: {} }, {
    sessionId: 's9',
    checkPermission: (targetTool, args) => { inspected = { targetTool, args }; return { allowed: true }; }
  });
  assert.equal(inspected.targetTool, 'browser.tabs');
  assert.equal(inspected.args.__actorSessionId, 's9', 'permission gate sees bound args (expand-then-decide, like tools.call)');
  // 校验失败发生在执行之前
  seen.length = 0;
  await assert.rejects(() => run({ action: 'nope', params: {} }, { sessionId: 's1' }), /Unknown action/);
  await assert.rejects(() => run({ action: 'click', params: {} }, { sessionId: 's1' }), /must have required property/);
  assert.deepEqual(seen, [], 'routing errors short-circuit before execute');

  // 工厂健壮性：规格与 catalog 漂移 fail-fast
  const browserSpec = RUN_TOOL_DOMAIN_SPECS.find(spec => spec.prefix === 'browser.');
  const runtimesSpec = RUN_TOOL_DOMAIN_SPECS.find(spec => spec.prefix === 'runtimes.');
  assert.throws(() => buildRunToolDomain({ ...browserSpec, include: ['open', 'nonexistent'] }, TOOL_DEFS), /include lists unknown action/);
  assert.throws(() => buildRunToolDomain({ ...runtimesSpec, exclude: ['register', 'ghost'] }, TOOL_DEFS), /exclude lists unknown action/);
  assert.throws(() => buildRunToolDomain({ ...browserSpec, include: ['open'], exclude: ['close'] }, TOOL_DEFS), /mutually exclusive/);

  console.log('run-factory: OK (domain enum reconciliation, permission tiers, params validation, unknown action, binding injection)');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
