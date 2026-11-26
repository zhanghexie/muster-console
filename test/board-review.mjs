/**
 * P12 / R4：需要你列过滤 + 验收快照 / 打回简报 / 留痕截断。
 * Run: node test/board-review.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-review-'));
const compile = createSharedCompiler(root, tmp);
const {
  hiddenFromNeedsYouColumn,
  isNeedsYouPeekSession,
  gatedFromNeedsYouColumn,
  reviewFactsOf,
  appendAcceptanceLog,
  rejectInjectText,
  ACCEPTANCE_LOG_MAX
} = await import(pathToFileURL(compile('shared/boardReview.ts')).href);

const base = {
  id: 'aaaaaaaa-1111-4222-8333-444444444444',
  type: 'terminal',
  name: 'T12 看板',
  createdAt: 1,
  launchKind: 'agent',
  lifecycle: 'idle',
  status: 'running',
  phase: { value: 'needs_you', source: 'model', ts: 1 }
};

assert.equal(hiddenFromNeedsYouColumn({ archived: true }), true);
assert.equal(hiddenFromNeedsYouColumn({ lifecycle: 'exited' }), false);
assert.equal(hiddenFromNeedsYouColumn({ status: 'exited' }), false);
assert.equal(hiddenFromNeedsYouColumn({ lifecycle: 'idle', status: 'running' }), false);

assert.equal(isNeedsYouPeekSession(base, 10), true);
assert.equal(isNeedsYouPeekSession({ ...base, archived: true }, 10), false);
assert.equal(isNeedsYouPeekSession({ ...base, lifecycle: 'exited' }, 10), true);
assert.equal(isNeedsYouPeekSession({ ...base, reviewDeferred: true }, 10), false);
assert.equal(isNeedsYouPeekSession({ ...base, launchKind: 'shell' }, 10), false);

const facts = reviewFactsOf(
  {
    ...base,
    agentTaskId: 't-12',
    worktreeBranch: 'ao/aaaaaaaa',
    liveStatus: { label: '等验收', summary: 'npm test 171 绿', ts: 1 }
  },
  // 旧调用方即使仍传入未回信，也不能把它变成人类验收风险。
  [
    {
      id: 'a1',
      entryId: 'm-1',
      from: base.id,
      to: 'scheduler',
      tag: 'notice',
      question: '主仓有脏文件',
      createdAt: 1
    }
  ]
);
assert.equal(facts.shortId, 'aaaaaaaa');
assert.equal(facts.item, base.name);
assert.equal(facts.commits, 'ao/aaaaaaaa');
assert.equal(facts.summary, 'npm test 171 绿');
assert.equal('risks' in facts, false, '代理邮件不再作为人类验收风险');

const text = rejectInjectText('补回归');
assert.match(text, /补回归/);
assert.match(text, /验收打回|Review sent back/);

/* R-14：维度门红灯的 needs_you 会话不进「需要你」列/探出条（卡片留在工作列带徽标） */
const redGates = {
  at: 1,
  trigger: 'needs_you',
  results: [{ id: 'i18n', status: 'red', checkedFiles: ['src/shared/i18n/locales/en.ts'], problems: ['「新词」缺英文词条'] }]
};
assert.equal(gatedFromNeedsYouColumn(base), false, '无门结果照常进列');
assert.equal(gatedFromNeedsYouColumn({ ...base, dimensionGates: redGates }), true, '红灯挡下列');
assert.equal(
  gatedFromNeedsYouColumn({
    ...base,
    dimensionGates: { ...redGates, results: [{ ...redGates.results[0], status: 'green', problems: [] }] }
  }),
  false,
  '绿灯放行'
);
assert.equal(
  gatedFromNeedsYouColumn({ ...base, dimensionGates: redGates, phase: { value: 'idle', source: 'model', ts: 1 } }),
  false,
  '门只挡 needs_you 相位'
);
assert.equal(isNeedsYouPeekSession({ ...base, dimensionGates: redGates }, 10), false, '红灯不进探出条');
const activeAt = Date.now();
assert.equal(isNeedsYouPeekSession({ ...base, dimensionGates: redGates, activity: { kind: 'active', ts: activeAt } }, activeAt + 600_000), false,
  '分区与维度门必须使用同一个推导时刻，不能一边过期一边仍新鲜');
for (const extra of [{ lifecycle: 'exited' }, { activity: { kind: 'blocked', ts: 1 } }]) {
  const attention = { ...base, dimensionGates: redGates, ...extra };
  assert.equal(gatedFromNeedsYouColumn(attention), false, '旧验收红灯不能隐藏退出或审批');
  assert.equal(isNeedsYouPeekSession(attention, 10), true);
}

let log = [];
for (let i = 0; i < ACCEPTANCE_LOG_MAX + 5; i++) {
  log = appendAcceptanceLog(log, { at: i, decision: 'processed' });
}
assert.equal(log.length, ACCEPTANCE_LOG_MAX);
assert.equal(log[0].at, 5);

// 2026-09-26 sessions.ts 拆分：integrate 成功收尾（留痕/归档）在 git/worktreeIntegrate.ts
const integrateSrc = fs.readFileSync(path.join(root, 'src', 'main', 'git', 'worktreeIntegrate.ts'), 'utf8');
assert.match(integrateSrc, /recordAcceptance\(s\.id/, 'integrate 成功须留 passed 痕');
assert.match(integrateSrc, /setArchived\(sessionId, true\)/, 'integrate 后须归档');
const finishHits = integrateSrc.match(/return finishIntegrate\(/g);
assert.equal(
  finishHits?.length,
  3,
  '单仓、嵌套组与跨组任务都走共同成功留痕（清理由各路径显式决定）'
);

const markSrc = fs.readFileSync(path.join(root, 'src/main/capabilities/hosts/sessions.ts'), 'utf8');
assert.match(markSrc, /sessions\.review/);
assert.match(markSrc, /markProcessed\(s\.id/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('board-review: ok');
