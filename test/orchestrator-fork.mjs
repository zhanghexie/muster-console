/**
 * 调度会话 fork：caps 切点种子 / 原会话不动 / 新会话绑定。
 * 运行: node test/orchestrator-fork.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fork-'));
const compile = createSharedCompiler(root, tmp);

const {
  planOrchestratorFork,
  bindOrchestratorFork,
  toOrchestratorForkSeeds,
  forkSeedAppendPayloads,
  cloneOrchestratorForkMessage,
  forkedOrchestratorTitle,
  FORK_ZERO_USAGE
} = await import(pathToFileURL(compile('shared/orchestratorFork.ts')).href);

const u1 = { id: 'u1', role: 'user', content: '先问这个', createdAt: 100 };
const a1 = {
  id: 'a1',
  role: 'assistant',
  content: '先答',
  parts: [{ kind: 'text', text: '先答' }, { kind: 'tool', toolCall: { id: 't1', name: 'ls' } }],
  createdAt: 200,
  plan: { steps: [], status: 'pending' },
  userQuestion: { questionId: 'q1', questions: [], status: 'pending' }
};
const u2 = { id: 'u2', role: 'user', content: '再问那个', createdAt: 300, queued: true };
const local = { id: 'loc', role: 'assistant', content: '/help', createdAt: 250, local: true };

assert.equal(
  planOrchestratorFork({ busy: true, messages: [u1], uptoMessageId: 'u1' }).ok,
  false,
  'busy 应拒绝'
);
assert.match(
  planOrchestratorFork({ busy: true, messages: [u1], uptoMessageId: 'u1' }).error,
  /回合结束再 fork/
);

assert.equal(
  planOrchestratorFork({ busy: false, messages: [], uptoMessageId: 'u1' }).ok,
  false,
  '空会话应拒绝'
);

assert.equal(
  planOrchestratorFork({ busy: false, messages: [u1, a1], uptoMessageId: 'missing' }).ok,
  false,
  '切点不存在应拒绝'
);

const src = [u1, a1, u2];
const frozen = JSON.stringify(src);
const plan = planOrchestratorFork({ busy: false, messages: src, uptoMessageId: 'u1' });
assert.equal(plan.ok, true);
assert.equal(plan.copied.length, 1);
assert.equal(plan.copied[0].id, 'u1');
assert.deepEqual(plan.seeds, [{ role: 'user', text: '先问这个', ts: 100 }]);
assert.equal(JSON.stringify(src), frozen, '原消息数组不得被改');
assert.match(plan.title, /Fork ·/);
assert.match(plan.title, /先问这个/);
console.log('ok: 守卫 / 切到用户消息 / 原数组不动');

const mid = planOrchestratorFork({ busy: false, messages: src, uptoMessageId: 'a1' });
assert.equal(mid.ok, true);
assert.deepEqual(
  mid.copied.map((m) => m.id),
  ['u1', 'a1']
);
assert.equal(mid.copied[1].queued, undefined);
assert.equal(mid.copied[1].plan, undefined);
assert.equal(mid.copied[1].userQuestion, undefined);
assert.equal(mid.copied[1].parts.length, 2);
assert.notEqual(mid.copied[1].parts, a1.parts, 'parts 应深拷');
assert.deepEqual(
  mid.seeds.map((s) => s.text),
  ['先问这个', '先答']
);
assert.equal(
  mid.seeds.length,
  2,
  '工具卡不进种子正文（只留助手文本）'
);
console.log('ok: 分叉种子=历史前缀（含切点，剥 queued/plan/提问卡）');

const withLocal = planOrchestratorFork({
  busy: false,
  messages: [u1, local, a1],
  uptoMessageId: 'a1'
});
assert.deepEqual(
  withLocal.seeds.map((s) => s.role),
  ['user', 'assistant']
);
assert.equal(
  toOrchestratorForkSeeds([local]).length,
  0,
  'local 回显不进引擎种子'
);

const payloads = forkSeedAppendPayloads(mid.seeds, {
  api: 'openai-completions',
  provider: 'deepseek',
  model: 'v4'
});
assert.equal(payloads[0].role, 'user');
assert.equal(payloads[0].content, '先问这个');
assert.deepEqual(payloads[1].content, [{ type: 'text', text: '先答' }]);
assert.equal(payloads[1].provider, 'deepseek');
assert.equal(payloads[1].model, 'v4');
assert.equal(payloads[1].stopReason, 'stop');
assert.equal(payloads[1].usage.totalTokens, FORK_ZERO_USAGE.totalTokens);
console.log('ok: appendMessage 种子载荷');

const bound = bindOrchestratorFork({
  copied: mid.copied,
  newSessionFile: '/pi-sessions/ws/fork.jsonl',
  originalSessionFile: '/pi-sessions/ws/orig.jsonl'
});
assert.equal(bound.piSessionFile, '/pi-sessions/ws/fork.jsonl');
assert.equal(bound.originalSessionFile, '/pi-sessions/ws/orig.jsonl');
assert.notEqual(bound.piSessionFile, bound.originalSessionFile, '新会话文件不得覆盖原文件');
assert.equal(bound.resetPiOnNextSend, false);
assert.deepEqual(bound.queue, []);
assert.deepEqual(
  bound.display.map((m) => m.id),
  ['u1', 'a1']
);
console.log('ok: 新会话注册（绑定新 Pi 文件，原文件指针保留）');

const clone = cloneOrchestratorForkMessage({
  ...u2,
  retryHint: '⏳',
  host: true
});
assert.equal(clone.queued, undefined);
assert.equal(clone.retryHint, undefined);
assert.equal(clone.host, true);

assert.equal(forkedOrchestratorTitle([]), 'Fork · 调度');

// 截点前剥完 local 后无可带正文 → 明确报错（不能 ok:true 带 error:undefined / 空种子建会话）
const allLocal = planOrchestratorFork({
  busy: false,
  messages: [local],
  uptoMessageId: 'loc'
});
assert.equal(allLocal.ok, false);
assert.ok(allLocal.error, '空种子必须给明确错误');
console.log('ok: 截点前无可带正文 → 明确报错');

console.log('orchestrator-fork: all assertions passed');
