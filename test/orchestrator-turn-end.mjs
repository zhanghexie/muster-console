/**
 * 编排事件降噪（R1）：回合结束与 reflog watch 的「编排关联性」过滤。
 *
 * 守三条，都是「别把调度吵醒」的自噪声防线：
 *  1. onTurnEnd 只处理编排会话的活动刷新；回合结束是纯观测，**不再入队实时上行**。
 *  2. startGitReflogWatches 只盯 `.git/worktrees/**\/logs/HEAD`（隔离树提交＝Worker 产出），
 *     不盯主仓 `.git/logs/HEAD`；提交落树同样不实时入队。
 *  3. onTurnFailed（网络死亡）仍入队 turn_error——异常要报。
 *
 * 运行: node test/orchestrator-turn-end.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-turn-end-'));
const compile = createSharedCompiler(root, tmp);

const { OrchestratorEventPump, startGitReflogWatches } = await import(
  pathToFileURL(compile('main/orchestrator/events.ts')).href
);
const messageStore = await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);
messageStore.setAgentMessagesUserDataDir(path.join(tmp, 'user-data'));

/** 造一个只提供 sessions.get / config.get 的最小 ctx */
function makeCtx(sessions, workspaces = []) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return {
    sessions: {
      get: (id) => byId.get(id),
      listByWorkspace: (ws) => sessions.filter((s) => s.workspaceId === ws)
    },
    config: { get: () => ({ workspaces }) }
  };
}

function makePump(ctx) {
  return new OrchestratorEventPump({
    ctx,
    now: () => 1_000,
    // 不起真定时器：flush 调度与本用例无关，真定时器还会吊住进程
    setTimeout: () => 0,
    clearTimeout: () => {},
    enabled: () => true
  });
}

// ---------- 1) onTurnEnd 的 orchestrated 过滤 ----------
{
  const ctx = makeCtx([
    { id: 's-orch', name: '调度拉起的', workspaceId: 'ws1', orchestrated: true },
    { id: 's-manual', name: '用户手工开的', workspaceId: 'ws1' },
    { id: 's-off', name: '已放出', workspaceId: 'ws1', orchestrated: false },
    { id: 's-hidden', name: '隐藏的', workspaceId: 'ws1', orchestrated: true, hidden: true }
  ]);
  const pump = makePump(ctx);

  pump.onTurnEnd('s-manual');
  assert.deepEqual(pump.peek('ws1'), [], '无编排标记的手工会话不得上报回合结束');

  pump.onTurnEnd('s-off');
  assert.deepEqual(pump.peek('ws1'), [], 'orchestrated=false（已放出）等同手工会话');

  pump.onTurnEnd('s-hidden');
  assert.deepEqual(pump.peek('ws1'), [], '隐藏会话仍然不报（原有行为）');

  pump.onTurnEnd('s-orch');
  assert.deepEqual(pump.peek('ws1'), [], '回合结束是纯观测，编排会话也不入队');

  console.log('ok: onTurnEnd 不入队（手工会话 / 编排会话均不实时推）');
}

// ---------- 1a) onTurnEnd 仍刷新活动，心跳不误报；onGitReflog 不入队 ----------
{
  const wsDir = path.join(tmp, 'ws-act');
  fs.mkdirSync(wsDir, { recursive: true });
  const ctx = makeCtx(
    [
      {
        id: 's-a',
        name: 'w',
        workspaceId: 'ws1',
        type: 'terminal',
        launchKind: 'agent',
        lifecycle: 'working',
        orchestrated: true
      }
    ],
    [{ id: 'ws1', path: wsDir }]
  );
  let now = 1_000;
  const pump = new OrchestratorEventPump({
    ctx,
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
    enabled: () => true
  });
  pump.onTurnEnd('s-a');
  assert.deepEqual(pump.peek('ws1'), [], 'turn_end 不入队');
  now = 1_000 + 14 * 60_000;
  pump.tickGuards();
  assert.equal(
    pump.peek('ws1').filter((e) => e.kind === 'heartbeat_stale').length,
    0,
    '回合结束仍刷新活动，未过心跳阈值'
  );
  now = 1_000 + 16 * 60_000;
  pump.tickGuards();
  assert.equal(
    pump.peek('ws1').filter((e) => e.kind === 'heartbeat_stale').length,
    1,
    '超过心跳阈值后仍报 stalled'
  );

  const reflogPump = makePump(
    makeCtx([{ id: 's-a', name: 'w', workspaceId: 'ws1', orchestrated: true }])
  );
  reflogPump.onGitReflog('ws1');
  assert.deepEqual(reflogPump.peek('ws1'), [], '提交落树不入队');

  console.log('ok: turn_end 刷新活动 / commit 不入队 / stalled 仍实时');
}

