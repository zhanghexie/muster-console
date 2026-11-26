/**
 * A2 提示词 stable/dynamic 分段 + D1 注入度量自测（zcode-adoption-plan，批次 R1）：
 * 分段顺序（stable 恒第 0 位）/ stable 字节不变量（Catalog 增删不触碰 stable）/
 * 单串形态一致性 / 注入度量构成（字符数 + UTF-8 字节数）。
 * 运行: node test/prompt-segments-injection.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-seg-'));
const compile = createSharedCompiler(root, tmp);
const systemPrompt = await import(pathToFileURL(compile('main/agent/systemPrompt.ts')).href);
// 同一临时目录产物：setDynamicToolSource 影响的 catalog 模块与 systemPrompt 引用的是同一实例
const catalog = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);
const { measureSchedulerInjection } = await import(
  pathToFileURL(compile('main/agent/injectionMetrics.ts')).href
);

const { buildMetaAgentAppendPrompt, buildMetaAgentAppendPromptText, MUSTER_PROMPT_SEGMENTS } =
  systemPrompt;

const DEMO_TOOL = {
  name: 'ext.demo.ping',
  description: 'ping 目标环境',
  dangerous: false,
  parameters: { type: 'object', properties: {}, required: [] }
};

// ---------- 分段形态：string[]，stable 恒第 0 位、catalog 恒第 1 位 ----------
{
  assert.deepEqual(MUSTER_PROMPT_SEGMENTS, ['stable', 'catalog'], '段名表=段序合同');
  const [stable, dynamic] = buildMetaAgentAppendPrompt('http://x', {
    customBody: '自定义正文',
    rules: [{ id: 'a', text: '调度规约甲', enabled: true }]
  });
  assert.match(stable, /^自定义正文\n\n## Global Conduct Rules/, 'stable=正文+规约，规约在其后');
  assert.match(stable, /调度规约甲/);
  assert.doesNotMatch(stable, /App Shell Capability Summary/, 'stable 不含 Catalog');
  assert.match(dynamic, /^## App Shell Capability Summary/, 'dynamic=Catalog 附录');
  assert.doesNotMatch(dynamic, /调度规约甲/, 'Catalog 段不夹带规约');

  // 无自定义规约时仍带宿主语言提示；单串预览与实际分段同源。
  const noRules = buildMetaAgentAppendPrompt('http://x', { customBody: '自定义正文' });
  assert.equal(noRules.length, 2);
  const { REPLY_LANGUAGE_GUIDANCE } = await import(pathToFileURL(compile('shared/workerGuidance.ts')).href);
  assert.equal(noRules[0], `自定义正文\n\n${REPLY_LANGUAGE_GUIDANCE}`);
  assert.equal(
    buildMetaAgentAppendPromptText('http://x', { customBody: '自定义正文' }),
    `${noRules[0]}\n\n${noRules[1]}`,
    '单串形态=两段 \n\n join（设置页预览与注入同源）'
  );
  console.log('ok   分段形态与单串一致性');
}

// ---------- 关键不变量：Catalog 增删工具，stable 段字节完全不变 ----------
{
  const before = buildMetaAgentAppendPrompt('http://x', { customBody: '自定义正文' });
  catalog.setDynamicToolSource(() => [{ def: DEMO_TOOL, trusted: true }]);
  const during = buildMetaAgentAppendPrompt('http://x', { customBody: '自定义正文' });
  catalog.setDynamicToolSource(null);
  const after = buildMetaAgentAppendPrompt('http://x', { customBody: '自定义正文' });

  assert.equal(before[0], during[0], '装载动态工具后 stable 字节不变');
  assert.equal(before[0], after[0], '卸载后 stable 字节不变');
  // A6 后组级地图撤出 system prompt：ext.* 装载/卸载连 dynamic 段也不动
  //（ext 工具经 pi 生成的 Available tools 段自行出现/消失），两段全部字节稳定
  assert.equal(before[1], during[1], 'A6 后 ext.* 装载不再触碰 dynamic 段');
  assert.equal(before[1], after[1], '卸载后 dynamic 段不变');
  assert.doesNotMatch(during[1], /\[ext\]/, 'ext 组行不再出现在 dynamic 段');
  // 顺序不变量：dynamic 永远在 stable 之后（pi \n\n join 后 stable 字节恒在前）
  assert.ok(before.indexOf(before[0]) === 0);
  console.log('ok   stable 字节不变量（Catalog 增删只动 dynamic 段；A6 后 ext.* 两段皆不动）');
}

// ---------- D1 注入度量：段名 + 字符数 + UTF-8 字节数 ----------
{
  const segments = buildMetaAgentAppendPrompt('http://x', { customBody: '自定义正文' });
  const metrics = measureSchedulerInjection(segments);
  assert.equal(metrics.length, segments.length, '度量段数=注入段数');
  assert.deepEqual(
    metrics.map((m) => m.name),
    ['stable', 'catalog'],
    '段名与段序一致（stable 在前）'
  );
  for (const [i, m] of metrics.entries()) {
    assert.equal(m.chars, segments[i].length, `${m.name} 字符数`);
    const bytes = Buffer.byteLength(segments[i], 'utf8');
    assert.equal(m.bytes, bytes, `${m.name} 字节数`);
    assert.ok(m.bytes >= m.chars, '中文 UTF-8 字节数 ≥ 字符数');
  }
  // catalog 地图单独可见（dynamic 段即 Catalog 地图，与 stable 分开计量）
  const stable = metrics.find((m) => m.name === 'stable');
  const cat = metrics.find((m) => m.name === 'catalog');
  assert.ok(stable.chars > 0 && cat.chars > 0, '两段都非空');
  assert.equal(measureSchedulerInjection(['一']).length, 1);
  console.log(`ok   注入度量构成（stable=${stable.chars}字/${stable.bytes}B，catalog=${cat.chars}字/${cat.bytes}B）`);
}

console.log('ok   prompt-segments-injection.mjs');
