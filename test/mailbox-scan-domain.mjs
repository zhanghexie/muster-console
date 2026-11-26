/** F-04 回归（docs/audits/reliability/session-mailbox.md）：读信/等待的邮箱扫描收敛。
 * SQLite mailbox 连接复用：重复读不重复打开和校验数据库；新信只使其工作区重读；
 * 宿主视图只读自身工作区；坏索引 fail-closed 不因缓存被掩盖。
 * Run: node test/mailbox-scan-domain.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-scan-'));
const compile = createSharedCompiler(root, tmp);
const load = rel => import(pathToFileURL(compile(rel)).href);
const store = await load('main/metaAgent/messageStore.ts');
const { deliverAgentMessage } = await load('main/messages/deliver.ts');
const { readMailbox } = await load('main/messages/read.ts');

let seq = 0;
after(() => { store.resetMessageStoreChainsForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });

function world() {
  const dir = path.join(tmp, `w-${++seq}`); fs.mkdirSync(dir);
  store.setAgentMessagesUserDataDir(dir);
  // archived：deliverAgentMessage 对归档收件人不触发唤醒链（唤醒路径已有专测，
  // 其账本读写会污染本文件的读取计数窗口），投递与读信行为不受影响。
  const people = new Map(['a', 'b', 'c'].map(id =>
    [id, { id, name: id, runtime: 'pi', workspaceId: 'ws', createdAt: 1, lifecycle: 'idle', archived: true }]));
  const hooks = { lifecycle: new Set(), phase: new Set(), removed: new Set(), scheduler: new Set() };
  const hook = key => fn => { hooks[key].add(fn); return () => hooks[key].delete(fn); };
  const replies = new Map();
  const ctx = {
    sessions: { get: id => people.get(id), peek: id => people.get(id), peekEnded: () => undefined,
      isChatRuntime: () => true, broadcastMessagesChanged() {},
      onLifecycle: hook('lifecycle'), onPhaseFlip: hook('phase'), onSessionRemoved: hook('removed') },
    workspaces: { list: () => [{ id: 'ws', path: dir }, { id: 'other', path: dir }] },
    resolveBubbleWorkspaceId: () => 'ws',
    agentSessions: { isOpen: () => true, isBusy: () => false,
      observe: id => ({ busy: false, retry: null, updatedAt: 1, lastReply: replies.get(id) ?? null }) },
    orchestrator: { isBusy: () => false, onEvent: hook('scheduler'),
      observe: () => ({ busy: false, createdAt: 1, updatedAt: 1, lastReply: replies.get('scheduler') ?? null }) }
  };
  const send = (text, extra = {}) => deliverAgentMessage(ctx, { from: 'a', to: 'b', text, workspaceId: 'ws', ...extra });
  const read = (args = {}, id = 'b', host = false) => readMailbox(ctx, args, { id, hostView: host, workspaceId: 'ws' });
  return { ctx, dir, people, hooks, send, read };
}

/** 统计针对 <dir>/agent-messages/<key>.sqlite 账本的 header 校验次数（不含正文文件）。 */
function countLedgerReads(dir) {
  const real = fs.openSync;
  let count = 0;
  const base = path.join(dir, 'agent-messages') + path.sep;
  fs.openSync = function (p, ...rest) {
    const s = typeof p === 'string' ? p : String(p);
    if (s.startsWith(base) && s.endsWith('.sqlite')) count++;
    return real.call(fs, p, ...rest);
  };
  return { get count() { return count; }, restore() { fs.openSync = real; } };
}

test('重复读命中进程内账本缓存，不再逐工作区重读+解析', async () => {
  const w = world();
  for (let i = 0; i < 6; i++)
    await store.appendAgentMessageToStore(w.dir, `scan-${i}`, { from: 'a', to: 'b', text: `m${i}`, ts: i, receipt: 'stored' });
  await w.send('hello');
  const first = await w.read({ includeBody: false });
  assert.equal(first.total, 7);
  const counter = countLedgerReads(w.dir);
  try {
    const second = await w.read({ includeBody: false });
    assert.deepEqual(second.messages.map(m => [m.id, m.read]), first.messages.map(m => [m.id, m.read]),
      '缓存命中时返回内容必须与全量读一致');
    assert.equal(counter.count, 0, `重复读仍重读了 ${counter.count} 份工作区账本`);
  } finally { counter.restore(); }
});

test('empty cursor reads reuse ledger cache and new mail invalidates its workspace', async () => {
  const w = world();
  for (let i = 0; i < 5; i++)
    await store.appendAgentMessageToStore(w.dir, `scan-${i}`, { from: 'a', to: 'c', text: `m${i}`, ts: i, receipt: 'stored' });
  const start = await w.read({ includeBody: true });
  const counter = countLedgerReads(w.dir);
  try {
    const empty = await w.read({ includeBody: true, cursor: start.nextCursor });
    assert.equal(empty.reason, 'empty');
    await w.send('arrived');
    const after = await w.read({ includeBody: true, cursor: empty.nextCursor });
    assert.equal(after.messages[0].text, 'arrived');
    assert.ok(counter.count <= 2, `ledger reads: ${counter.count}`);
  } finally { counter.restore(); }
});

test('缓存命中仍以 stat 校验兜底：外部覆写的坏索引照旧 fail-closed', async () => {
  const w = world();
  await w.send('保留');
  await w.read({ includeBody: false }); // 预热缓存
  const file = store.agentMessagesFilePath('ws');
  fs.writeFileSync(file, '{broken');
  await assert.rejects(() => w.read({ includeBody: false }), /邮箱索引读取失败/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken', '坏索引原文件不得被覆盖');
});

test('宿主视图只读取自身工作区账本', async () => {
  const w = world();
  await store.appendAgentMessageToStore(w.dir, 'far', { from: 'x', to: 'y', text: '远处', ts: 1, receipt: 'stored' });
  await w.send('本地');
  const counter = countLedgerReads(w.dir);
  try {
    const r = await w.read({ includeBody: false }, 'host', true);
    assert.equal(r.total, 1);
    assert.ok(counter.count <= 1, `宿主视图重新打开了 ${counter.count} 份自身工作区账本`);
  } finally { counter.restore(); }
});
