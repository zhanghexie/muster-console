/**
 * scheduler-memory F-01 回归（2026-10-26 用户卡片批准修复）：「记住」回执成功必须
 * 可达模型上下文。调度面 memory.remember 生产路径（knowledgeTools.rememberKnowledge）
 * 入类型化知识库候选（origin=user、explicit、user_confirmed 证据、调度命名空间与
 * 仓库绑定），经后台记忆会话 save 决策落 active record 后：
 * ① 核心常驻注入 MemoryService.injectKnowledge('scheduler') 可见该条（调度面真源=
 *    类型化 records 表，非 .muster/scheduler/MEMORY.md）；
 * ② 任务召回 recallKnowledge 可见该条；
 * ③ 全程不写 MEMORY.md（直写通道已随本修复退役删除，守卫见 scheduler-memory-tools.mjs）。
 * Run: node test/scheduler-memory-reach.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-memory-reach-'));
const compile = createSharedCompiler(root, tmp);
const load = (file) => import(pathToFileURL(compile(file)).href);

const { MemoryService } = await load('main/memory/service.ts');
const { rememberKnowledge } = await load('main/memory/knowledgeTools.ts');
const { setMemoryCandidateSink } = await load('main/memory/curatorRef.ts');
const { runWithTurnUserText } = await load('main/agent/turnScope.ts');
const { runAsSchedulerTool } = await load('main/agent/agentScope.ts');

const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const svc = new MemoryService();

try {
  // ---------- 1) 生产 remember 入口：调度面明示「记住」→ 类型化候选 ----------
  const received = [];
  setMemoryCandidateSink(svc, (_root, candidate) => {
    received.push(candidate);
    return { queued: true, candidateId: candidate.id, reason: '已入队，尚未生效' };
  });
  const directive = '调度派单前先看需要你名单，避免重复催办。';
  const userText = `记住：${directive}`;
  const receipt = await runAsSchedulerTool(() =>
    runWithTurnUserText(userText, () =>
      rememberKnowledge(svc, ws, directive, undefined, { repoKey: ws, branch: undefined }, ['调度记忆'])
    )
  );
  assert.equal(receipt.queued, true, 'remember 回执成功入队');
  assert.equal(received.length, 1, '候选恰好一条');
  const candidate = received[0];
  assert.equal(candidate.namespace, 'scheduler', '调度调用链候选进 scheduler 命名空间');
  assert.equal(candidate.origin, 'user', '明示记住 origin=user');
  assert.equal(candidate.explicit, true, '宿主绑定 explicit（非模型自报）');
  assert.equal(candidate.evidence[0].verification, 'user_confirmed', '证据等级 user_confirmed');
  assert.equal(candidate.evidence[0].source, 'user-explicit');
  assert.equal(candidate.sourceText, userText, '候选携带用户原话');
  assert.equal(candidate.repoKey, ws, '候选绑定执行仓库');

  // ---------- 2) 后台记忆会话 save 决策 → active record（生产链路同款入口） ----------
  const store = svc.knowledge(ws, 'scheduler');
  const decision = store.commitCuratorDecision(
    {
      operationId: `op-${candidate.id}`,
      candidateId: candidate.id,
      policyVersion: 'policy-fixture-1',
      decision: 'save',
      reason: '用户明确要求保存，来源可信',
      sourceQuote: directive,
      draft: { kind: 'stable_constraint', summary: directive, applicability: [] }
    },
    {
      namespace: 'scheduler',
      origin: 'user',
      explicit: true,
      sourceText: candidate.sourceText,
      userText: candidate.sourceText,
      repoKey: candidate.repoKey,
      branch: candidate.branch,
      evidence: candidate.evidence
    }
  );
  assert.equal(decision.disposition, 'active', 'explicit 候选 save 决策直接生效');
  assert.equal(decision.record.status, 'active');

  // ---------- 3) 可达性①：核心常驻注入可见 ----------
  const inj = svc.injectKnowledge(ws, 'scheduler');
  assert.ok(inj.text.includes('### 持续约束'), '核心注入分节在');
  assert.ok(
    inj.text.includes(directive),
    'remember 内容进入调度面核心常驻注入（injectKnowledge）——F-01 断链不复现'
  );

  // ---------- 4) 可达性②：任务召回可见 ----------
  const recall = await svc.recallKnowledge(ws, '派单 催办 需要你', 'scheduler');
  assert.ok(
    recall.includes(directive),
    'remember 内容可被任务召回（recallKnowledge）——F-01 断链不复现'
  );

  // ---------- 5) 全程不写 MEMORY.md（直写通道已退役） ----------
  assert.equal(
    fs.existsSync(path.join(ws, '.muster', 'scheduler', 'MEMORY.md')),
    false,
    'remember 不再直写 .muster/scheduler/MEMORY.md'
  );
  assert.equal(
    fs.existsSync(path.join(ws, 'docs', 'memory', 'MEMORY.md')),
    false,
    'remember 不写共享 docs/memory/MEMORY.md'
  );
  console.log('scheduler-memory-reach: remember→候选→active→注入/召回可达，MEMORY.md 不落盘');
} finally {
  setMemoryCandidateSink; // sink 绑定在实例上，随实例丢弃
  svc.closeAll();
  const rel = path.relative(os.tmpdir(), tmp);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) fs.rmSync(tmp, { recursive: true, force: true });
}
