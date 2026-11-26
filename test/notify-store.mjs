/**
 * NotifyStore（toast 唯一出口语义）node 自测。
 * 应用内通知面板移除后，NotifyStore 收敛为「去重/原地更新账本 + 系统 toast 出口」：
 * - toast:true 才弹桌面通知（经 resolveDesktopNotifyPayload 组装 工区名 · 会话名）；
 * - update:true + updateKey 同键原地替换（条目不堆叠），替换后 toast 照弹；
 * - 800ms 短窗去重：同 (workspace, session, lifecycle, label) 连发返回既有条目、不重弹；
 * - 纯内存：不再读 workspace-notifies.json（落盘已随面板移除）。
 * e2e notify-bus.spec 在无系统通知权限的机器上 toast 层断言会环境性失败，
 * 本用例在 node 侧守住同一条 push 链路。运行: node test/notify-store.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-store-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/notify/store.ts');
const { NotifyStore } = await import(pathToFileURL(outFile).href);

/** 假 UiBridge：只记录 notify 调用（真实类构造需 electron，本测只验 push 链路） */
const toasts = [];
const ui = { notify: (title, body, opts) => toasts.push({ title, body, opts }) };
const store = new NotifyStore(ui, (wsId) => ({ name: `工区${wsId}` }));

// ---------- 1. toast 旗标是唯一出口 ----------
const item1 = store.push({
  workspaceId: 'w1',
  sessionId: 's1',
  sessionName: '会话A',
  label: '需要你',
  text: '会话A · 需要你',
  update: true,
  updateKey: 'phase:s1',
  toast: true
});
assert.equal(toasts.length, 1, 'toast:true 弹系统通知');
assert.equal(toasts[0].title, '工区w1 · 会话A', '标题=工区名 · 会话名');
assert.equal(toasts[0].body, '会话A · 需要你');
assert.equal(toasts[0].opts.workspaceId, 'w1', '点击回跳信息随通知携带');
assert.equal(toasts[0].opts.sessionId, 's1');

store.push({
  workspaceId: 'w1',
  sessionId: 's2',
  sessionName: '会话B',
  text: '会话B · 静默条目'
});
assert.equal(toasts.length, 1, '无 toast 旗标不产生任何可见通知（面板已移除）');

// ---------- 2. updateKey 同键原地替换，替换后 toast 照弹 ----------
store.push({
  workspaceId: 'w1',
  sessionId: 's1',
  sessionName: '会话A',
  label: '已完成',
  text: '会话A · 已完成',
  update: true,
  updateKey: 'phase:s1',
  toast: true
});
const items = store.list('w1');
assert.equal(
  items.filter((x) => x.updateKey === 'phase:s1').length,
  1,
  '同键原地替换，不堆历史'
);
assert.equal(items.find((x) => x.updateKey === 'phase:s1').text, '会话A · 已完成');
assert.equal(toasts.length, 2, '状态翻转（需要你→已完成）再弹一次');
assert.equal(item1.id, items.find((x) => x.updateKey === 'phase:s1').id, '原地替换保留条目 id');

// ---------- 3. 800ms 短窗去重（普通 push 连发同签名） ----------
const first = store.push({
  workspaceId: 'w3',
  sessionId: 's3',
  sessionName: '会话C',
  label: '需要你',
  text: '会话C · 需要你',
  toast: true
});
assert.equal(toasts.length, 3);
const again = store.push({
  workspaceId: 'w3',
  sessionId: 's3',
  sessionName: '会话C',
  label: '需要你',
  text: '会话C · 需要你',
  toast: true
});
assert.equal(again.id, first.id, '短窗内同 (ws,session,lifecycle,label) 返回既有条目');
assert.equal(toasts.length, 3, '去重命中不重弹');

// ---------- 4. 上限裁剪（防长跑会话堆爆内存） ----------
for (let i = 0; i < 60; i++) {
  store.push({
    workspaceId: 'w2',
    sessionId: `bulk-${i}`,
    sessionName: `批量${i}`,
    text: `批量${i}`
  });
}
assert.equal(store.list('w2').length, 50, '每工作区上限 50 条');

