/**
 * P13 确认框人话摘要 / cancelledBy 解析。
 * Run: node test/confirm-payload.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-payload-'));
const compile = createSharedCompiler(root, tmp);
const out = compile('shared/confirmDialog.ts');
const {
  isConfirmed,
  parseConfirmIpcPayload,
  pickConfirmNote,
  humanizeConfirmArgs,
  firstSentence,
  integrateConfirmSummary,
  collectSessionRefs,
  confirmActionLabel,
  formatConfirmSessionContext,
  formatCloseConfirmSummary,
  formatCloseBatchConfirmSummary,
  buildDangerousConfirmSummary,
  reviewConfirmAction,
  reviewConfirmIntent,
  reviewConfirmSummary,
  runtimeConfirmSummary,
  dynamicToolConfirmSummary,
  llmUpsertProviderConfirmSummary,
  llmSetActiveConfirmSummary,
  scheduledServiceConfirmSummary
} = await import(pathToFileURL(out).href);
const { normalizeCloseBatchIds, planCloseBatch } = await import(
  pathToFileURL(compile('shared/sessionCloseBatch.ts')).href
);

assert.equal(isConfirmed(true), true);
assert.equal(isConfirmed(false), false);
assert.equal(isConfirmed({ confirmed: true }), true);
assert.equal(isConfirmed({ confirmed: false, cancelledBy: 'timeout' }), false);

assert.deepEqual(parseConfirmIpcPayload(true), { confirmed: true, kind: 'allowOnce' });
assert.deepEqual(parseConfirmIpcPayload(false), {
  confirmed: false,
  cancelledBy: 'button',
  kind: 'deny'
});
assert.deepEqual(parseConfirmIpcPayload({ confirmed: false, cancelledBy: 'backdrop' }), {
  confirmed: false,
  cancelledBy: 'backdrop',
  kind: 'deny'
});
assert.deepEqual(parseConfirmIpcPayload({ confirmed: false }), {
  confirmed: false,
  cancelledBy: 'button',
  kind: 'deny'
});
assert.deepEqual(parseConfirmIpcPayload({ confirmed: false, cancelledBy: 'esc' }), {
  confirmed: false,
  cancelledBy: 'esc',
  kind: 'deny'
});
assert.deepEqual(parseConfirmIpcPayload({ confirmed: false, cancelledBy: 'timeout' }), {
  confirmed: false,
  cancelledBy: 'timeout',
  kind: 'deny'
});

assert.equal(pickConfirmNote({ confirmNote: ' 合入 T3.4 ', reason: 'x' }), '合入 T3.4');
assert.equal(pickConfirmNote({ reason: '因为冲突已解' }), '因为冲突已解');
assert.equal(pickConfirmNote({}), '');

const human = humanizeConfirmArgs({
  sessionId: 'abc',
  target: 'main',
  confirmNote: '隐藏',
  nested: { a: 1 },
  apiKey: 'sk-secret',
  scriptSource: 'export async function execute() {}'
});
assert.ok(human.includes('sessionId: abc'));
assert.ok(human.includes('target: main'));
assert.ok(!human.includes('隐藏'));
assert.ok(human.includes('nested:'));
assert.ok(!human.includes('sk-secret'), '摘要不得泄漏 apiKey');
assert.ok(!human.includes('export async function'), '摘要不得倾倒 scriptSource');

assert.equal(firstSentence('把隔离 worktree 合入主分支。不要自己 merge。'), '把隔离 worktree 合入主分支。');
assert.equal(
  integrateConfirmSummary({ sessionId: '43e7b2bd-1111', target: 'main' }),
  '把会话 43e7b2bd-1111 合入 main'
);

assert.deepEqual(collectSessionRefs({ sessionId: 'abc', worktreePath: 'E:/wt', ids: ['x', ''], confirmNote: 'hide' }), [
  'abc',
  'E:/wt',
  'x'
]);
assert.equal(confirmActionLabel('删除'), '确认删除');
assert.equal(confirmActionLabel('合入'), '确认合入');
assert.equal(confirmActionLabel(), '确认执行');

const snap = {
  id: '43e7b2bd-1111-4222-8333-444444444444',
  name: '优化危险工具确认门',
  cwd: 'E:/ws/.worktrees/close-gate',
  phase: 'idle',
  lifecycle: 'exited',
  lastUsedAt: Date.UTC(2026, 8, 18, 4, 0, 0),
  archived: true
};
const ctxText = formatConfirmSessionContext(snap);
assert.match(ctxText, /优化危险工具确认门/);
assert.match(ctxText, /E:\/ws\/\.worktrees\/close-gate/);
assert.match(ctxText, /phase: idle/);
assert.match(ctxText, /lifecycle: exited/);
assert.ok(!ctxText.includes(snap.id), '有会话名时确认框不应只甩 UUID');

const closeText = formatCloseConfirmSummary(snap);
assert.match(closeText, /删除会话「优化危险工具确认门」/);
assert.match(closeText, /cwd:/);

const now = Date.UTC(2026, 8, 18, 6, 0, 0);
const batchText = formatCloseBatchConfirmSummary(
  {
    targets: [snap, { id: 'bbbb', name: '外观页头像', lastUsedAt: Date.UTC(2026, 8, 18, 5, 0, 0), archived: true }],
    failed: []
  },
  { now }
);
assert.match(batchText, /将永久删除 2 个已归档会话/);
assert.match(batchText, /优化危险工具确认门/);
assert.match(batchText, /外观页头像/);
assert.ok(!batchText.includes(snap.id), '批量确认应显示会话名而不是裸 UUID');

const integrateHuman = buildDangerousConfirmSummary({
  toolName: 'sessions.integrate',
  args: { sessionId: snap.id, target: 'main' },
  catalogSummary: '把会话 43e7b2bd-1111 合入 main',
  sessions: [{ ref: snap.id, session: snap }]
});
assert.match(integrateHuman, /把「优化危险工具确认门」合入 main/);
assert.match(integrateHuman, /cwd:/);

const reviewSnap = {
  ...snap,
  worktreePath: 'E:/ws/.worktrees/close-gate',
  worktreeBranch: 'ao/43e7b2bd'
};
const ctxWithTree = formatConfirmSessionContext(reviewSnap);
assert.match(ctxWithTree, /隔离树:/);
assert.match(ctxWithTree, /隔离分支: ao\/43e7b2bd/);

const reviewCases = [
  {
    decision: 'passed',
    withTree: true,
    expect: /验收通过「优化危险工具确认门」：将合入 main 并结任务 done/,
    action: '通过并合入',
    intent: /验收通过「优化危险工具确认门」并合入 main/
  },
  {
    decision: 'passed',
    withTree: false,
    expect: /验收通过「优化危险工具确认门」：无隔离树，将标记已处理并归档/,
    action: '通过并归档',
    intent: /验收通过「优化危险工具确认门」并标记已处理/
  },
  {
    decision: 'rejected',
    withTree: true,
    expect: /打回「优化危险工具确认门」重做：将回注打回说明并让任务回到进行中/,
    action: '打回重做',
    intent: /打回「优化危险工具确认门」重做/
  },
  {
    decision: 'deferred',
    withTree: true,
    expect: /搁置「优化危险工具确认门」的验收：仍留在需要你列，不进探出条/,
    action: '搁置',
    intent: /搁置「优化危险工具确认门」的验收/
  },
  {
    decision: 'processed',
    withTree: true,
    expect: /标记「优化危险工具确认门」已处理：仅归档，不合入/,
    action: '标记已处理',
    intent: /标记「优化危险工具确认门」已处理/
  }
];
for (const c of reviewCases) {
  const session = c.withTree
    ? reviewSnap
    : { ...snap, worktreePath: undefined, worktreeBranch: undefined };
  const text = buildDangerousConfirmSummary({
    toolName: 'sessions.review',
    args: { sessionId: snap.id, decision: c.decision, note: '合入说明已写清' },
    sessions: [{ ref: snap.id, session }]
  });
  assert.match(text, c.expect);
  assert.match(text, /备注：合入说明已写清/);
  assert.ok(!text.includes(snap.id), `${c.decision} 有会话名时不应甩 UUID`);
  assert.ok(!text.includes('decision:'), `${c.decision} 不应再 humanize 键值对`);
  assert.equal(reviewConfirmAction({ decision: c.decision }, session), c.action);
  assert.match(reviewConfirmIntent({ decision: c.decision }, session), c.intent);
}

const reviewBatchArgs = { decision: 'processed', sessionIds: [snap.id, 'bbbb', 'missing'] };
const reviewBatch = buildDangerousConfirmSummary({
  toolName: 'host.sessions.review', args: reviewBatchArgs,
  sessions: [{ ref: snap.id, session: snap }, { ref: 'bbbb', session: { ...snap, id: 'bbbb', name: '外观页头像' } }, { ref: 'missing' }]
});
assert.match(reviewBatch, /3 个会话.*清除维度门/);
assert.match(reviewBatch, /优化危险工具确认门/);
assert.match(reviewBatch, /外观页头像/);
assert.match(reviewBatch, /未找到会话 missing/);
assert.match(reviewConfirmIntent(reviewBatchArgs), /3 个会话/);
assert.match(reviewConfirmSummary(reviewBatchArgs), /清除维度门/);
const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);
applyLocaleSetting('en');
assert.match(reviewConfirmSummary(reviewBatchArgs), /3 sessions.*clear dimension gates/);
assert.match(reviewConfirmSummary({ sessionId: 'a', decision: 'processed' }), /clear dimension gates/);
applyLocaleSetting('zh-CN');

const reviewNoSnap = [
  {
    decision: 'passed',
    expect: /验收通过「43e7b2bd-1111-4222-8333-444444444444」：有隔离树则合入 main/,
    action: '通过并合入'
  },
  {
    decision: 'rejected',
    expect: /打回「43e7b2bd-1111-4222-8333-444444444444」重做：将回注打回说明/,
    action: '打回重做'
  },
  {
    decision: 'deferred',
    expect: /搁置「43e7b2bd-1111-4222-8333-444444444444」的验收：仍留在需要你列/,
    action: '搁置'
  },
  {
    decision: 'processed',
    expect: /标记「43e7b2bd-1111-4222-8333-444444444444」已处理：仅归档，不合入/,
    action: '标记已处理'
  }
];
for (const c of reviewNoSnap) {
  const text = reviewConfirmSummary({ sessionId: snap.id, decision: c.decision });
  assert.match(text, c.expect);
  assert.equal(reviewConfirmAction({ decision: c.decision }), c.action);
}

/* R-14：维度门红灯会话的 passed 确认摘要（强制验收分支） */
const gateRedSnap = { ...reviewSnap, dimensionGateRed: '维度门未过：多语言' };
{
  const text = buildDangerousConfirmSummary({
    toolName: 'sessions.review',
    args: { sessionId: snap.id, decision: 'passed', skipDimensionGate: true },
    sessions: [{ ref: snap.id, session: gateRedSnap }]
  });
  assert.match(text, /强制验收「优化危险工具确认门」：跳过维度门（维度门未过：多语言）并按验收通过处理/);
  assert.match(text, /将跳过维度门强制验收，验收账本留痕 dimension-gate-override/);
  assert.equal(reviewConfirmAction({ decision: 'passed', skipDimensionGate: true }, gateRedSnap), '强制验收（跳过维度门）');
}
{
  // 红灯但未带 skipDimensionGate（宿主会先硬阻断报错；快照层仍标出红灯供人看）
  const text = reviewConfirmSummary({ sessionId: snap.id, decision: 'passed' }, gateRedSnap);
  assert.match(text, /跳过维度门（维度门未过：多语言）/);
  assert.ok(!text.includes('将跳过维度门强制验收'), '未显式 skip 不得出现跳过留痕承诺');
  // 无红灯的会话不受门文案影响
  const plain = reviewConfirmSummary({ sessionId: snap.id, decision: 'passed', skipDimensionGate: true }, reviewSnap);
  assert.ok(!plain.includes('维度门'), '无红灯会话不应出现维度门文案');
}

