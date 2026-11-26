/**
 * GUI Worker v2 parts 消息模型自测：v1 扁平历史迁移、guiMessageText、
 * delta partIndex 追加的渲染层等价逻辑。
 * 运行: node test/gui-worker-parts.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-parts-'));
const out = createSharedCompiler(root, tmp)('shared/guiWorker.ts');
const {
  migrateGuiChatMessage,
  guiMessageText,
  applyGuiMessageDelta,
  guiChatMessageEqual,
  createGuiUserMessage
} = await import(pathToFileURL(out).href);

// ---------- v1 迁移：thinking → tools → text 的旧固定顺序 ----------
{
  const m = migrateGuiChatMessage({
    id: 'a1',
    role: 'assistant',
    text: '正文',
    thinking: '思考',
    tools: [
      { id: 't1', name: 'edit', input: {}, status: 'ok' },
      { id: 't2', name: 'bash', input: {}, status: 'ok' }
    ],
    ts: 123
  });
  assert.deepEqual(
    m.parts.map((p) => p.kind),
    ['thinking', 'tool', 'tool', 'text'],
    '旧渲染顺序保持'
  );
  assert.equal(guiMessageText(m), '正文');
  assert.equal(m.ts, 123);
}

// ---------- v1 空文本：parts 只剩 thinking/tools，不补空 text ----------
{
  const m = migrateGuiChatMessage({ id: 'a2', role: 'assistant', text: '', thinking: 't', ts: 1 });
  assert.deepEqual(
    m.parts.map((p) => p.kind),
    ['thinking'],
    '空文本不补空 part'
  );
}

// ---------- v1 完全空：兜底一个空 text ----------
{
  const m = migrateGuiChatMessage({ id: 'u1', role: 'user', text: '', ts: 1 });
  assert.deepEqual(
    m.parts.map((p) => p.kind),
    ['text'],
    '空消息兜底 text part'
  );
}

// ---------- 附加字段透传（approval/plan/error/aborted/queued） ----------
{
  const m = migrateGuiChatMessage({
    id: 'a3',
    role: 'assistant',
    text: 'x',
    error: 'boom',
    aborted: true,
    ts: 5
  });
  assert.equal(m.error, 'boom');
  assert.equal(m.aborted, true);
}

// ---------- 交错消息的文本拼接（多 text part 按序 join） ----------
{
  const m = {
    id: 'a4',
    role: 'assistant',
    ts: 1,
    parts: [
      { kind: 'thinking', text: '嗯' },
      { kind: 'text', text: '先说' },
      { kind: 'tool', tool: { id: 't', name: 'bash', input: {}, status: 'ok' } },
      { kind: 'text', text: '后说' }
    ]
  };
  assert.equal(guiMessageText(m), '先说后说', 'tool/thinking 不进纯文本');
}

// ---------- 渲染层 delta 追加（partIndex 定位；sync 空 parts 首包须新建） ----------
{
  const applyDelta = applyGuiMessageDelta;
  const base = {
    id: 'a5',
    role: 'assistant',
    ts: 1,
    parts: [
      { kind: 'thinking', text: '想' },
      { kind: 'text', text: '文' }
    ]
  };
  const afterThink = applyDelta(base, 0, 'thinking', '多了');
  assert.equal(afterThink.parts[0].text, '想多了');
  const afterText = applyDelta(afterThink, 1, 'text', '字');
  assert.equal(afterText.parts[1].text, '文字');
  // kind 不匹配的 delta 丢弃（防御：旧渲染层收到错位下标）
  const dropped = applyDelta(afterText, 0, 'text', '!');
  assert.equal(dropped.parts[0].text, '想多了', 'kind 不符不追加');
}

// ---------- sync 空 parts 后首条 delta 须流式可见（此前静默丢弃导致回合末一股脑） ----------
{
  const empty = { id: 'a6', role: 'assistant', ts: 1, parts: [] };
  const afterThink = applyGuiMessageDelta(empty, 0, 'thinking', '嗯');
  assert.equal(afterThink.parts.length, 1);
  assert.equal(afterThink.parts[0].text, '嗯');
  const afterText = applyGuiMessageDelta(afterThink, 1, 'text', '好');
  assert.equal(afterText.parts.length, 2);
  assert.equal(afterText.parts[1].text, '好');
  const grow = applyGuiMessageDelta(afterText, 1, 'text', '啊');
  assert.equal(grow.parts[1].text, '好啊');
}

// ---------- 渲染等价深比较（IPC sync 克隆后映射缓存的判据） ----------
{
  const msg = {
    id: 'a7',
    role: 'assistant',
    ts: 9,
    parts: [
      { kind: 'thinking', text: '想' },
      { kind: 'tool', tool: { id: 't', name: 'bash', input: { command: 'ls' }, status: 'ok', output: 'x' } },
      { kind: 'text', text: '文' }
    ],
    error: undefined,
    images: [{ id: 'img1', data: 'aa', mimeType: 'image/png' }]
  };
  // 结构相同的新对象（模拟 IPC 结构化克隆）判等
  assert.equal(guiChatMessageEqual(msg, JSON.parse(JSON.stringify(msg))), true, '同内容克隆相等');
  // 任一内容维度变化都能识破
  assert.equal(
    guiChatMessageEqual(msg, { ...msg, parts: [...msg.parts, { kind: 'text', text: '新' }] }),
    false,
    'parts 数量变化'
  );
  assert.equal(
    guiChatMessageEqual(msg, {
      ...msg,
      parts: [msg.parts[0], msg.parts[1], { kind: 'text', text: '别的' }]
    }),
    false,
    '文本内容变化'
  );
  assert.equal(
    guiChatMessageEqual(msg, {
      ...msg,
      parts: [msg.parts[0], { kind: 'tool', tool: { ...msg.parts[1].tool, status: 'error' } }, msg.parts[2]]
    }),
    false,
    '工具状态变化'
  );
  assert.equal(guiChatMessageEqual(msg, { ...msg, error: 'boom' }), false, 'error 出现');
  assert.equal(guiChatMessageEqual(msg, { ...msg, queued: true }), false, 'queued 出现');
  assert.equal(guiChatMessageEqual(msg, { ...msg, ts: 10 }), false, 'ts 变化');
  assert.equal(
    guiChatMessageEqual(msg, { ...msg, images: [{ id: 'img2', data: 'aa', mimeType: 'image/png' }] }),
    false,
    '图片 id 变化'
  );
  // 工具入参不同（同长度输出/状态）也要识破
  assert.equal(
    guiChatMessageEqual(msg, {
      ...msg,
      parts: [msg.parts[0], { kind: 'tool', tool: { ...msg.parts[1].tool, input: { command: 'rm' } } }, msg.parts[2]]
    }),
    false,
    '工具入参变化'
  );
  // B1-2：input 比较是无分配深度相等，不是 stringify 比较。两个方向都必须守住——
  // 还原成 JSON.stringify 比较时，下面两条都会转红（stringify 丢 undefined 值键、
  // 且对键序敏感，二者都是 stringify 判不准的形状）。
  // input 变化必须判不等：新增 undefined 值键也是入参变化（stringify 会把它丢掉）
  assert.equal(
    guiChatMessageEqual(msg, {
      ...msg,
      parts: [
        msg.parts[0],
        { kind: 'tool', tool: { ...msg.parts[1].tool, input: { command: 'ls', timeout: undefined } } },
        msg.parts[2]
      ]
    }),
    false,
    '工具入参新增键（undefined 值）'
  );
  // 嵌套结构里的值差异也要识破（深比较路径）
  assert.equal(
    guiChatMessageEqual(msg, {
      ...msg,
      parts: [
        msg.parts[0],
        {
          kind: 'tool',
          tool: { ...msg.parts[1].tool, input: { command: 'ls', opts: { depth: 2 } } }
        },
        msg.parts[2]
      ]
    }),
    false,
    '工具入参嵌套值变化'
  );
  // input 未变（键序不同）必须判等：stringify 对键序敏感会误判不等 → 无谓重映射
  const msg2 = {
    ...msg,
    parts: [
      msg.parts[0],
      { kind: 'tool', tool: { ...msg.parts[1].tool, input: { command: 'ls', cwd: '/a' } } },
      msg.parts[2]
    ]
  };
  const reordered = JSON.parse(JSON.stringify(msg2));
  reordered.parts[1].tool.input = { cwd: '/a', command: 'ls' };
  assert.equal(guiChatMessageEqual(msg2, reordered), true, '工具入参键序不同但内容相同');
}

// ---------- 调度注入 source：构造 / 迁移透传 / 等价比较 ----------
{
  const user = createGuiUserMessage({ id: 'u1', text: '手打', ts: 1 });
  assert.equal(user.source, undefined, '输入框发送不标 source');
  const injected = createGuiUserMessage({
    id: 's1',
    text: '【调度回注 Worker】\n已办',
    ts: 2,
    source: 'scheduler'
  });
  assert.equal(injected.source, 'scheduler');
  assert.equal(injected.role, 'user');
  assert.equal(guiChatMessageEqual(injected, { ...injected }), true);
  assert.equal(guiChatMessageEqual(injected, { ...injected, source: undefined }), false, 'source 参与等价');

  const migrated = migrateGuiChatMessage({
    id: 's2',
    role: 'user',
    text: '旧盘调度注入',
    ts: 3,
    source: 'scheduler'
  });
  assert.equal(migrated.source, 'scheduler', 'v1 迁移保留 source');
}

console.log('gui-worker-parts: all assertions passed');
