/**
 * 对话导航条停靠点模型自测：非 queued 用户消息各一格、回复摘录取该轮最后一段
 * 助手正文、仅图片消息保留（prompt 空但 hasImages）、无正文用户消息剔除。
 * 运行: node test/turn-rail.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-rail-'));

const entry = path.join(root, 'src/shared/chatTurnRail.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'chatTurnRail.mjs');
fs.writeFileSync(out, outputText, 'utf8');
const { buildTurnRailStops, locateAbortedTurn } = await import(pathToFileURL(out).href);

const user = (id, text, extra = {}) => ({
  id,
  role: 'user',
  parts: [{ kind: 'text', text }],
  ts: 1,
  ...extra
});
const assistant = (parts) => ({ id: 'a', role: 'assistant', parts, ts: 2 });

// 调度主进程的 user 消息只写 content，历史停靠点仍须可触发；老 assistant 也可能无 parts
{
  const stops = buildTurnRailStops([
    { id: 'dispatch-u', role: 'user', content: '调度提问', createdAt: 1 },
    { id: 'dispatch-a', role: 'assistant', content: '调度回复', createdAt: 2 }
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].prompt, '调度提问');
  assert.equal(stops[0].reply, '调度回复');
}

// 预览取该轮最后一段助手正文：跳过后续工具/思考，跨多个 assistant 消息仍取最后一段
{
  const stops = buildTurnRailStops([
    user('u1', '第一个问题'),
    assistant([{ kind: 'text', text: '开头' }, { kind: 'tool' }, { kind: 'text', text: '中段' }]),
    assistant([{ kind: 'thinking', text: '继续处理' }, { kind: 'text', text: '最终正文' }, { kind: 'tool' }]),
    user('u2', '第二个问题'),
    assistant([{ kind: 'text', text: '第二轮结尾' }])
  ]);
  assert.equal(stops[0].reply, '最终正文');
  assert.equal(stops[1].reply, '第二轮结尾');
}

// 排队消息尚未切轮；/status 本地回显不是该轮 AI 回复
{
  const stops = buildTurnRailStops([
    user('u1', '正在运行的问题'),
    user('q1', '后续问题', { queued: true }),
    assistant([{ kind: 'text', text: '模型最终回答' }]),
    { id: 'local', role: 'assistant', local: true, content: '/status 结果' }
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].reply, '模型最终回答');
}

// 正常轮次：回复摘录跳过纯思考/纯工具的助手消息，取末段正文
{
  const stops = buildTurnRailStops([
    user('u1', '第一个问题'),
    assistant([{ kind: 'thinking', text: '想一想' }]),
    assistant([
      { kind: 'tool', tool: { id: 't1', name: 'bash', input: {}, status: 'ok' } },
      { kind: 'text', text: '第一轮回复' }
    ]),
    user('u2', '第二个问题'),
    assistant([{ kind: 'text', text: '第二轮回复' }])
  ]);
  assert.equal(stops.length, 2);
  assert.deepEqual(
    stops.map((s) => s.id),
    ['u1', 'u2']
  );
  assert.equal(stops[0].prompt, '第一个问题');
  assert.equal(stops[0].reply, '第一轮回复');
  assert.equal(stops[1].prompt, '第二个问题');
  assert.equal(stops[1].reply, '第二轮回复');
  assert.equal(stops[0].hasImages, false);
}

// queued 剔除；无正文也无图片的空用户消息剔除；空白正文剔除
{
  const stops = buildTurnRailStops([
    user('u1', '正式消息'),
    user('u2', '排队中', { queued: true }),
    user('u3', ''),
    user('u4', '   '),
    assistant([{ kind: 'text', text: '回复' }])
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].id, 'u1');
}

// 仅图片附件：保留且 prompt 空串、hasImages 真
{
  const stops = buildTurnRailStops([
    {
      id: 'u1',
      role: 'user',
      parts: [{ kind: 'text', text: '' }],
      images: [{ path: 'E:/x.png' }],
      ts: 1
    }
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].prompt, '');
  assert.equal(stops[0].hasImages, true);
  assert.equal(stops[0].reply, '');
}

// 该轮未被回答（回复搜到下一条用户消息为止）：reply 空串；跨轮不串
{
  const stops = buildTurnRailStops([
    user('u1', '没有回复的问题'),
    assistant([{ kind: 'thinking', text: '只有思考' }]),
    user('u2', '下一个问题'),
    assistant([{ kind: 'text', text: '属于第二轮的回复' }])
  ]);
  assert.equal(stops.length, 2);
  assert.equal(stops[0].reply, '');
  assert.equal(stops[1].reply, '属于第二轮的回复');
}

// 空消息流
assert.deepEqual(buildTurnRailStops([]), []);

// 宿主注入不切新回合：不进停靠点，也不截断上一轮回复摘录
{
  const stops = buildTurnRailStops([
    user('u1', '第一个问题'),
    assistant([{ kind: 'thinking', text: '想一想' }]),
    user('h1', '【编排事件 · 1 条】', { host: true }),
    assistant([{ kind: 'text', text: '第一轮回复（宿主之后）' }]),
    user('u2', '第二个问题'),
    assistant([{ kind: 'text', text: '第二轮回复' }])
  ]);
  assert.equal(stops.length, 2);
  assert.deepEqual(
    stops.map((s) => s.id),
    ['u1', 'u2']
  );
  assert.equal(stops[0].reply, '第一轮回复（宿主之后）');
  assert.equal(stops[1].reply, '第二轮回复');
}

// 调度注入不进历史停靠点（不是人手打），也不截断上一轮回复摘录
{
  const stops = buildTurnRailStops([
    user('u1', '第一个问题'),
    assistant([{ kind: 'thinking', text: '想一想' }]),
    user('s1', '【调度回注 Worker】\n已办', { source: 'scheduler' }),
    user('child-report', '子代理汇报', { source: 'agent' }),
    assistant([{ kind: 'text', text: '第一轮回复（调度之后）' }]),
    user('u2', '第二个问题'),
    assistant([{ kind: 'text', text: '第二轮回复' }])
  ]);
  assert.equal(stops.length, 2);
  assert.deepEqual(
    stops.map((s) => s.id),
    ['u1', 'u2']
  );
  assert.equal(stops[0].reply, '第一轮回复（调度之后）');
  assert.equal(stops[1].reply, '第二轮回复');
}

// 宿主静默插话（steering:'host'）不是历史停靠点——透明模式把它渲染为插话线，
// 不是人打的用户回合（还原 isUserTurnMessage 的 m.steering !== 'host' 判断应转红）
{
  const stops = buildTurnRailStops([
    user('u1', '第一个问题'),
    assistant([{ kind: 'text', text: '回复' }]),
    { id: 'hs1', role: 'user', steering: 'host', parts: [{ kind: 'text', text: '【后台任务】到点' }] },
    assistant([{ kind: 'text', text: '继续回复' }])
  ]);
  assert.deepEqual(
    stops.map((x) => x.id),
    ['u1'],
    'host 插话不产生停靠点'
  );
  assert.equal(stops[0].reply, '继续回复', 'host 插话不截断该轮（摘录取轮内最后一段正文）');
}

// locateAbortedTurn：定位末轮已手动终止（aborted）的回合及其用户输入消息
{
  // 单轮终止：命中 u1 + a1
  const loc1 = locateAbortedTurn([
    user('u1', '待改问题'),
    { id: 'a1', role: 'assistant', aborted: true, parts: [{ kind: 'text', text: '半截' }], ts: 2 }
  ]);
  assert.deepEqual(loc1, {
    userIdx: 0,
    assistantIdx: 1,
    userMessageId: 'u1',
    assistantMessageId: 'a1'
  });

  // 末轮已完成，前轮曾终止：不命中旧轮
  const loc2 = locateAbortedTurn([
    user('u1', '第一轮终止'),
    { id: 'a1', role: 'assistant', aborted: true, parts: [], ts: 2 },
    user('u2', '第二轮完成'),
    { id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: '正常完成' }], ts: 4 }
  ]);
  assert.equal(loc2, null);

  // 多轮且末轮终止：只命中末轮 u2 + a2
  const loc3 = locateAbortedTurn([
    user('u1', '第一轮完成'),
    { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '正常完成' }], ts: 2 },
    user('u2', '第二轮终止'),
    { id: 'a2', role: 'assistant', aborted: true, parts: [], ts: 4 }
  ]);
  assert.deepEqual(loc3, {
    userIdx: 2,
    assistantIdx: 3,
    userMessageId: 'u2',
    assistantMessageId: 'a2'
  });
  assert.equal(
    locateAbortedTurn(
      [
        user('u1', '第一轮完成'),
        { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '正常完成' }], ts: 2 },
        user('u2', '第二轮终止'),
        { id: 'a2', role: 'assistant', aborted: true, parts: [], ts: 4 }
      ],
      'u1'
    ),
    null,
    'targetUserMessageId 不匹配末轮时不命中'
  );

  // 尾部有 queued / local / steering:'host' 时跳过它们仍能命中末轮终止
  const loc4 = locateAbortedTurn([
    user('u1', '被终止的问题'),
    { id: 'a1', role: 'assistant', aborted: true, parts: [], ts: 2 },
    { id: 'hs1', role: 'user', steering: 'host', parts: [{ kind: 'text', text: '后台唤醒' }], ts: 3 },
    user('q1', '排队消息', { queued: true }),
    { id: 'loc1', role: 'assistant', local: true, parts: [{ kind: 'text', text: '/status' }], ts: 4 }
  ]);
  assert.deepEqual(loc4, {
    userIdx: 0,
    assistantIdx: 1,
    userMessageId: 'u1',
    assistantMessageId: 'a1'
  });

  // 调度回注（source:'scheduler'）或宿主通栏（host:true）发起的终止轮不越界回退到上一轮人工用户消息
  const loc5 = locateAbortedTurn([
    user('u1', '上一轮人工消息'),
    { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '上一轮已完成' }], ts: 2 },
    user('s1', '调度催办', { source: 'scheduler' }),
    { id: 'a2', role: 'assistant', aborted: true, parts: [], ts: 4 }
  ]);
  assert.equal(loc5, null);
}

console.log('ok turn-rail');