assert.match(
  runtimeConfirmSummary('register', { id: 'my-rt', label: '我的引擎' }),
  /注册 runtime「我的引擎」（my-rt）/
);
assert.match(runtimeConfirmSummary('remove', { id: 'my-rt' }), /删除 runtime「my-rt」及脚本文件/);
assert.match(
  dynamicToolConfirmSummary('define', { id: 'demo', name: 'ping', dangerous: true }),
  /定义动态工具 ext\.demo\.ping/
);
assert.match(llmUpsertProviderConfirmSummary({ id: 'zhipu', apiKey: 'sk-leak' }), /zhipu/);
assert.ok(!llmUpsertProviderConfirmSummary({ id: 'zhipu', apiKey: 'sk-leak' }).includes('sk-leak'));
assert.match(
  llmSetActiveConfirmSummary({ providerId: 'zhipu', modelId: 'glm-5' }),
  /zhipu \/ glm-5/
);
assert.match(scheduledServiceConfirmSummary('create', { name: '每日日报' }), /创建定时任务「每日日报」/);
assert.equal(confirmActionLabel('通过并合入'), '确认通过并合入');
assert.equal(confirmActionLabel('打回重做'), '确认打回重做');

const serviceHuman = buildDangerousConfirmSummary({
  toolName: 'automations.delete',
  args: { automationId: 'svc-1' },
  serviceName: '每日日报'
});
assert.match(serviceHuman, /定时任务「每日日报」/);
assert.ok(!serviceHuman.includes('svc-1'));

