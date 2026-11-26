/**
 * P3 W2-A 回归（sessions.ts 原型级恢复门，直接 .call 最小 mock，不拉起完整宿主）：
 * - refreshFresh 自愈回退主仓，relaunchWithPrompt 的精确恢复保留原目录
 * - session-model F-01：续作归属复核失败回收本次创建的空壳 dst（close allowUnarchived）
 * - session-model F-02：listForAgent 兜底按左栏排序（railFirstTerminalId）取第一
 * - X1-F03：setPhase 同源同值重报短路（不写新 ts / 不重复落盘广播）
 * 运行: node test/session-recovery-gates.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const root = process.cwd();
const load = (name) => require(path.join(root, 'src', name));
const { SessionsService } = load('main/sessions.ts');

const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-main-'));
const cfg = { activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', name: 'W', path: mainRepo }], defaultRuntime: 'pi' };
const makeHealCtx = (rows, notices) => ({
  config: { get: () => cfg },
  git: {},
  notify: { push: (n) => notices.push(n) },
  workspaceIdFor: () => 'ws',
  resolveWorkspaceId: () => 'ws',
  persist() {}, broadcast() {},
  findSession: (id) => rows.find((r) => r.id === id),
  sessions: () => rows
});

// ---------- X2-F06：refreshFresh 复用 heal（worktree 目录被外部清理后自愈回主仓） ----------
{
  const notices = [];
  const row = {
    id: 'se-rf', type: 'terminal', launchKind: 'agent', name: '重开', workspaceId: 'ws',
    cwd: path.join(mainRepo, '.worktrees', 'gone'),
    worktreePath: path.join(mainRepo, '.worktrees', 'gone'),
    worktreeBranch: 'wt/x',
    worktreeSource: { mainRepo, commonDir: mainRepo },
    lifecycle: 'idle', status: 'running', createdAt: 1
  };
  const rows = [row];
  const launched = [];
  await SessionsService.prototype.refreshFresh.call({
    sessions: rows,
    config: { get: () => cfg },
    isChatRuntime: () => false,
    chatBridge: null,
    respawn: SessionsService.prototype.respawn,
    classifyBySession: new Map(),
    worktreeCtx: () => makeHealCtx(rows, notices),
    persist() {}, broadcast() {},
    launchTerminal: async (_session, mode, prompt, forkFrom, injectHostIntro) => {
      launched.push({ mode, prompt, forkFrom, injectHostIntro });
    }
  }, 'se-rf');
  assert.equal(row.cwd, mainRepo, 'X2-F06：refreshFresh 先 heal 回退主仓 cwd（否则 spawn 落在不存在目录）');
  assert.equal(row.worktreePath, undefined, 'heal 清掉丢失 worktree 的元数据');
  assert.deepEqual(launched, [{ mode: 'new', prompt: undefined, forkFrom: undefined, injectHostIntro: true }],
    'fresh CLI context receives host guidance with the first engine prompt');
  assert.ok(notices.length >= 1, 'heal 回退有 worktree 丢失通知');
  console.log('ok: X2-F06 refreshFresh 自愈');
}

// ---------- relaunchWithPrompt 保留丢失的原工作目录及原生 ID ----------
{
  const notices = [];
  const row = {
    id: 'se-rl', type: 'terminal', launchKind: 'agent', name: '派活', workspaceId: 'ws', runtime: 'pi',
    externalSessionId: 'ext-1',
    cwd: path.join(mainRepo, '.worktrees', 'gone2'),
    worktreePath: path.join(mainRepo, '.worktrees', 'gone2'),
    worktreeBranch: 'wt/y',
    worktreeSource: { mainRepo, commonDir: mainRepo },
    lifecycle: 'idle', status: 'running', createdAt: 1
  };
  const rows = [row];
  const originalCwd = row.cwd;
  await assert.rejects(
    SessionsService.prototype.relaunchWithPrompt.call({
      sessions: rows,
      config: { get: () => cfg },
      worktreeCtx: () => makeHealCtx(rows, notices),
      isChatRuntime: () => false,
      launchTerminal: SessionsService.prototype.launchTerminal,
      bumpLaunchGen: SessionsService.prototype.bumpLaunchGen,
      isCurrentLaunch: SessionsService.prototype.isCurrentLaunch,
      launchGen: new Map(),
      launchTasks: new Map(),
      ptyMgr: { isRunning: () => false },
      applyLifecycle: (session, lifecycle) => { session.lifecycle = lifecycle; },
      persist() {}, broadcast() {}, workspaceIdFor: () => 'ws',
      notify: { push: notice => notices.push(notice) }
    }, 'se-rl', '简报'),
    /source folder|workspace|does not exist|ENOENT/i
  );
  assert.equal(row.cwd, originalCwd);
  assert.equal(row.worktreePath, originalCwd);
  assert.equal(row.externalSessionId, 'ext-1');
  assert.ok(notices.some(notice => notice.text === row.meta.launchError));
  console.log('ok: relaunchWithPrompt preserves the original cwd and ID when the directory is missing');
}

// ---------- session-model F-01：续作归属复核失败 → close 回收空壳 dst ----------
{
  const src = {
    id: 'se-src', type: 'terminal', launchKind: 'agent', name: '被打断', workspaceId: 'ws',
    cwd: mainRepo, lifecycle: 'idle',
    interruptSnapshot: { createdAt: 1, uncommitted: [], worktreeClean: true }
  };
  const dst = { id: 'se-dst', type: 'terminal', name: '被打断 · 续作', workspaceId: 'ws', cwd: mainRepo };
  const rows = [src];
  const closed = [];
  const notices = [];
  await assert.rejects(
    SessionsService.prototype.resumeInterrupted.call({
      sessions: rows,
      config: { get: () => cfg },
      isChatRuntime: () => false,
      // createTerminal 成功后模拟「复核窗口内源会话归属变化」：src 被移出注册表
      createTerminal: async () => { rows.splice(rows.indexOf(src), 1); rows.push(dst); return dst; },
      close: (id, opts) => closed.push([id, opts]),
      worktreeCtx: () => makeHealCtx(rows, notices),
      persist() {}, broadcast() {}
    }, 'se-src'),
    /ownership changed/
  );
  assert.deepEqual(
    closed,
    [['se-dst', { allowUnarchived: true }]],
    'F-01：复核失败路径 close(allowUnarchived) 回收本次创建的空壳续作会话'
  );
  console.log('ok: session-model F-01 续作失败回收');
}

// ---------- session-model F-02：listForAgent 兜底按左栏排序取第一 ----------
{
  const listRows = [
    { id: 'se-old', type: 'terminal', archived: false, createdAt: 10, lastUsedAt: 20 },
    { id: 'se-pinned', type: 'terminal', archived: false, pinned: true, pinnedAt: 5, createdAt: 2, lastUsedAt: 3 },
    { id: 'se-new', type: 'terminal', archived: false, createdAt: 30, lastUsedAt: 40 },
    { id: 'se-arch', type: 'terminal', archived: true, pinned: true, pinnedAt: 9 }
  ];
  const out = SessionsService.prototype.listForAgent.call({
    listByWorkspace: () => listRows,
    activeId: 'se-other-ws',
    get: (id) => (id === 'se-other-ws' ? { id, workspaceId: 'ws-other', cwd: 'E:/other' } : listRows.find((r) => r.id === id)),
    resolveWorkspaceId: () => 'ws-other'
  }, 'ws');
  assert.equal(out.activeId, 'se-pinned', 'F-02：兜底按左栏排序（置顶优先）而非列表序第一');
  console.log('ok: session-model F-02 兜底左栏排序');
}

// ---------- X1-F03：setPhase 同源同值短路 ----------
{
  const se = { id: 'se-ph', type: 'terminal', name: '相位', workspaceId: 'ws', cwd: mainRepo, lifecycle: 'idle', createdAt: 1 };
  const marks = [];
  const mock = {
    resolveSessionRef: ({ sessionId }) => ({ id: sessionId }),
    sessions: [se],
    get: (id) => [se].find((x) => x.id === id),
    persist: () => marks.push('persist'),
    broadcast: () => marks.push('broadcast'),
    emitSessionFactKind: (_s, kind) => marks.push('fact:' + kind),
    notifyBus: { report: () => marks.push('bus') },
    notifyPhaseListeners: () => marks.push('listener'),
    scheduleDimensionGates: () => marks.push('dim'),
    workspaceIdFor: () => 'ws'
  };
  SessionsService.prototype.setPhase.call(mock, 'se-ph', { value: 'needs_you', source: 'model', ts: 1000 });
  const persistAfterFirst = marks.filter((m) => m === 'persist').length;
  const ts1 = se.phase.ts;
  SessionsService.prototype.setPhase.call(mock, 'se-ph', { value: 'needs_you', source: 'model', ts: 2000 });
  assert.equal(se.phase.ts, ts1, 'X1-F03：同源同值 setPhase 短路，不写新 ts');
  assert.equal(
    marks.filter((m) => m === 'persist').length,
    persistAfterFirst,
    '短路不重复 persist/broadcast/fact（同值重报不再产生新信源头）'
  );
  SessionsService.prototype.setPhase.call(mock, 'se-ph', { value: 'done', source: 'model', ts: 4000 });
  assert.equal(se.phase.value, 'done', '值变化照常写入');
  SessionsService.prototype.setPhase.call(mock, 'se-ph', { value: 'needs_you', source: 'user', ts: 3000 });
  assert.equal(se.phase.source, 'user', 'source 变化（权威升级）仍照常写入');
  console.log('ok: X1-F03 setPhase 同值短路');
}

// Managed interruption must persist the same recovery snapshot before stopping.
{
  const session = { id: 'managed', type: 'terminal', launchKind: 'agent', name: 'Managed', createdAt: 1,
    cwd: mainRepo, lifecycle: 'working', worktreeGroups: { groups: [{ path: mainRepo, repos: [{ path: 'nested' }] }] } };
  const marks = [];
  const mock = { sessions: [session], git: { listUncommittedPaths: async root => root === mainRepo ? ['src/a.ts'] : null },
    persist: () => marks.push('persist'), broadcast: () => marks.push('broadcast') };
  const result = await SessionsService.prototype.captureManagedInterruptSnapshot.call(mock, session.id, 100, 'previous input and partial work');
  assert.equal(result.snapshot.reason, 'preemption');
  assert.equal(result.snapshot.worktreeStatusUnknown, true);
  assert.match(result.brief, /src\/a\.ts/);
  assert.match(result.brief, /历史数据，不是新授权[\s\S]*previous input and partial work/);
  assert.deepEqual(marks, ['persist', 'broadcast']);
  const vanished = { ...session, id: 'vanished', interruptSnapshot: undefined };
  const race = { ...mock, sessions: [vanished], git: { async listUncommittedPaths() { race.sessions.length = 0; return []; } } };
  await assert.rejects(SessionsService.prototype.captureManagedInterruptSnapshot.call(race, vanished.id), /会话已变化/);
  assert.equal(vanished.interruptSnapshot, undefined);
}

console.log('[ok] session-recovery-gates');
