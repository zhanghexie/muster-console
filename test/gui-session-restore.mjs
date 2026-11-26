/**
 * GUI 会话恢复消毒与 delta 兜底（shared/guiWorker.ts 纯函数）：
 * - sanitizeRestoredMessages：重启加载剥离排队标记/挂起审批、pending 提问翻 aborted、
 *   审批剥离后的空壳 assistant 整条丢弃（僵尸控件防复发）；Cursor task 摊进主对话
 *   的 token 级思考/正文 flicker 拼回一段正文
 * - applyGuiMessageDelta：超前 partIndex（sync 替换瞬间竞态）不再静默丢增量
 * 运行: node test/gui-session-restore.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-restore-'));

// X2-F03：fixture 依赖改为自动收集——共享编译助手沿 guiWorker.ts 的静态 import
// 递归转译（含 subagentCharacters 等相对依赖），消灭手工清单，新增导入不再崩整套测试。
const compile = createSharedCompiler(root, tmp);
const { sanitizeRestoredMessages, applyGuiMessageDelta, coalesceFlickerStreamParts } = await import(
  pathToFileURL(compile('shared/guiWorker.ts')).href
);

// ---------- 排队标记剥离 ----------
{
  const msgs = [
    { id: 'u1', role: 'user', parts: [{ kind: 'text', text: '排队消息' }], queued: true, ts: 1 },
    { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '回复' }], ts: 2 }
  ];
  const out = sanitizeRestoredMessages(msgs);
  assert.equal(out[0].queued, undefined, '排队标记被剥离');
  assert.equal(out[1].parts.length, 1, '其余消息不受影响');
}

// ---------- 挂起审批剥离 + 空壳 assistant 丢弃 ----------
{
  const msgs = [
    {
      id: 'shell',
      role: 'assistant',
      parts: [],
      approval: { approvalId: 'ap-1', toolCallId: 'tc-1', toolName: 'bash', input: { command: 'ls' } },
      ts: 1
    },
    {
      id: 'a1',
      role: 'assistant',
      parts: [{ kind: 'text', text: '正文' }],
      approval: { approvalId: 'ap-2', toolCallId: 'tc-2', toolName: 'bash', input: {} },
      ts: 2
    }
  ];
  const out = sanitizeRestoredMessages(msgs);
  assert.equal(out.length, 1, '空壳 assistant（仅审批卡）整条丢弃');
  assert.equal(out[0].id, 'a1');
  assert.equal(out[0].approval, undefined, '有正文消息上的挂起审批被剥离');
}

// ---------- pending 提问翻 aborted；answered 保留回显 ----------
{
  const msgs = [
    {
      id: 'a1',
      role: 'assistant',
      parts: [{ kind: 'text', text: '在吗' }],
      userQuestion: { questionId: 'q1', questions: [{ id: 'i1', question: '选哪个' }], status: 'pending' },
      ts: 1
    },
    {
      id: 'a2',
      role: 'assistant',
      parts: [{ kind: 'text', text: '好的' }],
      userQuestion: {
        questionId: 'q2',
        questions: [{ id: 'i2', question: '继续吗' }],
        status: 'answered',
        answers: [{ id: 'i2', selected: ['继续'] }]
      },
      ts: 2
    }
  ];
  const out = sanitizeRestoredMessages(msgs);
  assert.equal(out[0].userQuestion.status, 'aborted', 'pending 提问终态化为 aborted');
  assert.equal(out[1].userQuestion.status, 'answered', 'answered 保留答案回显');
}

// ---------- v4 域事件旧提醒迁移为宿主静默插话 ----------
{
  const msgs = [{
    id: 'nudge-1',
    role: 'user',
    parts: [{ kind: 'text', text: '扩展领域状态已变化。来源：human，类型：state.changed。请重新读取当前 DomainRuntime 快照。' }],
    ts: 1
  }];
  const out = sanitizeRestoredMessages(msgs);
  assert.equal(out[0].host, true, '旧域事件提醒标记为宿主消息');
  assert.equal(out[0].steering, 'host', '旧域事件提醒恢复为静默插话');
}

// ---------- 无变化时原引用返回 ----------
{
  const msgs = [
    { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '干净历史' }], ts: 1 }
  ];
  assert.equal(sanitizeRestoredMessages(msgs), msgs, '干净历史原引用返回（省一次 sync）');
}

// ---------- 超前 partIndex：不丢增量 ----------
{
  const msg = { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'a' }], ts: 1 };
  // sync 刚替换成 parts:[]，delta 带着 partIndex=2 到达（渲染层尚无该 part）
  const empty = { ...msg, parts: [] };
  const out = applyGuiMessageDelta(empty, 2, 'text', '迟到的增量');
  assert.equal(out.parts.length, 1, '超前 delta 按新开一段落地');
  assert.equal(out.parts[0].text, '迟到的增量');
  // 指向 tool part 的 text delta（异常漂移）：尾部新开一段，不覆盖工具卡也不丢字
  const withTool = {
    ...msg,
    parts: [
      { kind: 'text', text: '前' },
      { kind: 'tool', tool: { id: 't1', name: 'bash', input: {}, status: 'ok' } }
    ]
  };
  const out2 = applyGuiMessageDelta(withTool, 1, 'text', '尾部续文');
  assert.equal(out2.parts.length, 3, 'kind 不符时尾部追加新段');
  assert.equal(out2.parts[1].kind, 'tool', '原 tool part 不被覆盖');
  assert.equal(out2.parts[2].text, '尾部续文');
}

// ---------- Cursor task 摊进主对话的 flicker 段：恢复时拼回一段正文 ----------
{
  const flicker = [];
  const chunks = [
    '2、打开 CustomFullCanvas，未',
    '折叠 TB_LoopTips_Full，也未',
    '(Anim_LoopTips)。 LoadForm 把 Background',
    '缓存在 AllForms，每次',
    'OpenForm 会 PreInit → Init'
  ];
  for (const c of chunks) {
    flicker.push({ kind: 'thinking', text: '嗯' });
    flicker.push({ kind: 'text', text: c });
  }
  const merged = coalesceFlickerStreamParts(flicker);
  assert.equal(merged.length, 1, 'token 级思考/正文交错应拼成一段');
  assert.equal(merged[0].kind, 'text');
  assert.match(merged[0].text, /CustomFullCanvas/);
  assert.match(merged[0].text, /PreInit/);

  const normal = [
    { kind: 'thinking', text: '先看入口再下结论。'.repeat(8) },
    { kind: 'text', text: '结论：主路径没问题，Save 上的透明度维护是死代码。'.repeat(3) }
  ];
  const kept = coalesceFlickerStreamParts(normal);
  assert.equal(kept, normal, '一两段长思考+长正文保持原 parts 引用');

  const withTool = [
    { kind: 'thinking', text: 'a' },
    { kind: 'text', text: '短1' },
    { kind: 'thinking', text: 'b' },
    { kind: 'text', text: '短2' },
    { kind: 'thinking', text: 'c' },
    { kind: 'text', text: '短3' },
    { kind: 'thinking', text: 'd' },
    { kind: 'text', text: '短4' },
    { kind: 'tool', tool: { id: 't1', name: 'task', input: {}, status: 'ok' } },
    { kind: 'text', text: '父代理总结。' }
  ];
  const split = coalesceFlickerStreamParts(withTool);
  assert.equal(split.length, 3, '工具卡两侧分段处理');
  assert.equal(split[0].kind, 'text');
  assert.equal(split[1].kind, 'tool');
  assert.equal(split[2].text, '父代理总结。');

  const restored = sanitizeRestoredMessages([
    { id: 'a1', role: 'assistant', parts: flicker, ts: 1 }
  ]);
  assert.equal(restored[0].parts.length, 1, 'sanitizeRestoredMessages 走同一条 coalesce');
  assert.equal(restored[0].parts[0].kind, 'text');
}

console.log('gui-session-restore: ok');