// ---------- 5. F-02 回归：短窗内同会话同标签、不同文本的第二条不得被吞 ----------
// 用显式 ts 控制去重窗（800ms 内），两连发只有 text 不同、kind 不同两种变化维度。
const f02First = store.push({
  workspaceId: 'w4',
  sessionId: 's4',
  sessionName: '会话D',
  label: '出错',
  kind: 'error',
  text: '会话D · 出错：文件被占用',
  ts: 1000,
  toast: true
});
assert.equal(toasts.length, 4);
const f02Second = store.push({
  workspaceId: 'w4',
  sessionId: 's4',
  sessionName: '会话D',
  label: '出错',
  kind: 'error',
  text: '会话D · 出错：磁盘已满',
  ts: 1200,
  toast: true
});
assert.notEqual(
  f02Second.id,
  f02First.id,
  'F-02: 同 (ws,session,label,kind) 不同 text 在短窗内不得复用首条（旧行为：静默吞掉）'
);
assert.equal(toasts.length, 5, 'F-02: 不同文本的第二条要弹自己的 toast');
assert.equal(
  store.list('w4').filter((x) => x.label === '出错').length,
  2,
  '两条不同文本都在账本里'
);
assert.equal(f02Second.text, '会话D · 出错：磁盘已满', '返回的是新条目自身');

// kind 变化同样不吞（lifecycle/label 全同，仅 kind 不同）
const f02Third = store.push({
  workspaceId: 'w4',
  sessionId: 's4',
  sessionName: '会话D',
  label: '出错',
  kind: 'info',
  text: '会话D · 出错：文件被占用',
  ts: 1400,
  toast: true
});
assert.notEqual(f02Third.id, f02First.id, 'F-02: kind 参与去重键，仅 kind 不同不复用');
assert.equal(toasts.length, 6);

// ---------- 6. 同签名词内去重仍生效（显式 ts 版，锁修复不破坏原语义） ----------
const dedupA = store.push({
  workspaceId: 'w5',
  sessionId: 's5',
  sessionName: '会话E',
  lifecycle: 'blocked',
  label: '需要你',
  kind: 'error',
  text: '会话E · 需要你',
  ts: 5000,
  toast: true
});
const dedupB = store.push({
  workspaceId: 'w5',
  sessionId: 's5',
  sessionName: '会话E',
  lifecycle: 'blocked',
  label: '需要你',
  kind: 'error',
  text: '会话E · 需要你',
  ts: 5300,
  toast: true
});
assert.equal(dedupB.id, dedupA.id, '同 (ws,session,lifecycle,label,kind,text) 短窗内仍去重');
assert.equal(toasts.length, 7, '去重命中不重弹');
// 窗口过后同签名应产生新条目（窗口语义未被键扩展改变）
const dedupC = store.push({
  workspaceId: 'w5',
  sessionId: 's5',
  sessionName: '会话E',
  lifecycle: 'blocked',
  label: '需要你',
  kind: 'error',
  text: '会话E · 需要你',
  ts: 6100,
  toast: true
});
assert.notEqual(dedupC.id, dedupA.id, '800ms 窗口过期后同签名是新条目');
assert.equal(toasts.length, 8);

// ---------- 7. F-02 配套：recentKeys 在 push 时顺带清理过期项 ----------
// 前面已在 ts=5000/5300/6100 记账；此刻 ts=7000 的 push 后，账里不应残留 <6200 的键。
store.push({
  workspaceId: 'w6',
  sessionId: 's6',
  sessionName: '会话F',
  text: '会话F · 触发清扫',
  ts: 7000
});
for (const at of store.recentKeys.values()) {
  assert.ok(
    7000 - at < 800,
    `recentKeys 残留过期键（ts=${at}，距今 ${7000 - at}ms）——push 未顺带清理`
  );
}
assert.ok(store.recentKeys.size > 0, '清扫后当前窗口内的键仍在');
// 且过期键不再参与去重：远超窗口后同签名 push 应新建（前一条 dedupC 已隐式覆盖，这里锁清扫不影响判定）
const dedupD = store.push({
  workspaceId: 'w5',
  sessionId: 's5',
  sessionName: '会话E',
  lifecycle: 'blocked',
  label: '需要你',
  kind: 'error',
  text: '会话E · 需要你',
  ts: 7100
});
assert.notEqual(dedupD.id, dedupC.id, '窗口过期 + 清扫后同签名是新条目');

// ---------- 8. updateKey 原地更新语义不受去重键扩展影响 ----------
const upA = store.push({
  workspaceId: 'w7',
  sessionId: 's7',
  sessionName: '会话G',
  label: '需要你',
  text: '会话G · 需要你',
  update: true,
  updateKey: 'phase:s7',
  ts: 9000,
  toast: true
});
const upB = store.push({
  workspaceId: 'w7',
  sessionId: 's7',
  sessionName: '会话G',
  label: '已完成',
  text: '会话G · 已完成',
  update: true,
  updateKey: 'phase:s7',
  ts: 9100,
  toast: true
});
assert.equal(upB.id, upA.id, 'updateKey 同键原地替换保留条目 id');
assert.equal(
  store.list('w7').filter((x) => x.updateKey === 'phase:s7').length,
  1,
  '同键不堆历史'
);
assert.equal(toasts.length, 10, '替换后 toast 照弹');

console.log('notify-store: all assertions passed');