// ---------- 1b) 调度自身的 needs_you 相位允许编排事件存信 ----------
{
  const orchSends = [];
  const mailbox = () => messageStore.readAgentMessageLedger('', 'ws1').messages;
  const mkFlushPump = () => {
    const ctx = makeCtx([{
      id: 'worker', name: 'worker', workspaceId: 'ws1', orchestrated: true, phase: { value: 'needs_you' }
    }]);
    ctx.sessions.broadcastMessagesChanged = () => {};
    ctx.workspaces = { list: () => [{ id: 'ws1', path: '' }] };
    ctx.orchestrator = {
      isBusy: () => false,
      send: async (text) => {
        orchSends.push(text);
      }
    };
    ctx.schedulerStatus = {
      get: (ws) => (ws === 'ws1' ? { workspaceId: ws, phase: 'needs_you', ts: 1 } : undefined)
    };
    return makePump(ctx);
  };

  const pump = mkFlushPump();
  pump.onFlip({ trigger: 'needs_you', sessionId: 'worker', workspaceId: 'ws1', ts: 1_000 });
  assert.equal(pump.peek('ws1').length, 1);
  assert.equal(await pump.flush('ws1'), 'send');
  assert.equal(orchSends.length, 0, '事件正文不直接送入调度会话');
  assert.equal(mailbox().length, 1);
  assert.match(messageStore.readAgentMessageBody('', 'ws1', mailbox()[0]), /phase → needs_you/);

  // 提问卡读失败时仍允许事件存信。
  const boom = makeCtx([]);
  boom.sessions.broadcastMessagesChanged = () => {};
  boom.workspaces = { list: () => [{ id: 'ws1', path: '' }] };
  boom.orchestrator = {
    isBusy: () => false,
    send: async () => {},
    getHumanWait: () => { throw new Error('question read failed'); }
  };
  const failOpen = makePump(boom);
  failOpen.enqueue({
    kind: 'merge_blocked',
    workspaceId: 'ws1',
    sessionId: 's1',
    detail: '状态读取失败后的合入通知'
  });
  assert.equal(await failOpen.flush('ws1'), 'send', '状态读失败当不挡');
  assert.equal(mailbox().length, 2, '状态读取失败时仍存事件信');

  console.log('ok: 调度 needs_you 时 Worker 相位通知仍存信，提问卡读取失败时放行');
}

// ---------- 1b) onTurnFailed：网络死亡上报 turn_error，手工会话仍静默 ----------
{
  const ctx = makeCtx([
    { id: 's-orch', name: '调度拉起的', workspaceId: 'ws1', orchestrated: true },
    { id: 's-manual', name: '用户手工开的', workspaceId: 'ws1' }
  ]);
  const pump = makePump(ctx);

  pump.onTurnFailed('s-manual', { error: 'read ECONNRESET', retryAttempts: 3 });
  assert.deepEqual(pump.peek('ws1'), [], '手工会话网络死亡由通知推给人，不吵醒调度');

  pump.onTurnFailed('s-orch', { error: '[unknown] [aborted] read ECONNRESET', retryAttempts: 3 });
  const q = pump.peek('ws1');
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, 'turn_error');
  assert.equal(q[0].sessionId, 's-orch');
  assert.match(q[0].detail, /ECONNRESET/);
  assert.match(q[0].detail, /3/);

  pump.onTurnEnd('s-orch');
  const kinds = pump.peek('ws1').map((e) => e.kind);
  assert.deepEqual(kinds, ['turn_error'], '正常结束不入队；失败仍报 turn_error');

  console.log('ok: onTurnFailed 上报 turn_error（仅编排会话）');
}

