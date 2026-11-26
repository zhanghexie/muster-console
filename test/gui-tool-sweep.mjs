/**
 * 工具卡「永远进行中」收口兜底回归（2026-09-14 三点动画 bug）。
 *
 * 背景：Cursor 服务端对并行工具偶发不发完成事件（真机原始流实锤：一批 4 条
 * tool_call status=running 只跟 3 条 completed；callId 形如 `call-…-11\nfc_…`）。
 * 模型侧结果已消费、回合正常结束，但宿主侧该工具卡停在 running——三点动画永远转，
 * 且随消息持久化在重启后复活。真机扫描 8 个会话 68 个卡死部件。
 *
 * 修复两层：finishTurn 收口终态化（cancelled）+ sanitizeRestoredMessages
 * 恢复消毒（清存量）。本文件守两层逻辑 + 接线契约。（轨迹账本已退役——
 * pi-trajectory-plan v3 B3'，原第三层「悬挂轨迹行修复」随之移除。）
 *
 * 运行: node test/gui-tool-sweep.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-tool-sweep-'));
const compile = createSharedCompiler(root, tmp);
const shared = await import(pathToFileURL(compile('shared/guiWorker.ts')).href);
const { finalizeRunningToolParts, sanitizeRestoredMessages } = shared;

const toolPart = (id, status, output) => ({
  kind: 'tool',
  tool: { id, name: 'grep', input: { pattern: 'x' }, status, ...(output ? { output } : {}) }
});
const assistantMsg = (parts) => ({
  id: 'm-asst',
  role: 'assistant',
  parts,
  ts: 2
});

// ---------- 1. finalizeRunningToolParts：收口语义 ----------
{
  const msg = assistantMsg([
    { kind: 'text', text: 'hi' },
    toolPart('t1', 'running'),
    toolPart('t2', 'ok', 'done'),
    toolPart('t3', 'running'),
    toolPart('t4', 'error', 'boom')
  ]);
  const swept = finalizeRunningToolParts(msg, '回合结束仍未收到该工具的结果');
  assert.deepEqual(swept, ['t1', 't3'], '只收尾 running 的，按出现顺序返回 callId');
  assert.equal(msg.parts[1].tool.status, 'cancelled');
  assert.equal(msg.parts[1].tool.output, '回合结束仍未收到该工具的结果', 'note 应写入 output（展开可见原因）');
  assert.equal(msg.parts[3].tool.status, 'cancelled');
  assert.equal(msg.parts[2].tool.status, 'ok', '已完成的不动');
  assert.equal(msg.parts[4].tool.status, 'error', '已失败的不动');
}
{
  const msg = assistantMsg([toolPart('t1', 'ok', 'done')]);
  assert.deepEqual(finalizeRunningToolParts(msg, 'note'), [], '无 running 返回空');
  assert.equal(msg.parts[0].tool.output, 'done', '无 note 写入点');
}
{
  const msg = assistantMsg([toolPart('t1', 'running')]);
  finalizeRunningToolParts(msg);
  assert.equal(msg.parts[0].tool.status, 'cancelled');
  assert.equal(msg.parts[0].tool.output, undefined, 'note 缺省不写 output（恢复消毒路径不带文案）');
}

// ---------- 2. sanitizeRestoredMessages：存量卡死在恢复时修复 ----------
{
  const clean = [{ id: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }], ts: 1 }];
  assert.equal(sanitizeRestoredMessages(clean), clean, '无进行时状态的数组原引用返回');
}
{
  const messages = [
    { id: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }], ts: 1 },
    assistantMsg([{ kind: 'text', text: 'a' }, toolPart('t1', 'running'), toolPart('t2', 'ok', 'd')]),
    assistantMsg([{ kind: 'text', text: 'b' }])
  ];
  const out = sanitizeRestoredMessages(messages);
  assert.notEqual(out, messages, '有修复时换新数组');
  assert.equal(out[0], messages[0], '无关消息保持原引用');
  assert.equal(out[2], messages[2], '无工具消息保持原引用');
  assert.equal(out[1].parts[0], messages[1].parts[0], '同消息内非工具 part 保持原引用');
  assert.equal(out[1].parts[1].tool.status, 'cancelled', '存量 running 恢复即修复为 cancelled');
  assert.equal(out[1].parts[1].tool.output, undefined, '恢复消毒不写诊断文案（卡面显示已取消即可）');
  assert.equal(out[1].parts[2].tool.status, 'ok', '已完成的保持');
  assert.equal(messages[1].parts[1].tool.status, 'running', '不得原地改传入的旧对象');
}

// ---------- 3. host 接线契约：收口兜底必须挂在 finishTurn ----------
// 2026-09-26 host 拆分：finishTurn 实现体在 host/turn.ts（host.ts 为组装壳垫片）
{
  const src = fs.readFileSync(path.join(root, 'src/main/agentSession/host/turn.ts'), 'utf8');

  const finishAt = src.indexOf('export function finishTurn(');
  assert.ok(finishAt > 0, 'finishTurn 应存在');
  const nextFnAt = src.indexOf('export function ', finishAt + 10);
  const finishBody = src.slice(finishAt, nextFnAt < 0 ? src.length : nextFnAt);
  assert.match(
    finishBody,
    /finalizeRunningToolParts\(finishedAssistant/,
    'finishTurn 必须收口仍 running 的工具卡（还原即转红：卡死复现）'
  );
}

// ---------- 5. 渲染/类型契约：cancelled 是合法状态且不再 live ----------
{
  const guiWorkerSrc = fs.readFileSync(path.join(root, 'src/shared/guiWorker.ts'), 'utf8');
  assert.match(
    guiWorkerSrc,
    /status: 'running' \| 'ok' \| 'error' \| 'cancelled'/,
    'GuiToolCallView 状态联合必须含 cancelled'
  );
  const viewSrc = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/ChatMessageView.tsx'),
    'utf8'
  );
  assert.match(viewSrc, /tc\.status === 'cancelled'/, '渲染层必须有 cancelled 分支（已取消）');
  assert.match(
    viewSrc,
    /const live = tc\.status === 'running';/,
    'live（三点动画）只随 running，cancelled 不得继续转'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('gui-tool-sweep: 5 组断言全过');
