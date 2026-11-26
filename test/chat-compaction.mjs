/**
 * 消息流压缩分割线：事件归并 / 乐观 pending 认领 / 按时间插入。
 * 运行: node test/chat-compaction.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-compaction-'));
const compile = createSharedCompiler(root, tmp);

const {
  applyCompactionEvent,
  beginCompaction,
  compactionAnchorAt,
  completePendingCompaction,
  dropCompaction,
  hasActiveCompaction,
  interleaveCompactionMarkers,
  isPendingCompactionId,
  markersFromCompactions,
  newPendingCompactionId
} = await import(pathToFileURL(compile('shared/chatCompaction.ts')).href);

const pending = newPendingCompactionId(1000);
assert.equal(isPendingCompactionId(pending), true);
assert.equal(isPendingCompactionId('pi-compaction-1'), false);

let markers = beginCompaction([], pending, 1000);
assert.equal(markers.length, 1);
assert.equal(markers[0].status, 'running');
assert.equal(markers[0].id, pending);

// 已有进行中不再插第二条
const again = beginCompaction(markers, newPendingCompactionId(1001), 1001);
assert.equal(again.length, 1);
assert.equal(again[0].id, pending);

// 事件 start 认领 pending
markers = applyCompactionEvent(markers, { id: 'pi-compaction-1', status: 'running' }, 1010);
assert.equal(markers.length, 1);
assert.equal(markers[0].id, 'pi-compaction-1');
assert.equal(markers[0].status, 'running');
assert.equal(markers[0].createdAt, 1000, '认领后保留乐观插入时刻');

// 事件 end → complete
markers = applyCompactionEvent(markers, { id: 'pi-compaction-1', status: 'complete' }, 1200);
assert.equal(markers[0].status, 'complete');

// 事件未到时 compact() 成功兜底
const p2 = newPendingCompactionId(2000);
let m2 = beginCompaction([], p2, 2000);
m2 = completePendingCompaction(m2, p2);
assert.equal(m2[0].status, 'complete');
assert.equal(m2[0].id, p2);
// 随后事件 start 只改 id，不另插一条
m2 = applyCompactionEvent(m2, { id: 'pi-late', status: 'running' }, 2010);
assert.equal(m2.length, 1);
assert.equal(m2[0].id, 'pi-late');
assert.equal(m2[0].status, 'complete');

// 失败摘线
const p3 = newPendingCompactionId(3000);
let m3 = beginCompaction([{ id: 'old', status: 'complete', createdAt: 1 }], p3, 3000);
m3 = dropCompaction(m3, p3);
assert.deepEqual(m3, [{ id: 'old', status: 'complete', createdAt: 1 }]);

// error 事件摘进行中：只摘归并（认领）到该 id 的线，未关联的 pending 不动
m3 = beginCompaction(m3, p3, 3000);
m3 = applyCompactionEvent(m3, { id: 'pi-x', status: 'running' }, 3005); // 事件认领 pending
m3 = applyCompactionEvent(m3, { id: 'pi-x', status: 'error', error: 'aborted' }, 3010);
assert.equal(m3.length, 1);
assert.equal(m3[0].id, 'old');

// 无 pending 的自动压缩：直接落一条
let auto = applyCompactionEvent([], { id: 'pi-auto', status: 'running' }, 4000);
auto = applyCompactionEvent(auto, { id: 'pi-auto', status: 'complete' }, 4100);
assert.equal(auto[0].id, 'pi-auto');
assert.equal(auto[0].status, 'complete');
assert.equal(auto[0].createdAt, 4000);

// 信封重建（markersFromCompactions）：每条已完成记录一枚，规模字段随行
const fromEnv = markersFromCompactions([
  { at: 10, tokensBefore: 42180, tokensAfter: 11902 },
  { at: 30 }
]);
assert.equal(fromEnv.length, 2, '信封条目全部是已完成压缩');
assert.equal(fromEnv[0].id, 'hc-e0');
assert.equal(fromEnv[0].status, 'complete');
assert.equal(fromEnv[0].createdAt, 10);
assert.equal(fromEnv[0].tokensBefore, 42180);
assert.equal(fromEnv[1].tokensBefore, undefined, '无规模字段缺省');

// 插入：压缩线落在 createdAt 更早的消息之后、更晚的之前
const msgs = [
  { id: 'm1', createdAt: 100 },
  { id: 'm2', createdAt: 300 }
];
const items = interleaveCompactionMarkers(msgs, [
  { id: 'c1', status: 'complete', createdAt: 200 },
  { id: 'c2', status: 'running', createdAt: 400 }
]);
assert.deepEqual(
  items.map((x) => (x.kind === 'message' ? x.message.id : x.marker.id)),
  ['m1', 'c1', 'm2', 'c2']
);
assert.equal(items[0].srcIndex, 0);
assert.equal(items[2].srcIndex, 1);

// 同刻：消息在前
const sameTs = interleaveCompactionMarkers(
  [{ id: 'm', createdAt: 50 }],
  [{ id: 'c', status: 'complete', createdAt: 50 }]
);
assert.equal(sameTs[0].kind, 'message');
assert.equal(sameTs[1].kind, 'compaction');

// running 是活跃态：即便 createdAt 早于后续消息，也贴末尾（不插进中间）
const runningTail = interleaveCompactionMarkers(
  [
    { id: 'm1', createdAt: 100 },
    { id: 'm2', createdAt: 900 }
  ],
  [{ id: 'r1', status: 'running', createdAt: 150 }]
);
assert.deepEqual(
  runningTail.map((x) => (x.kind === 'message' ? x.message.id : x.marker.id)),
  ['m1', 'm2', 'r1']
);

// complete 归档归位：锚到最后一条消息，不是 compact 返回时刻
const lastAt = compactionAnchorAt(
  [
    { id: 'm1', createdAt: 100 },
    { id: 'm2', createdAt: 300 },
    { id: 'q', createdAt: 999, queued: true }
  ],
  5000
);
assert.equal(lastAt, 300, '跳过排队消息，锚到最后一条已落盘消息');

let settled = beginCompaction([], newPendingCompactionId(4000), 4000);
assert.equal(hasActiveCompaction(settled), true);
settled = applyCompactionEvent(
  settled,
  { id: 'pi-done', status: 'complete' },
  4500,
  lastAt
);
assert.equal(settled.length, 1);
assert.equal(settled[0].status, 'complete');
assert.equal(settled[0].createdAt, 300, 'complete 归位到压缩发生的那轮消息');
assert.equal(hasActiveCompaction(settled), false, '完成后状态回落，不再是活跃态');

// 新消息晚于锚点：历史分割线停在压缩点，不跟到底部
const afterChat = interleaveCompactionMarkers(
  [
    { id: 'm1', createdAt: 100 },
    { id: 'm2', createdAt: 300 },
    { id: 'm3', createdAt: 800 }
  ],
  settled
);
assert.deepEqual(
  afterChat.map((x) => (x.kind === 'message' ? x.message.id : x.marker.id)),
  ['m1', 'm2', settled[0].id, 'm3']
);

// 乐观兜底 complete 也归位
const p4 = newPendingCompactionId(6000);
let m4 = beginCompaction([], p4, 6000);
m4 = completePendingCompaction(m4, p4, 250);
assert.equal(m4[0].status, 'complete');
assert.equal(m4[0].createdAt, 250);
assert.equal(hasActiveCompaction(m4), false);

// 双表面（共用单例 store）并发压缩：drop 只摘与传入 id 关联的线
// A 乐观线在挂，B 开始压缩（复用活跃线）→ B 失败摘 B，A 的线必须存活
const pa = newPendingCompactionId(7000);
const pb = newPendingCompactionId(7100);
let dual = beginCompaction([], pa, 7000);
dual = beginCompaction(dual, pb, 7100);
assert.equal(dual.length, 1);
assert.equal(dual[0].id, pa, '已有活跃压缩时 B 复用，不插第二条');
dual = dropCompaction(dual, pb);
assert.equal(dual.length, 1);
assert.equal(dual[0].id, pa, 'B 失败不得摘掉 A 的乐观线');
dual = completePendingCompaction(dual, pa, 250);
assert.equal(dual[0].status, 'complete', 'A 自己的收口路径正常结算');

// 两个 pending 直接并存（防御口径）：drop 其一，另一个必须存活
const two = [
  { id: pa, status: 'running', createdAt: 7000 },
  { id: pb, status: 'running', createdAt: 7100 }
];
assert.deepEqual(dropCompaction(two, pb), [{ id: pa, status: 'running', createdAt: 7000 }]);
assert.deepEqual(dropCompaction(two, pa), [{ id: pb, status: 'running', createdAt: 7100 }]);

// 归并到传入 id 的线同摘：pending 被事件认领（id 改写）后按引擎 id 摘除，别家 pending 不动
let merged = [
  { id: pa, status: 'running', createdAt: 7000 },
  { id: pb, status: 'running', createdAt: 7100 }
];
merged = applyCompactionEvent(merged, { id: 'pi-a', status: 'running' }, 7010);
assert.deepEqual(
  merged,
  [
    { id: 'pi-a', status: 'running', createdAt: 7000 },
    { id: pb, status: 'running', createdAt: 7100 }
  ],
  '事件只认领 A 的 pending，B 的 pending 保持原 id'
);
merged = dropCompaction(merged, 'pi-a');
assert.deepEqual(merged, [{ id: pb, status: 'running', createdAt: 7100 }]);

console.log('chat-compaction: ok');
