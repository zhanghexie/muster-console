/**
 * 收口/收尾提醒缝（R-09/R-19）：settleNotify 模块（去重键 / 清键 / extraKey 铺开 /
 * 部分采纳 worktree 会话反查）+ PR merged 检测（纯差分 + 轮询快照接线 + 防重报）。
 * 还原 notifySettleWarn 去重、notifyAdoptAppliedForWorktree 反查或 notePrOpenSnapshot
 * 差分/防重报时以下用例转红。
 * 运行: node test/settle-notify.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-notify-'));
const compile = createSharedCompiler(root, tmp);

const {
  setSettleNotifyListener,
  notifySettleWarn,
  clearSettleWarnKey,
  resetSettleNotifyForTest,
  settleFailedKey,
  notifyAdoptAppliedForWorktree
} = await import(pathToFileURL(compile('main/orchestrator/settleNotify.ts')).href);

const { diffVanishedPrNumbers } = await import(
  pathToFileURL(compile('shared/prMergeWatch.ts')).href
);
const events = [];
setSettleNotifyListener((e) => events.push(e));

// ---------- settleNotify 模块：去重 / 清键 / extraKey ----------
{
  resetSettleNotifyForTest();

  // 无 key：不去重，extraKey 各自铺开（泵侧同窗口不互相覆盖）
  assert.equal(notifySettleWarn({ workspaceId: 'ws1', detail: 'a' }), true);
  assert.equal(notifySettleWarn({ workspaceId: 'ws1', detail: 'b' }), true);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].extraKey, events[1].extraKey, '无 key 时 extraKey 唯一');

  // 有 key：连续只发一次；清键后再发
  const key = settleFailedKey('ws1', 't-9');
  assert.equal(key, 'settle-failed:ws1:t-9');
  assert.equal(notifySettleWarn({ workspaceId: 'ws1', key, detail: 'fail 1' }), true);
  assert.equal(notifySettleWarn({ workspaceId: 'ws1', key, detail: 'fail 2' }), false, '同 key 连续去重');
  assert.equal(events.length, 3);
  assert.equal(events[2].extraKey, key, 'extraKey 即防重报键（泵侧同窗口覆盖）');
  clearSettleWarnKey(key);
  assert.equal(notifySettleWarn({ workspaceId: 'ws1', key, detail: 'fail 3' }), true, '清键后再触发');
  assert.equal(events.length, 4);

  // 空 workspaceId：泵无法路由，直接吞
  assert.equal(notifySettleWarn({ workspaceId: '  ', detail: 'x' }), false);
  assert.equal(events.length, 4);
  console.log('ok: settleNotify 去重键 / 清键 / extraKey 铺开');
}

// ---------- R-19 部分采纳：worktree 会话反查 agentTaskId ----------
{
  resetSettleNotifyForTest();
  events.length = 0;
  const wt = path.join(tmp, 'wt-a');
  const sessions = {
    list: () => [
      { id: 's-plain', name: '普通会话', workspaceId: 'ws1' },
      {
        id: 's-wt',
        name: '隔离 Worker',
        workspaceId: 'ws1',
        agentTaskId: 't-5',
        worktreePath: wt
      },
      { id: 's-wt-notask', name: '无任务隔离', workspaceId: 'ws1', worktreePath: path.join(tmp, 'wt-b') }
    ]
  };

  // 有 agentTaskId：文案统一用会话名（SettleSessionLike 已收窄，不再提任务 id）
  notifyAdoptAppliedForWorktree(sessions, wt);
  assert.equal(events.length, 1);
  assert.equal(events[0].workspaceId, 'ws1');
  assert.equal(events[0].sessionId, 's-wt');
  assert.match(events[0].detail, /部分采纳已应用到主仓，会话 隔离 Worker 请人工核对收口/);

  // 无 agentTaskId：同样回落会话名
  notifyAdoptAppliedForWorktree(sessions, path.join(tmp, 'wt-b'));
  assert.equal(events.length, 2);
  assert.match(events[1].detail, /部分采纳已应用到主仓，会话 无任务隔离 请人工核对收口/);

  // 反查不到会话：不提醒（采纳结果已回 UI）
  notifyAdoptAppliedForWorktree(sessions, path.join(tmp, 'wt-unknown'));
  assert.equal(events.length, 2);
  console.log('ok: 部分采纳 worktree 会话反查（任务 id / 会话回落 / 未命中跳过）');
}

// ---------- R-19 PR merged：纯差分 ----------
{
  assert.deepEqual(diffVanishedPrNumbers(null, [1, 2]), [], '首轮无基线不检测');
  assert.deepEqual(diffVanishedPrNumbers([1, 2, 3], [2]), [1, 3]);
  assert.deepEqual(diffVanishedPrNumbers([1], [1, 2]), []);
  assert.deepEqual(diffVanishedPrNumbers([], [1]), []);
  console.log('ok: PR open 快照差分（首轮不误报历史 merged）');
}

// ---------- R-19 PR merged：轮询快照接线（stateOf 注入）+ 防重报 ----------
{
  const { notePrOpenSnapshot, resetPrMergedWatchForTest } = await import(
    pathToFileURL(compile('main/orchestrator/prMergedWatch.ts')).href
  );
  resetPrMergedWatchForTest();
  resetSettleNotifyForTest();
  events.length = 0;

  const wsDir = path.join(tmp, 'ws-pr');
  fs.mkdirSync(wsDir, { recursive: true });
  const sessions = [
    { id: 's-pr', name: 'PR Worker', workspaceId: 'ws1', agentTaskId: 't-7', worktreeBranch: 'ao/abc' }
  ];
  const ctx = {
    sessions: { listByWorkspace: (ws) => (ws === 'ws1' ? sessions : []) },
    workspaces: { list: () => [{ id: 'ws1', path: path.join(tmp, 'default-non-git'), roots: [{ id: 'default', path: path.join(tmp, 'default-non-git') }, { id: 'source', path: wsDir }] }] },
    config: { get: () => ({ activeWorkspaceId: 'ws1' }) }
  };
  const pr = (n, over = {}) => ({
    number: n,
    title: `PR ${n}`,
    state: 'OPEN',
    isDraft: false,
    headRefName: n === 12 ? 'ao/abc' : 'ao/other',
    baseRefName: 'main',
    url: '',
    updatedAt: null,
    ...over
  });
  const states = new Map();
  const stateOf = async (n) => states.get(n) ?? 'OPEN';

  // 首轮：建基线，不检测
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [pr(12), pr(13)], stateOf });
  assert.equal(events.length, 0);

  // 次轮：12 消失且复核 MERGED → 提醒（branch 反查会话 → 任务 id）
  states.set(12, 'MERGED');
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [pr(13)], stateOf });
  assert.equal(events.length, 1, 'PR merged 经缝提醒');
  assert.equal(events[0].workspaceId, 'ws1');
  assert.equal(events[0].sessionId, 's-pr');
  assert.match(events[0].detail, /PR #12「PR 12」已合并，会话 PR Worker 待核对收口/);

  // 同一 PR 再轮（历史 merged 不可见 open 列表）：不重提（reported 集合）
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [pr(13)], stateOf });
  assert.equal(events.length, 1, '已提醒过的 PR 不再提');

  // 13 消失但 CLOSED：不提醒
  states.set(13, 'CLOSED');
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [], stateOf });
  assert.equal(events.length, 1);

  // 复核失败（网络/gh 不可用 → ''）：保留一轮不丢，下轮再查 MERGED 才提（还原 carry 即红）
  resetPrMergedWatchForTest();
  let recheckFails = true;
  const flakyStateOf = async (n) => (recheckFails && n === 31 ? '' : states.get(n) ?? 'OPEN');
  states.set(31, 'MERGED');
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [pr(31)], stateOf: flakyStateOf });
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [], stateOf: flakyStateOf }); // 消失但复核失败 → 不提且保留
  assert.equal(events.length, 1, '复核失败不提醒也不丢');
  recheckFails = false;
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [], stateOf: flakyStateOf }); // 保留者再消失 → 复核 MERGED → 提
  assert.equal(events.length, 2, '复核失败保留一轮后补报');
  assert.match(events[1].detail, /PR #31/);

  // 无会话命中：仍提醒（通用文案，人工核对）
  resetPrMergedWatchForTest();
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [pr(13)], stateOf });
  states.set(13, 'MERGED');
  await notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [], stateOf });
  assert.equal(events.length, 3);
  assert.match(events[2].detail, /PR #13「PR 13」已合并，未找到对应会话，请核对收口/);

  // 工作区反查不到（陌生仓路径）：不提醒
  resetPrMergedWatchForTest();
  await notePrOpenSnapshot(ctx, { cwd: path.join(tmp, 'strange-repo'), prs: [pr(13)], stateOf });
  await notePrOpenSnapshot(ctx, { cwd: path.join(tmp, 'strange-repo'), prs: [], stateOf });
  assert.equal(events.length, 3, '陌生仓无法路由工作区，跳过');

  // 同仓串行：并发快照不交叉差分误报（两个快照并发投递，链式执行各见各的基线）
  resetPrMergedWatchForTest();
  await Promise.all([
    notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [pr(20)], stateOf }),
    notePrOpenSnapshot(ctx, { cwd: wsDir, prs: [pr(20)], stateOf })
  ]);
  assert.equal(events.length, 3, '并发建基线不误报');
  console.log('ok: PR merged 轮询接线（merged 提醒 / 防重报 / closed 静默 / 串行差分）');
}

setSettleNotifyListener(null);
resetSettleNotifyForTest();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] settle-notify');
