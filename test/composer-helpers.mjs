/**
 * AgentComposer 纯函数回归（2026-09-26 拆分后锁定，防拆分/重构漂移）：
 * 1) formatTokenCount 人类可读 token 计数（M/k/空串尾零）；
 * 2) findTrigger 斜杠/@ 触发词解析（词首空白、查询含空白终止、@ 优先近光标）；
 * 3) isUnsupportedSlash 未支持命令判定（/new、/skill:*、飞书命令、可选 /compact 豁免）；
 * 4) buildSlashItems 斜杠菜单装配（dispatch vs gui-session 命令分叉、/compact 能力位、
 *    过滤、技能与 ACP 引擎命令合并次序）；
 * 5) deriveContextUsage 上下文用量展示（空环锚点、无分母、百分比行）；
 * 6) deriveDraftQueueCapsules 打字入队建议（手动确认/排队发送）。
 * 运行: node test/composer-helpers.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-helpers-'));
const compile = createSharedCompiler(root, tmp);

const helpers = await import(
  pathToFileURL(compile('renderer/src/components/agentComposer/composerHelpers.ts')).href
);
const {
  formatTokenCount,
  findTrigger,
  isUnsupportedSlash,
  buildSlashItems,
  deriveContextUsage,
  deriveDraftQueueCapsules
} = helpers;

// ── 1) formatTokenCount ──
assert.equal(formatTokenCount(0), '0');
assert.equal(formatTokenCount(999), '999');
assert.equal(formatTokenCount(1000), '1k');
assert.equal(formatTokenCount(1500), '1.5k');
assert.equal(formatTokenCount(15000), '15k');
assert.equal(formatTokenCount(99_999), '100k'); // k 档 toFixed(0) 进位（既有行为，锁定）
assert.equal(formatTokenCount(100_000), '100k');
assert.equal(formatTokenCount(102_400), '102k');
assert.equal(formatTokenCount(1_000_000), '1M');
assert.equal(formatTokenCount(2_100_000), '2.1M');
assert.equal(formatTokenCount(15_728_640), '16M');

// ── 2) findTrigger ──
assert.deepEqual(findTrigger('hello', 5), null, '无触发符');
assert.deepEqual(findTrigger('/', 1), { kind: 'slash', start: 0, query: '' });
assert.deepEqual(findTrigger('/sk', 3), { kind: 'slash', start: 0, query: 'sk' });
assert.deepEqual(findTrigger('hi @src', 7), { kind: 'at', start: 3, query: 'src' });
// 触发符不在词首（前面非空白）→ 不触发
assert.equal(findTrigger('a/b', 3), null);
// 查询含空白（token 已结束）→ 不触发
assert.equal(findTrigger('/cmd arg', 8), null);
// @ 与 / 并存时取离光标最近者
assert.deepEqual(findTrigger('/x @y', 5), { kind: 'at', start: 3, query: 'y' });
assert.deepEqual(findTrigger('/x @y ', 2), { kind: 'slash', start: 0, query: 'x' });

// ── 3) isUnsupportedSlash ──
assert.equal(isUnsupportedSlash('/new'), false);
assert.equal(isUnsupportedSlash('/clear'), false);
assert.equal(isUnsupportedSlash('/skill:review'), false);
assert.equal(isUnsupportedSlash('/SKILL:Review'), false, 'skill 前缀大小写不敏感');
assert.equal(isUnsupportedSlash('/status'), false, '飞书命令不判未支持');
assert.equal(isUnsupportedSlash('hello'), false, '非斜杠正文');
assert.equal(isUnsupportedSlash('/nope'), true);
assert.equal(isUnsupportedSlash('/compact', false), true, '无能力位时 /compact 落未支持');
assert.equal(isUnsupportedSlash('/compact', true), false, '有能力位时 /compact 是本地命令');
assert.equal(isUnsupportedSlash('/compact 重点', true), false);
assert.equal(isUnsupportedSlash('/workflow demo x', false, true), false, '调度表面放行工作流命令');
assert.equal(isUnsupportedSlash('/workflow-new 做个流程', false, true), false);
assert.equal(isUnsupportedSlash('/workflow demo', false, false), true, 'GUI 表面工作流命令仍未支持');

// ── 4) buildSlashItems ──
const id = (k, o) => k; // 恒等 t：key=中文原文，断言直接比对 key
const skills = [{ name: 'review', description: '评审' }];
const engine = [{ name: 'plan_stuff', inputHint: 'args', description: 'ACP 提供的命令' }];

const dispatch = buildSlashItems([], '', false, undefined, false, id);
const labels = dispatch.map((i) => i.label);
for (const must of ['/status', '/status v', '/new', '/clear', '/stop', '/quickInput', '/help', '/model']) {
  assert.ok(labels.includes(must), `调度菜单应含 ${must}`);
}
assert.ok(!labels.includes('/compact'), '无 onCompact 时不得列 /compact');

const dispatchCompact = buildSlashItems([], '', false, undefined, true, id);
assert.ok(
  dispatchCompact.map((i) => i.label).includes('/compact'),
  '有 onCompact 时 /compact 在列'
);

const gui = buildSlashItems(skills, '', true, engine, true, id);
const guiLabels = gui.map((i) => i.label);
for (const banned of ['/status', '/status v', '/help', '/model', '/bind', '/unbind', '/workflow-new', '/workflow']) {
  assert.ok(!guiLabels.includes(banned), `GUI 菜单不得列调度专属 ${banned}`);
}
for (const must of ['/new', '/clear', '/stop', '/quickInput', '/compact', '/skill:review', '/plan_stuff']) {
  assert.ok(guiLabels.includes(must), `GUI 菜单应含 ${must}`);
}
// 合并次序：本地命令 → 引擎命令 → 技能
assert.ok(
  guiLabels.indexOf('/plan_stuff') < guiLabels.indexOf('/skill:review'),
  '引擎命令先于技能条目'
);
assert.equal(gui.find((i) => i.id === 'cmd:new').description, id('清空聊天，下轮从新会话开始'));
assert.equal(
  dispatch.find((i) => i.id === 'cmd:new').description,
  id('清空聊天并开始新 Pi 会话'),
  '/new 描述按表面分叉'
);

// 过滤：label 前缀 / label 包含 / 描述包含
const filtered = buildSlashItems([], 'stat', false, undefined, false, id);
assert.deepEqual(filtered.map((i) => i.label), ['/status', '/status v']);
const byDesc = buildSlashItems([], '飞书', false, undefined, false, id);
assert.ok(!byDesc.some(i => i.id === 'cmd:bind' || i.id === 'cmd:unbind'), 'retired desktop binding actions are absent');

const wfs = [{ name: 'nightly-test-fix', description: '夜间测试' }, { name: 'plain' }];
const withWf = buildSlashItems([], '', false, undefined, false, id, wfs);
assert.ok(!withWf.some((i) => i.id.startsWith('cmd:workflow')), '调度菜单不列工作流命令或名称');
assert.ok(
  !buildSlashItems([], '', true, undefined, false, id, wfs).some((i) => i.id.startsWith('cmd:workflow')),
  'GUI 会话不列工作流'
);

// ── 5) deriveContextUsage ──
assert.equal(deriveContextUsage(null, '', id), null, '无模型名且无用量 → 不渲染');
assert.deepEqual(deriveContextUsage(null, 'gpt-x', id), {
  frac: null,
  label: id('上下文 —')
});
assert.deepEqual(deriveContextUsage({ tokens: null, contextWindow: 200_000 }, 'gpt-x', id), {
  frac: null,
  label: id('上下文 —')
});
assert.deepEqual(deriveContextUsage({ tokens: 88_000, contextWindow: 0 }, 'gpt-x', id), {
  frac: null,
  label: id('已用 {{used}}', { used: '86k' })
});
const full = deriveContextUsage({ tokens: 88_000, contextWindow: 200_000 }, 'gpt-x', id);
assert.equal(full.frac, 0.44);
assert.equal(full.label, '44% · 88k/200k');
const near = deriveContextUsage({ tokens: 190_000, contextWindow: 200_000 }, 'gpt-x', id);
assert.equal(near.frac, 0.95);

// ── 6) deriveDraftQueueCapsules（打字入队建议）──
{
  const base = { hasText: true, hasImages: false, busy: false, queuedCount: 0 };
  assert.deepEqual(
    deriveDraftQueueCapsules({ ...base, hasText: false, hasImages: false }),
    [],
    '无正文无图不出胶囊'
  );
  assert.deepEqual(deriveDraftQueueCapsules(base), ['to-manual'], '空闲无队列：只建议手动确认');
  assert.deepEqual(
    deriveDraftQueueCapsules({ ...base, busy: true }),
    ['to-manual', 'to-queue'],
    '忙：手动确认 + 排队发送'
  );
  assert.deepEqual(
    deriveDraftQueueCapsules({ ...base, queuedCount: 2 }),
    ['to-manual', 'to-queue'],
    '已有排队：手动确认 + 排队发送'
  );
  assert.deepEqual(
    deriveDraftQueueCapsules({ ...base, hasImages: true, busy: true }),
    ['to-manual', 'to-queue'],
    '带图也出手动确认（清单支持随文图片）'
  );
  assert.deepEqual(
    deriveDraftQueueCapsules({ ...base, hasText: false, hasImages: true }),
    ['to-manual'],
    '图-only 空闲：仍可入手动确认'
  );
}
console.log('ok   deriveDraftQueueCapsules 入队建议推导');

console.log('composer-helpers: 纯函数回归全部通过');
