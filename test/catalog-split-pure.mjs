/** Catalog 公开 API、退役入口移除、统一发现和参数校验回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-split-'));
const compile = createSharedCompiler(root, tmp);
// 走 catalog.ts 垫片入口：同时验证垫片 → 子目录模块的完整解析链
const catalog = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);

/** 当前工具名，用于各静态家族的发现验证 */
const TOOL_NAMES = catalog.TOOL_DEFS.map(t=>t.name);

// ---------- 1. 名称唯一，退役功能不再注册 ----------
{
  const names = catalog.TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size,names.length,'工具名唯一');
  assert.ok(!names.includes('tools.search') && !names.includes('tools.call'), 'R5 发现层退役出册');
  assert.ok(names.includes('mcp.search') && names.includes('mcp.call'), 'MCP 中转双工具在册');
  assert.ok(!names.some(n=>/^(tasks|codeAnalysis|facts)\./.test(n)),'已删除能力无残留注册');
  assert.ok(!names.includes('chat.injectBrief'));
}

// ---------- 2. 静态家族均可发现 ----------
{
  for (const group of new Set(TOOL_NAMES.map(name => name.split('.')[0]))) {
    assert.ok(catalog.searchHostToolDirectory(catalog.TOOL_DEFS, { group }).total > 0, group + ' 可经统一目录发现');
  }
}

// ---------- 3. 公开 API 面（垫片再导出完整） ----------
{
  for (const k of [
    'CATALOG_VERSION', 'TOOL_DEFS', 'setDynamicToolSource', 'dynamicToolEntries',
    'toApiName', 'fromApiName', 'getToolDef', 'getCatalogInfo',
     'catalogSnippetFor', 'hasNamedParameters', 'catalogAppendixText',
    'resolveToolCallArgs', 'WORKER_TOOL_ALLOWLIST', 'isWorkerAllowedTool',
    'EXTENSION_HOST_TOOLS', 'isExtensionHostTool'
  ]) {
    assert.ok(catalog[k] !== undefined, `公开导出 ${k} 存在`);
  }
  assert.equal(catalog.CATALOG_VERSION,'1.65.0');
  assert.equal(catalog.getToolDef('sessions.create').parameters.properties.task.type,'string');
  assert.equal(catalog.getToolDef('sessions.create').parameters.properties.locks,undefined);
}

// ---------- 4. 行为保持：dangerous 确认参数注入（withDangerousConfirmParams 语义） ----------
{
  const dangerous = catalog.TOOL_DEFS.filter((t) => t.dangerous).map((t) => t.name);
  assert.ok(dangerous.length>15,'原有危险操作仍需确认');
  for (const n of ['sessions.delete', 'sessions.review', 'sessions.integrate', 'automations.runNow', 'themes.remove', 'llm.setDefault']) {
    assert.ok(dangerous.includes(n), `${n} 仍为 dangerous`);
  }
  const { schedulerProjectedCatalog, workerPresetProjectedCatalog } = await import(
    pathToFileURL(compile('main/capabilities/catalog/projectedCatalog.ts')).href
  );
  for (const name of ['host.runtimes.register', 'host.runtimes.registerDriver', 'host.runtimes.driverTrustStatus']) {
    assert.ok(!workerPresetProjectedCatalog('gui', true).some(def => def.name === name));
  }
  assert.ok(schedulerProjectedCatalog().some(def => def.name === 'host.runtimes.run'));
  const extensionsEntries = catalog.TOOL_DEFS.filter(def => def.name === 'extensions.run');
  assert.equal(extensionsEntries.length, 1, 'the extension domain has one public router');
  assert.deepEqual(Object.keys(extensionsEntries[0].parameters.properties).sort(), ['action', 'params']);
  assert.equal(extensionsEntries[0].dangerous, false);
  assert.ok(!extensionsEntries[0].parameters.properties.action.enum.includes('run'), 'legacy arbitrary execution stays retired');
  assert.equal(catalog.getToolDef('runtimes.driverTrustStatus'), undefined, '暂停期间模型看不到自定义 Driver 信任状态');
  assert.equal(catalog.getToolDef('runtimes.confirmDriverTrust'), undefined, '模型不得获得信任授予工具');
  const ig = catalog.getToolDef('sessions.integrate');
  assert.equal(ig.confirmAction, '合入', '确认动词不变');
  assert.ok('confirmNote' in ig.parameters.properties, '危险工具经 getToolDef 注入 confirmNote');
  assert.ok(!('confirmNote' in catalog.getToolDef('sessions.observe').parameters.properties), '非危险工具不注入 confirmNote');
  // 原始 TOOL_DEFS 不得被注入污染（注入只发生在 getToolDef/getCatalogInfo 投影层）
  assert.ok(!('confirmNote' in catalog.TOOL_DEFS.find((t) => t.name === 'sessions.integrate').parameters.properties), 'TOOL_DEFS 原始条目不被投影污染');
}

