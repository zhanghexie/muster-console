/**
 * 全局行为规约（Agent Rules）：渲染纯函数 + 三个提示词面注入。
 * 运行: node test/agent-rules.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL as toFileUrl } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-'));
const compile = createSharedCompiler(root, tmp);

function pathToFileURL(p) {
  return toFileUrl(p).href;
}

const { normalizeAgentRules, renderAgentRulesSection } = await import(
  pathToFileURL(compile('shared/agentConduct.ts'))
);

// ---------- normalizeAgentRules：种子 / 清洗 / 显式空 ----------
{
  const seeded = normalizeAgentRules(undefined);
  assert.equal(seeded.length, 1, '缺字段 → 种子规则');
  assert.equal(seeded[0].id, 'report-anomalies');
  assert.equal(seeded[0].enabled, true);
  assert.match(seeded[0].text, /异常上报/);
  assert.doesNotMatch(seeded[0].text, /契约文件/);
  assert.match(seeded[0].text, /needs_you/);

  const oldLine = '3) 需要删除或修改其他组件依赖的契约文件（skills、宿主协议、被解析的文档格式）——先说明影响，等用户确认；';
  const oldText = `异常上报\n${oldLine}\n4) 任务无法完成（测试/构建失败、权限被拒、依赖缺失）。\n自定义补充`;
  const migrated = normalizeAgentRules([{ id: 'report-anomalies', enabled: false, text: oldText }]);
  assert.equal(migrated[0].enabled, false);
  assert.equal(migrated[0].text, '异常上报\n3) 任务无法完成（测试/构建失败、权限被拒、依赖缺失）。\n自定义补充');
  assert.equal(normalizeAgentRules([{ id: 'custom', text: oldText }])[0].text, oldText, '其他自定义规则原样保留');

  const cleaned = normalizeAgentRules([
    { id: 'a', text: '  规则A  ', enabled: false },
    { text: '规则B' },
    { id: 'c', text: '   ' },
    null,
    'junk'
  ]);
  assert.deepEqual(
    cleaned.map((r) => ({ id: r.id, text: r.text, enabled: r.enabled })),
    [
      { id: 'a', text: '规则A', enabled: false },
      { id: 'rule-2', text: '规则B', enabled: true }
    ],
    '空文本丢弃、缺 id 按序补、enabled 缺省 true'
  );

  assert.deepEqual(normalizeAgentRules([]), [], '显式空数组 = 用户删空，不回填种子');
  console.log('ok: normalizeAgentRules');
}

// ---------- full 变体 ----------
{
  assert.equal(renderAgentRulesSection(undefined), '', '无规则 → 空串（不产节）');
  assert.equal(renderAgentRulesSection([]), '', '空数组 → 空串');
  assert.equal(
    renderAgentRulesSection([{ id: 'x', text: '规则X', enabled: false }]),
    '',
    '全部停用 → 空串'
  );
  const section = renderAgentRulesSection([
    { id: 'a', text: '第一条', enabled: true },
    { id: 'b', text: '多行\n第二条', enabled: true }
  ]);
  assert.match(section, /^## Global Conduct Rules \(user-set; must be followed\)/);
  assert.match(section, /1\. 第一条/);
  assert.match(section, /2\. 多行\n第二条/);
  assert.doesNotMatch(section, /第三条/);
  console.log('ok: renderAgentRulesSection');
}

// ---------- 调度面：恒注入（不受 customBody 替换影响；A2 起返回 [stable, dynamic] 分段） ----------
const { buildMetaAgentAppendPrompt, buildMetaAgentAppendPromptText, buildCatalogAppendix } =
  await import(pathToFileURL(compile('main/agent/systemPrompt.ts')));
{
  const rules = [{ id: 'a', text: '调度规约甲', enabled: true }];
  const [stableSeg, catalogSeg] = buildMetaAgentAppendPrompt('http://x', {
    customBody: '自定义正文',
    rules
  });
  assert.match(stableSeg, /^自定义正文\n\n## Global Conduct Rules/, '规约在 customBody 之后（stable 段）');
  assert.match(stableSeg, /调度规约甲/);
  assert.match(catalogSeg, /^## App Shell Capability Summary/, 'Catalog 附录在 dynamic 段（恒排尾）');

  // 单串形态（两段 join）：既有断言在 join 结果上保持等价
  const withCustom = buildMetaAgentAppendPromptText('http://x', {
    customBody: '自定义正文',
    rules
  });
  assert.ok(withCustom.indexOf('调度规约甲') < withCustom.indexOf('App Shell Capability Summary'));

  const noRules = buildMetaAgentAppendPromptText('http://x', { customBody: '自定义正文' });
  assert.doesNotMatch(noRules, /Global Conduct Rules/, '无启用规则不产节');
  assert.match(noRules, /自定义正文\n\nReply in [^\n]+\n\n## App Shell Capability Summary/);
  console.log('ok: buildMetaAgentAppendPrompt 恒注入段');
}

// ---------- GUI Worker 面：插在工作区约定与语言之间 ----------
const { buildGuiWorkerSystemPrompt } = await import(
  pathToFileURL(compile('shared/guiWorkerPrompt.ts'))
);
{
  const base = { cwd: '/ws', mode: 'default', tools: [{ id: 'read', description: '读' }] };
  const plain = buildGuiWorkerSystemPrompt(base);
  assert.doesNotMatch(plain, /Global Conduct Rules/);

  const withRules = buildGuiWorkerSystemPrompt({
    ...base,
    rules: [{ id: 'a', text: 'Worker 规约乙', enabled: true }]
  });
  assert.match(withRules, /## Global Conduct Rules \(user-set; must be followed\)\n1\. Worker 规约乙/);
  assert.ok(withRules.indexOf('project instructions') < withRules.indexOf('## Global Conduct Rules'));
  console.log('ok: buildGuiWorkerSystemPrompt 规约节');
}

// ---------- Both CLI initial prompts carry enabled rules directly ----------
const { buildHostIntro, buildTaskBriefText } = await import(
  pathToFileURL(compile('shared/workerBrief.ts'))
);
{
  const options = { rules: [
    { id: 'on', text: '首先核对范围\n再报告结果', enabled: true },
    { id: 'off', text: '已停用规约', enabled: false }
  ] };
  for (const brief of [buildHostIntro(options), buildTaskBriefText('排查登录 500', { ...options, memorySection: '现有偏好' })]) {
    assert.match(brief, /Global Conduct Rules[\s\S]*首先核对范围\n再报告结果/);
    assert.doesNotMatch(brief, /已停用规约|HOST(?:-EXT)?\.md/);
    assert.match(brief, /MUSTER_HOST=1/);
    assert.match(brief, /MUSTER_STATUS_URL/);
  }
  assert.doesNotMatch(buildHostIntro({ rules: [] }), /Global Conduct Rules/);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] agent-rules');