const themeHuman = buildDangerousConfirmSummary({
  toolName: 'themes.remove',
  args: { id: 'theme-dark' },
  themeName: '石墨'
});
assert.match(themeHuman, /主题「石墨」/);

{
  const rows = [
    {
      id: 'aaaaaaaa-1111-4222-8333-444444444444',
      name: '已归档 A',
      archived: true,
      lastUsedAt: Date.UTC(2026, 8, 17),
      type: 'terminal'
    },
    {
      id: 'bbbbbbbb-1111-4222-8333-444444444444',
      name: '未归档 B',
      archived: false,
      type: 'terminal'
    },
    {
      id: 'cccccccc-1111-4222-8333-444444444444',
      name: '定时 C',
      archived: true,
      type: 'scheduled'
    }
  ];
  assert.deepEqual(normalizeCloseBatchIds({ sessionIds: [' a ', 'a', ''] }), ['a']);
  const ok = planCloseBatch(rows, ['aaaaaaaa']);
  assert.equal(ok.failed.length, 0);
  assert.equal(ok.targets[0].name, '已归档 A');
  const blocked = planCloseBatch(rows, ['aaaaaaaa', 'bbbbbbbb', 'missing']);
  assert.equal(blocked.targets.length, 1);
  assert.equal(blocked.failed.length, 2);
  assert.equal(blocked.failed.find((f) => f.reason === 'unarchived')?.name, '未归档 B');
  assert.equal(blocked.failed.find((f) => f.reason === 'missing')?.id, 'missing');
  const sched = planCloseBatch(rows, ['cccccccc']);
  assert.equal(sched.failed[0].reason, 'scheduled');
  const warnText = formatCloseBatchConfirmSummary(blocked, { now });
  assert.match(warnText, /不可删除（整批将中止）/);
  assert.match(warnText, /未归档 B/);
}

console.log('confirm-payload: ok');
