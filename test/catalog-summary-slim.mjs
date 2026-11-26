/** 目录发现、短附录与稳定提示词分段的回归守卫。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-slim-'));
const compile = createSharedCompiler(root, tmp);
const catalog = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);
const systemPrompt = await import(pathToFileURL(compile('main/agent/systemPrompt.ts')).href);

const { TOOL_DEFS, catalogAppendixText, searchHostToolDirectory } = catalog;
const { buildCatalogAppendix, buildMetaAgentAppendPrompt } = systemPrompt;

// Runtime guidance must agree in the registered session schema and scheduler prompt.
// `sessions.create` 在 R5 文案压缩后不再复述 CLI 警告（路由策略已由 worker-routing 档位承载），
// 因此这里守两件事：必须指引 target 路由、不得出现推荐 CLI 的措辞；runtime 字段必须标 legacy。
{
  const create = catalog.getToolDef('sessions.create');
  assert.match(create.description, /Pass target from host\.workers\.options/i);
  assert.doesNotMatch(create.description, /CLI is recommended/i);
  // 配置面收归引用：runtime 不再是 create 参数，子代理继承语义保留在 asSubagent 描述里。
  assert.equal(create.parameters.properties.runtime, undefined, 'runtime is not a create parameter');
  assert.match(create.parameters.properties.asSubagent.description, /inherit from the parent/i);
  assert.match(catalog.getToolDef('runs.delegate').description, /CLI Workers are not recommended.*explicit runtime/i);
  assert.match(systemPrompt.buildDefaultDispatcherAppendBody(), /CLI Workers receive reporting instructions/i);
}

// ---------- 各静态家族可通过统一目录发现 ----------
{
  const groups = [...new Set(TOOL_DEFS.map((t) => t.name.split('.')[0]))];
  for (const group of groups) assert.ok(searchHostToolDirectory(TOOL_DEFS, { group }).total > 0);
  console.log('ok   所有静态家族均可发现');
}

// ---------- 常驻指引只讲直调流程与当前家族，完整 schema 随工具注册 ----------
{
 const appendix=catalogAppendixText();
 assert.doesNotMatch(appendix,/tools\.search/); assert.doesNotMatch(appendix,/tools\.call/);
 assert.match(appendix,/resident and registered natively/);
 assert.match(appendix,/run entries/); assert.match(appendix,/skills\//);
 assert.doesNotMatch(appendix,/^- /m,'不复制每项工具描述');
 assert.doesNotMatch(appendix,/tasks\.|chat\.injectBrief|codeAnalysis/);
 for(const def of TOOL_DEFS) if(def.description.length>40) assert.ok(!appendix.includes(def.description),'完整说明不重复注入');
 assert.ok(appendix.length<1000,'短索引有界');
 const exact=searchHostToolDirectory(TOOL_DEFS,{name:'browser.setViewport'});
 assert.ok(exact.tool.parameters.oneOf,'发现返回完整校验约束');
 assert.ok(exact.help,'浏览器详细帮助跟随精确发现');
 console.log('ok: 发现指引有界、完整 schema 和帮助按需返回');
}

// ---------- 调度提示词拼装后：标题在 dynamic 段，全篇无组行 ----------
{
  const appendixSeg = buildCatalogAppendix();
  assert.match(appendixSeg, /^## App Shell Capability Summary/, '附录标题保留（设置页与 agent-rules 锚点）');
  assert.match(appendixSeg, /resident tools; no discovery layer/);
  assert.doesNotMatch(appendixSeg, /\[sessions\] \d+ 个工具/, '拼装后无组行');

  const [, dynamic] = buildMetaAgentAppendPrompt('http://x', { customBody: '自定义正文' });
  assert.equal(dynamic, appendixSeg, 'dynamic 段=buildCatalogAppendix 产物');
  console.log('ok   调度提示词 dynamic 段拼装（标题 + 瘦身附录，无组行）');
}

// ---------- ext.* 动态装载/卸载不再触碰 system prompt（组地图撤出后的新不变量） ----------
{
  const before = catalogAppendixText();
  catalog.setDynamicToolSource(() => [
    {
      def: {
        name: 'ext.demo.ping',
        description: 'ping 目标环境',
        dangerous: false,
        parameters: { type: 'object', properties: {}, required: [] }
      },
      trusted: true
    },
    {
      def: {
        name: 'ext.ci.deploy',
        description: '触发部署',
        dangerous: true,
        parameters: { type: 'object', properties: {}, required: [] }
      },
      trusted: false
    }
  ]);
  const during = catalogAppendixText();
  const entries=catalog.dynamicToolEntries().map(x=>x.def);
  assert.equal(searchHostToolDirectory(entries,{name:'ext.demo.ping'}).tool.name,'ext.demo.ping');
  assert.equal(before,during,'动态装载不复制 schema 到提示附录');
  assert.doesNotMatch(during, /\[ext\]/, 'ext 组行不再出现在附录');
  assert.doesNotMatch(during, /- ext\.demo\.ping/, '动态工具不进 per-tool 行');

  catalog.setDynamicToolSource(null);
  assert.equal(catalogAppendixText(), before, '卸载后附录仍不变');
  console.log('ok   ext.* 动态装载/卸载不触碰 system prompt 附录');
}

// 分域预算（tool-schema-disclosure P3）：单域默认 5,000 字符上限。
// 超出上限的域必须显式登记「现值 + 理由」——现值即上限，因此登记同时防回涨。
// 全局 48,000 保留为目标值并打印差距，不再作为硬断言：跨域总量取决于工具数量，
// 真正能指导决策的是「哪个域又胖了」，以及新增域不会一进来就吞掉几千字符。
{
  const { schedulerProjectedCatalog, workerPresetProjectedCatalog } = await import(pathToFileURL(compile('main/capabilities/catalog/projectedCatalog.ts')).href);
  const size = (entries) => entries.reduce((sum, entry) => {
    const def = entry.def ?? entry;
    return sum + JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }).length;
  }, 0);
  const DEFAULT_DOMAIN_BUDGET = 5000;
  /** 超预算登记：理由 + 现值（现值即上限）。新增条目必须说明为什么不能下沉到技能文档。 */
  const OVERBUDGET_DOMAINS = new Map([
    ['host.sessions', 14749, '高频会话编排：create/observe/review/integrate 的逐字段约束直接影响任务隔离与验收，压描述会诱发错参'],
    ['host.events', 5191, '订阅/发布/审核同域，事件载荷与投递语义无法在不丢失正确性的前提下下沉']
  ]);

  const entries = schedulerProjectedCatalog();
  const groups = new Map();
  for (const entry of entries) {
    const parts = entry.def.name.split('.');
    const group = parts[0] === 'host' && parts.length > 1 ? `host.${parts[1]}` : parts[0];
    groups.set(group, (groups.get(group) ?? 0) + JSON.stringify({
      name: entry.def.name, description: entry.def.description, parameters: entry.def.parameters
    }).length);
  }
  const faces = [
    ['scheduler', entries],
    ['gui-full', workerPresetProjectedCatalog('gui-full', true)],
    ['acp-subset', workerPresetProjectedCatalog('acp-subset', true)],
    ['pty-allowlist', workerPresetProjectedCatalog('pty-allowlist', true)]
  ].map(([face, list]) => [face, list.length, size(list)]);
  for (const [face, count, chars] of faces) console.log(`      ${face.padEnd(14)} ${String(count).padStart(3)} tools ${String(chars).padStart(6)} chars`);
  const total = faces[0][2];
  console.log(`      目标 48000，当前 ${total}，差额 ${total - 48000}`);

  for (const [group, chars] of [...groups].sort((a, b) => b[1] - a[1])) {
    const registered = OVERBUDGET_DOMAINS.get(group);
    const limit = registered ?? DEFAULT_DOMAIN_BUDGET;
    assert.ok(chars <= limit,
      `${group}: ${chars} chars exceeds its ${limit} budget. Sink parameters into the domain skill, or register the new baseline with a reason in OVERBUDGET_DOMAINS.`);
  }
  // 登记值必须等于现值：涨或跌都要显式改数字，杜绝「旧上限内免费回涨」与登记腐烂。
  for (const [group, limit] of OVERBUDGET_DOMAINS) {
    const chars = groups.get(group) ?? 0;
    assert.equal(chars, limit, `${group}: baseline ${limit} is stale (current ${chars}); update OVERBUDGET_DOMAINS with a reason`);
  }
  // 总量 ratchet：分域预算管单域，这一条管「每个域各涨一点」。改善总量后请下调该常量。
  const TOTAL_RATCHET = 55900;
  assert.ok(total <= TOTAL_RATCHET, `scheduler total ${total} exceeds ratchet ${TOTAL_RATCHET}; lower the constant when the catalog shrinks`);
}

console.log('ok   catalog-summary-slim.mjs');