// ---------- 2) reflog watch 只盯 worktrees ----------
{
  const wsDir = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(wsDir, '.git', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.git', 'logs', 'HEAD'), '');
  fs.mkdirSync(path.join(wsDir, '.git', 'worktrees', 'sess1', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.git', 'worktrees', 'sess1', 'logs', 'HEAD'), '');

  // 拦 fs.watch 记录被监听的路径：比真触发文件事件稳，无时序抖动。
  // events.ts 是 `import fs from 'node:fs'`（默认导入即模块对象），改这里它看得见。
  const watched = [];
  const realWatch = fs.watch;
  fs.watch = (p, ...rest) => {
    watched.push(String(p).replace(/\\/g, '/'));
    void rest;
    return Object.assign(new EventEmitter(), { close() { this.emit('close'); } });
  };

  let dispose;
  try {
    const ctx = makeCtx([], [{ id: 'ws1', path: wsDir }]);
    dispose = startGitReflogWatches(ctx, makePump(ctx));
  } finally {
    fs.watch = realWatch;
  }
  dispose?.();

  const mainHead = watched.filter((p) => p.endsWith('.git/logs/HEAD'));
  assert.deepEqual(mainHead, [], `不得监听主仓 reflog，实际监听了：${mainHead.join(', ')}`);
  assert.ok(
    watched.some((p) => p.endsWith('.git/worktrees')),
    `应递归监听 worktrees 目录，实际：${watched.join(', ') || '(无)'}`
  );

  console.log('ok: reflog watch 只盯 worktrees，不盯主仓 HEAD');
}

// 多根、gitfile、已登记嵌套组、共享源归属、首次创建及句柄释放。
{
  const area = path.join(tmp, 'multi-reflog'); fs.mkdirSync(area);
  const nonGit = path.join(area, 'default'), source = path.join(area, 'second'), nested = path.join(source, 'nested'), extra = path.join(area, 'extra');
  for (const root of [nonGit, source, nested, extra]) fs.mkdirSync(root, { recursive: true });
  for (const root of [source, nested]) fs.mkdirSync(path.join(root, '.git/worktrees'), { recursive: true });
  fs.mkdirSync(path.join(extra, '.git')); // worktrees is created later.
  const alias = path.join(area, 'linked-source'); fs.mkdirSync(alias);
  fs.mkdirSync(path.join(source, '.git/worktrees/alias'));
  fs.writeFileSync(path.join(source, '.git/worktrees/alias/commondir'), '../..');
  fs.writeFileSync(path.join(alias, '.git'), `gitdir: ${path.join(source, '.git/worktrees/alias')}`);
  const tree = path.join(area, 'owned-tree'); fs.mkdirSync(tree);
  const registration = path.join(source, '.git/worktrees/owned'); fs.mkdirSync(path.join(registration, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(registration, 'gitdir'), path.join(tree, '.git'));
  const grouped = { id: 'owned', workspaceId: 'two', worktreeGroups: { version: 1, groups: [{ path: tree,
    source: { mainRepo: source, commonDir: path.join(source, '.git') }, repos: [{ path: 'nested', branch: 'ao/nested' }] }] } };
  const config = { workspaces: [{ id: 'one', path: nonGit, roots: [{ id: 'default', path: nonGit },
    { id: 'second', path: source }, { id: 'extra', path: extra }] }, { id: 'two', path: alias }] };
  const junction = path.join(area, 'junction-source'); fs.symlinkSync(source, junction, 'junction');
  config.workspaces.unshift({ id: 'three', path: junction });
  const ctx = makeCtx([grouped]); ctx.config.get = () => config;
  let lifecycle, removed, unsubscribed = 0;
  ctx.sessions.onLifecycle = fn => { lifecycle = fn; return () => unsubscribed++; };
  ctx.sessions.onSessionRemoved = fn => { removed = fn; return () => unsubscribed++; };
  const watched = [], commits = [], realWatch = fs.watch;
  fs.watch = (root, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const handle = Object.assign(new EventEmitter(), { root: path.resolve(root), recursive: !!options.recursive, callback, closed: 0,
      close() { this.closed++; this.emit('close'); } });
    watched.push(handle); return handle;
  };
  let dispose;
  try {
    dispose = startGitReflogWatches(ctx, { onGitReflog: (...args) => commits.push(args) });
    const sourceGit = fs.realpathSync.native(path.join(source, '.git'));
    const treeWatch = watched.find(handle => handle.root === path.join(sourceGit, 'worktrees'));
    assert.ok(treeWatch, '即使首先登记的是 Junction，也必须用物理 Git 目录开始监听');
    assert.ok(watched.some(handle => handle.root === fs.realpathSync.native(path.join(nested, '.git/worktrees'))), '登记嵌套组必须被监听');
    assert.equal(watched.filter(handle => handle.root === path.join(sourceGit, 'worktrees')).length, 1, 'gitfile/shared源共用句柄');
    assert.equal(watched.filter(handle => !handle.recursive && handle.root === sourceGit).length, 1, '浅层监听也用物理 Git 目录');
    treeWatch.callback('change', 'owned/logs/HEAD');
    assert.deepEqual(commits.map(item => item[0]), ['two'], '共享源按登记checkout归到实际会话工作区');
    treeWatch.callback('change', 'unowned/logs/HEAD'); assert.equal(commits.length, 1, '共享源无唯一归属不误通知活动区');
    const extraGit = fs.realpathSync.native(path.join(extra, '.git'));
    const shallow = watched.find(handle => handle.root === extraGit);
    assert.equal(shallow.recursive, false, '缺worktrees时只浅看common dir');
    fs.mkdirSync(path.join(extra, '.git/worktrees'));
    const started = () => watched.some(handle => handle.root === path.join(extraGit, 'worktrees') && handle.recursive);
    const deadline = Date.now() + 1_000;
    while (!started() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(started(), '启动期间漏掉目录事件时仍能开始监听 worktrees');
    assert.equal(typeof lifecycle, 'function'); assert.equal(typeof removed, 'function');
    config.workspaces = [];
    dispose.sync(); assert.ok(watched.every(handle => handle.closed === 1), '移除根关闭全部句柄');
    lifecycle(); removed(); dispose(); dispose();
    assert.equal(unsubscribed, 2, '监听取消且重复dispose幂等');
  } finally { fs.watch = realWatch; dispose?.(); }
  console.log('ok: multi-root/common-dir/group ownership, first checkout, synchronization and complete release');
}

// 实际 fs.watch：经过目录别名启动后，首次创建 worktrees 并收到日志变更。
{
  const source = path.join(tmp, 'native-second'); fs.mkdirSync(path.join(source, '.git'), { recursive: true });
  const alias = path.join(tmp, 'native-alias'); fs.symlinkSync(source, alias, 'junction');
  const workspaces = [{ id: 'native', path: path.join(tmp, 'native-non-git'), roots: [{ id: 'source', path: alias }] }];
  const ctx = makeCtx([], workspaces), received = [];
  const dispose = startGitReflogWatches(ctx, { onGitReflog: (...args) => received.push(args) });
  try {
    const log = path.join(source, '.git/worktrees/new/logs/HEAD'); fs.mkdirSync(path.dirname(log), { recursive: true });
    const deadline = Date.now() + 4_000;
    while (!received.length && Date.now() < deadline) {
      fs.writeFileSync(log, `commit ${Date.now()}\n`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(received[0]?.[0], 'native', '实际新增worktree日志必须触发第二根监听');
  } finally { await dispose.shutdown(); }
  fs.renameSync(source, source + '-released');
  const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc.ts'), 'utf8');
  assert.match(ipcSource, /syncGitWatches\?\.\(\)/, '根变更同步监听');
  assert.match(ipcSource, /registerGitIpc\(ctx, syncGitWatches\)/, 'extra仓和建树变更同步监听');
  console.log('ok: native fs.watch first registration and directory release');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('orchestrator-turn-end: all ok');
