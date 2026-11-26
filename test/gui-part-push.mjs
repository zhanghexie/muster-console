/**
 * GUI 会话 part 级增量推送自测（2026-09-14 性能专项回归）。
 *
 * 背景：一个回合的所有工具卡都挂在同一条 assistant 消息的 parts 上（真机 277 个
 * 工具卡 / 2.29MB 工具输出 / 消息只有 4 条），所以旧实现在每个 tool-start 与
 * tool-result 都推全量 messages——一个回合 554 次、每次渲染层固定开销实测 3.39ms，
 * 主进程另有同量克隆。改为只推变化的那一个 part。
 *
 * 运行: node test/gui-part-push.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-part-'));
const compile = createSharedCompiler(root, tmp);
const { applyGuiMessagePart } = await import(pathToFileURL(compile('shared/guiWorker.ts')).href);

const toolPart = (id, status, output) => ({
  kind: 'tool',
  tool: { id, name: 'Shell', input: { cmd: 'ls' }, status, ...(output ? { output } : {}) }
});
const baseMessages = () => [
  { id: 'm-user', role: 'user', parts: [{ kind: 'text', text: 'hi' }], ts: 1 },
  {
    id: 'm-asst',
    role: 'assistant',
    parts: [{ kind: 'text', text: 'ok' }, toolPart('t1', 'running')],
    ts: 2
  }
];

// ---------- 1. 引用契约：只有目标消息与目标 part 换引用 ----------
{
  const before = baseMessages();
  const after = applyGuiMessagePart(before, 'm-asst', 1, toolPart('t1', 'ok', 'done'));
  assert.ok(after, '正常路径不应返回 null');
  assert.notEqual(after, before, '列表本身必须换引用（否则 setState 不触发）');
  assert.equal(after[0], before[0], '其他消息必须保持原引用，否则那行白重渲');
  assert.notEqual(after[1], before[1], '目标消息必须换引用，否则该行不重渲');
  assert.equal(after[1].parts[0], before[1].parts[0], '同消息内未变的 part 也要保持引用');
  assert.equal(after[1].parts[1].tool.status, 'ok');
  assert.equal(after[1].parts[1].tool.output, 'done');
  assert.equal(before[1].parts[1].tool.status, 'running', '不得原地改传入的旧对象');
}

// ---------- 2. 追加：partIndex === parts.length 是 tool-start 的正常路径 ----------
{
  const before = baseMessages();
  const after = applyGuiMessagePart(before, 'm-asst', 2, toolPart('t2', 'running'));
  assert.ok(after, 'partIndex 等于长度是追加，不是不同步');
  assert.equal(after[1].parts.length, 3);
  assert.equal(after[1].parts[2].tool.id, 't2');
  assert.equal(before[1].parts.length, 2, '旧列表不受影响');
}

// ---------- 3. 不同步：必须返回 null 让调用方回退全量 ----------
{
  const before = baseMessages();
  assert.equal(
    applyGuiMessagePart(before, 'm-not-here', 0, toolPart('t9', 'ok')),
    null,
    '消息不在本地（已清空/fork 走）→ 回退全量'
  );
  assert.equal(
    applyGuiMessagePart(before, 'm-asst', 5, toolPart('t9', 'ok')),
    null,
    'partIndex 跳号（错过前序推送）→ 回退全量，静默丢会让工具卡永久缺块'
  );
  assert.equal(
    applyGuiMessagePart(before, 'm-asst', -1, toolPart('t9', 'ok')),
    null,
    '负下标 → 回退全量'
  );
}

// ---------- 4. host 接线：工具事件走 part，消息级变化仍走全量 sync ----------
// 2026-09-26 host 拆分：事件泵在 host/events.ts，审批/提问处理在 host/approvals.ts
{
  const src = fs.readFileSync(path.join(root, 'src/main/agentSession/host/events.ts'), 'utf8');
  assert.equal(
    (src.match(/syncPart\(host, entry, entry\.assistant/g) ?? []).length,
    2,
    'tool-start 与 tool-result 两处都必须走 syncPart（否则全量 sync 回归）'
  );
  assert.match(
    src,
    /export function appendToolProgress\([\s\S]*?syncPart\(host, entry, assistant, hit\)/,
    '子代理 tool-progress 必须走 syncPart（贴工具卡，不摊进主对话）'
  );
  // 两条退路：挂了计划卡（消息级变化）、找不到对应工具卡（driver 违约）
  assert.match(
    src,
    /entry\.assistant\.plan\) syncEntry\(host, entry\)/,
    '挂计划卡是消息级变化，必须退回全量 sync'
  );
  assert.match(
    src,
    /if \(hit >= 0\) syncPart\(host, entry, entry\.assistant, hit\);\s*else \{ persistEntry\(host, entry, \[entry\.assistant\]\); syncEntry\(host, entry\); \}/,
    '找不到工具卡时必须先保存消息再退回全量 sync'
  );
  // 审批/提问是消息级变化，仍通过全量 sync 发布完整交互状态。
  const approvalsSrc = fs.readFileSync(
    path.join(root, 'src/main/agentSession/host/approvals.ts'),
    'utf8'
  );
  const approvalAt = approvalsSrc.search(/export (async )?function handleApprovalRequest/);
  const questionAt = approvalsSrc.search(/export (async )?function handleUserQuestionRequest/);
  assert.ok(approvalAt > 0 && questionAt > 0, '审批/提问处理函数应存在');
  assert.match(
    approvalsSrc.slice(approvalAt, questionAt),
    /syncEntry\(host, entry\)/,
    '审批卡必须走全量 sync 发布完整状态'
  );
  assert.match(
    approvalsSrc.slice(questionAt, questionAt + 2500),
    /syncEntry\(host, entry\)/,
    '提问卡必须走全量 sync 发布完整状态'
  );
}

// ---------- 5. 渲染层接线：先排干正文增量，缺少已加载的目标时重同步 ----------
{
  const surfaceSrc = fs.readFileSync(
    path.join(root, 'src/renderer/src/chatSurface/agentSessionSurface.tsx'),
    'utf8'
  );
  assert.match(surfaceSrc, /payload\.kind === 'part'/, '必须处理 part 推送');
  assert.match(surfaceSrc, /applyGuiMessagePart\(/, '应复用共享纯函数，不要在 surface 里另写一份');
  assert.match(
    surfaceSrc,
    /if \(!next\) \{(?:\s*\/\/[^\r\n]*)*\s*if \(this\.historyHasEarlier && typeof window\.api\.agentSession\.historyRange === 'function'\) return;\s*this\.resync\(\);/,
    '未加载的历史由分页读取补齐，其他找不到目标的情况必须 resync'
  );
  assert.match(
    surfaceSrc,
    /this\.batcher\.flush\(\);\s*const next = applyGuiMessagePart/,
    'part 落定前必须排干 delta 队列（同消息 partIndex 定位顺序敏感）'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('gui-part-push: 5 组断言全过');