// Model tools no longer accept runtime registration of ext.* names.
assert.equal(catalog.getToolDef('ext.demo.ping'), undefined);
assert.equal(catalog.fromApiName('ext_demo_ping'), 'ext_demo_ping');
assert.doesNotMatch(catalog.catalogAppendixText(), /ext\.demo\.ping/);

// ---------- 6. 行为保持：resolveToolCallArgs 双形态三出口 ----------
{
  assert.deepEqual(catalog.resolveToolCallArgs({ id: 'x', n: 1 }), { ok: true, args: { id: 'x', n: 1 } }, '命名参数直传');
  assert.deepEqual(catalog.resolveToolCallArgs({ arguments_json: '{"id":"x"}', id: 'y' }), { ok: true, args: { id: 'y' } }, '命名参数存在时忽略 arguments_json（防串味）');
  assert.deepEqual(catalog.resolveToolCallArgs({ arguments_json: '{"id":"x"}' }), { ok: true, args: { id: 'x' } }, 'arguments_json 字符串形态兼容');
  assert.deepEqual(catalog.resolveToolCallArgs({}), { ok: true, args: {} }, '皆空 → 空对象');
  const bad = catalog.resolveToolCallArgs({ arguments_json: '{oops' });
  assert.equal(bad.ok, false, '非法 JSON → ok:false');
  // 裸编译环境 i18n 回落中文 key 原文（en 词条由 i18n 覆盖闸保证存在）
  assert.ok(bad.error.includes('Invalid arguments JSON'), `错误文案语义不变：${bad.error}`);
}

// ---------- 7. 独立动作摘要与长度帽 ----------
{
  assert.equal(catalog.catalogSnippetFor({name:'example.read',description:'读取一条记录。详细说明'}),'读取一条记录');
  assert.equal(catalog.catalogSnippetFor({name:'example.read',description:'详情',summary:'读取指定记录'}),'读取指定记录');
  assert.equal(catalog.catalogSnippetFor({name:'example.empty',description:''}),'example.empty');
  assert.equal(catalog.catalogSnippetFor({name:'example.long',description:'x'.repeat(80)}).length,41);
}

// ---------- 8. 行为保持：hasNamedParameters / 名称往返 ----------
{
  assert.equal(catalog.hasNamedParameters(catalog.TOOL_DEFS.find((t) => t.name === 'sessions.observe')), true);
  assert.equal(catalog.hasNamedParameters(catalog.TOOL_DEFS.find((t) => t.name === 'runtimes.list')), false, '无 properties 工具保持泛型兜底');
  assert.equal(catalog.toApiName('sessions.observe'), 'sessions_observe');
  assert.equal(catalog.fromApiName('sessions_observe'), 'sessions.observe');
  assert.equal(catalog.fromApiName('no_such_tool'), 'no_such_tool', '未知名透传');
}

// ---------- 9. 行为保持：Worker / Ext 白名单 ----------
{
  assert.equal(catalog.WORKER_TOOL_ALLOWLIST.length > 0, true);
  assert.ok(catalog.isWorkerAllowedTool('sessions_setStatus'), '下划线名归一为点名');
  // R2：browser 域收敛为 browser.run 单入口，直调名退出 Worker 白名单
  assert.ok(catalog.isWorkerAllowedTool('browser.run'));
  assert.equal(catalog.isWorkerAllowedTool('browser.snapshot'), false, 'browser 直调名不再对 Worker 开放');
  assert.equal(catalog.isWorkerAllowedTool('sessions_delete'), false, '删除类不进 Worker 白名单');
  assert.ok(catalog.isExtensionHostTool('host_sessions_create'));
  assert.ok(catalog.isExtensionHostTool('host_node_repl_js'));
  assert.equal(catalog.isExtensionHostTool('sessions.delete'), false);
}

console.log('catalog-split-pure: ok (名称唯一 + 目录发现 + API 面 + 行为回归)');
