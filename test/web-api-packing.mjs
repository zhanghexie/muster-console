/**
 * webApiShim ARG_PACKERS 打包矩阵：位置参数 → 主进程单对象 payload。
 * 漏字段 = GUI 发送丢 steerOnBusy 误插话 / editQueued|reorderQueued 静默失效。
 * 契约对照 src/preload/index.ts 与 src/main/ipc/agentSession.ts。
 * Run: node test/web-api-packing.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-api-packing-'));
const compile = createSharedCompiler(root, tmp);
const { ARG_PACKERS, packInvokeArgs } = await import(
  pathToFileURL(compile('shared/webApiPacking.ts')).href
);

let passed = 0;
assert.deepEqual(packInvokeArgs('codex:listModels', ['codex-session', true]), [{ sessionId: 'codex-session', refresh: true }]);
assert.deepEqual(packInvokeArgs('codex:listModels', [{ workspaceId: 'ws', rootId: 'b', rootsRevision: 2 }, false]),
  [{ source: { workspaceId: 'ws', rootId: 'b', rootsRevision: 2 }, refresh: false }]);
const ok = (cond, label) => {
  assert.ok(cond, label);
  passed++;
};

/* ── B1: agentSession:send 必须带上第 4 参 opts（steerOnBusy） ── */
const sendQueued = packInvokeArgs('agentSession:send', ['sess-1', 'hello', undefined, { steerOnBusy: false }]);
assert.deepEqual(
  sendQueued,
  [{ sessionId: 'sess-1', text: 'hello', images: undefined, steerOnBusy: false }],
  'send 普通发送必须原样透传 steerOnBusy:false（忙时排队）'
);
passed++;

const sendSteer = packInvokeArgs('agentSession:send', ['s', 'now', [{ data: 'x', mimeType: 'image/png' }], { steerOnBusy: true }]);
assert.deepEqual(sendSteer[0], {
  sessionId: 's',
  text: 'now',
  images: [{ data: 'x', mimeType: 'image/png' }],
  steerOnBusy: true
}, 'sendNow 带图 + steerOnBusy:true');
passed++;

const sendNoOpts = packInvokeArgs('agentSession:send', ['s', 't', []]);
ok(sendNoOpts[0].sessionId === 's' && sendNoOpts[0].steerOnBusy === undefined, '无 opts 不硬塞 steerOnBusy（主进程缺省 true）');

// 还原回归：若 packer 又丢掉 a[3]，上面 steerOnBusy:false 断言会红
ok(ARG_PACKERS['agentSession:send'](['a', 'b', null, { steerOnBusy: false }])[0].steerOnBusy === false, 'steerOnBusy 字段守卫');

/* ── B2: editQueued / reorderQueued 打包器 ── */
assert.deepEqual(
  packInvokeArgs('agentSession:editQueued', ['sess-9', 'msg-3', '改后的文']),
  [{ sessionId: 'sess-9', messageId: 'msg-3', text: '改后的文' }],
  'editQueued → { sessionId, messageId, text }'
);
passed++;

assert.deepEqual(
  packInvokeArgs('agentSession:reorderQueued', ['sess-9', ['m1', 'm2']]),
  [{ sessionId: 'sess-9', orderedIds: ['m1', 'm2'] }],
  'reorderQueued → { sessionId, orderedIds }'
);
passed++;

ok(typeof ARG_PACKERS['agentSession:editQueued'] === 'function', 'editQueued packer 存在');
ok(typeof ARG_PACKERS['agentSession:reorderQueued'] === 'function', 'reorderQueued packer 存在');

/* ── 既有 packer 字段与 preload 一致 ── */
assert.deepEqual(packInvokeArgs('agentSession:cancelQueued', ['s', 'm']), [{ sessionId: 's', messageId: 'm' }], 'cancelQueued');
passed++;
assert.deepEqual(packInvokeArgs('agentSession:fork', ['s', 'upto']), [{ sessionId: 's', uptoMessageId: 'upto' }], 'fork');
passed++;
assert.deepEqual(packInvokeArgs('agentSession:setMode', ['s', 'yolo']), [{ sessionId: 's', mode: 'yolo' }], 'setMode');
passed++;
assert.deepEqual(packInvokeArgs('agentSession:setPiMode', ['s', 'mode-1']), [{ sessionId: 's', modeId: 'mode-1' }], 'setPiMode');
passed++;
assert.deepEqual(packInvokeArgs('agentSession:setModel', ['s', { providerId: 'p', modelId: 'm' }]), [
  { sessionId: 's', model: { providerId: 'p', modelId: 'm' } }
], 'setModel');
passed++;
assert.deepEqual(packInvokeArgs('agentSession:setThinking', ['s', 'high']), [{ sessionId: 's', level: 'high' }], 'setThinking');
assert.deepEqual(packInvokeArgs('agentSession:setModelParameters', ['s', { budget: 'large' }]), [{ sessionId: 's', changes: { budget: 'large' } }]);
passed++;
assert.deepEqual(packInvokeArgs('agentSession:planAction', ['s', 'execute']), [{ sessionId: 's', action: 'execute' }], 'planAction');
passed++;

/* ── 无打包器通道原样位置参数 ── */
assert.deepEqual(packInvokeArgs('sessions:list', []), [], '无 packer 不改形');
passed++;
assert.deepEqual(packInvokeArgs('chat:send', ['hi', 'ws']), ['hi', 'ws'], 'chat:send 保持位置参数');
passed++;
assert.deepEqual(packInvokeArgs('agentSession:getHistoryRange', ['s', 500, 120]), ['s', 500, 120], '范围读取位置参数不打包');
assert.deepEqual(packInvokeArgs('agentSession:getHistoryRange', ['s', undefined, 120, 'target']),
  ['s', undefined, 120, 'target'], '目标消息范围保持四个位置参数');
passed++;

/* ── preload 对照：凡多位置参且主进程收对象的 agentSession 通道都必须有 packer ── */
const required = [
  'agentSession:send',
  'agentSession:setMode',
  'agentSession:setPiMode',
  'agentSession:setModel',
  'agentSession:setThinking',
  'agentSession:setModelParameters',
  'agentSession:planAction',
  'agentSession:cancelQueued',
  'agentSession:editQueued',
  'agentSession:reorderQueued',
  'agentSession:fork'
];
for (const ch of required) {
  ok(typeof ARG_PACKERS[ch] === 'function', `缺 packer: ${ch}`);
}

// The unbounded GUI route is retired in both halves of the real bridge.
for (const source of ['src/preload/index.ts', 'src/main/ipc/agentSession.ts']) {
  assert.equal(fs.readFileSync(path.join(root, source), 'utf8').includes("'agentSession:getHistory'"), false,
    `${source} must not expose the retired complete-history IPC`);
  passed++;
}

console.log(`web-api-packing: ${passed} 项断言全部通过`);
