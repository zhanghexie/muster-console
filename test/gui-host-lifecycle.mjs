/**
 * AgentSessionHost 回合生命周期回归（require-extension 转译 + fake driver + electron stub）：
 * - 默认模式 auto（T4）
 * - connecting 期 abort：回合不发起、标记 aborted（T2）
 * - close 抢在 connect 落地前：迟到连接被回收，不泄漏（T2）
 * - 审批卡：锚点=请求时 parts 长度；error 收口把悬挂审批终态化（T1/T2）
 * - 回合结束派发队列；queued 标记清除（既有行为回归锁）
 * - busy 续发：redirect 成功返回 steered（非 queued）；否则 queued
 * - steer 切开转写：旧 assistant 冻结，插话 + 新 assistant 开新回合，后续 delta 不拼旧流
 * 运行: node test/gui-host-lifecycle.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { codexWorktreeFixture, fixtureGit } from './helpers/codex-worktree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const fixtureWorkspace = fs.mkdtempSync(path.join(root, '.tmp', 'gui-host-workspace-'));
let reminderService;
process.once('exit', () => {
  reminderService?.closeSessionReminderStore();
  removeDesktopFixture(fixtureWorkspace, 'gui-host-workspace-');
});
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('module');

// .ts 即时转译（CJS）：host 的 import 闭包全在仓内 + node 内建
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  });
  module._compile(outputText, filename);
};

// config.ts 等主进程模块运行时 import electron：stub 掉（宿主只用到 app.getPath 一类）
const origLoad = Module._load;
let electronCalls = 0;
/** fake driver 不加载原生 SDK；null 表示空技能清单，专项用例可提供正文/等待。
 * 原生 ESM SDK 发现由 workspace-skills.mjs 与 Electron E2E 验证。 */
let piStub = null;
let nextTurnChangeBegin = null;
Module._load = function (request, parent, isMain) {
  // This suite exercises host state/queue/retry timing with fake drivers. Real bounded
  // filesystem capture and ownership are covered by turn-changes.mjs and Electron E2E.
  if (request === '../../turnChanges/runtime') {
    return { turnChanges: () => ({ begin: (_owner, messageId) => {
      if (nextTurnChangeBegin) { const pending = nextTurnChangeBegin; nextTurnChangeBegin = null; return pending; }
      const summary = { id: `snapshot-${messageId}`, state: 'collecting', files: [], warnings: [] };
      return { summary, ready: Promise.resolve(), toolStart() {}, toolEnd() {}, finish: async () => ({ ...summary, state: 'ready' }) };
    } }) };
  }
  if (request === 'electron') {
    electronCalls += 1;
    return {
      app: { getPath: () => fixtureWorkspace, isReady: () => true },
      ipcMain: { handle: () => {}, on: () => {} }
    };
  }
  if (request === '@earendil-works/pi-coding-agent') {
    return {
      getAgentDir: () => piStub?.agentDir ?? os.tmpdir(),
      DefaultResourceLoader: class {
        async reload() {
          if (piStub?.gate) await piStub.gate.promise;
        }
        getSkills() {
          return { skills: piStub?.skills ?? [] };
        }
      }
    };
  }
  return origLoad.apply(this, arguments);
};

const { AgentSessionHost } = require(path.join(root, 'src/main/agentSession/host.ts'));
const { GuiSessionStore } = require(path.join(root, 'src/main/agentSession/persist.ts'));
reminderService = require(path.join(root, 'src/main/sessionReminders/service.ts'));

// These fixtures inspect/mutate execution state directly. Make that boundary
// explicit; pure UI opening is independently guarded by gui-cold-browse.spec.
function openExecution(host, meta) {
  if (host.ctx.__sessionsDb && !host.ctx.__sessionsDb.has(meta.id)) host.ctx.__sessionsDb.set(meta.id, meta);
  host.open(meta);
  return host.materializeForExecution(meta.id);
}

// 真 IPC send 回调 → 真 GUI Host → SessionsService 信号写入体；SDK/存储仍用夹具。
async function testBoardExecutionSignals() {
  const { boardStatusOfSession, activityClearsDonePhase } = require(path.join(root, 'src/shared/boardStatus.ts'));
  const { nextSessionActivity } = require(path.join(root, 'src/shared/sessionActivity.ts'));
  const source = fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8');
  const ast = ts.createSourceFile('sessions.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'SessionsService');
  const method = cls.members.find(n => n.name?.getText(ast) === 'applyActivitySignal').getText(ast);
  const Apply = new Function('boardStatusOfSession', 'activityClearsDonePhase', 'nextSessionActivity',
    ts.transpileModule(`return class { ${method} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  )(boardStatusOfSession, activityClearsDonePhase, nextSessionActivity);
  const ipcAst = ts.createSourceFile('ipc.ts', fs.readFileSync(path.join(root, 'src/main/ipc/agentSession.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  let callback;
  function visit(n) {
    if (ts.isCallExpression(n) && n.expression.getText(ipcAst) === 'handle' && n.arguments[0]?.text === 'agentSession:send') callback = n.arguments[1].getText(ipcAst);
    ts.forEachChild(n, visit);
  }
  visit(ipcAst);
  for (const previous of ['idle', 'done']) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-board-'));
    const { host, ctx } = makeHost(tmp);
    const { driver, state } = makeFakeDriver();
    const s = session('board', { createdAt: Date.now(), lifecycle: 'idle', status: 'running', phase: { value: previous, source: 'model', ts: 1 } });
    ctx.__sessionsDb.set(s.id, s);
    const service = new Apply();
    Object.assign(service, { sessions: [s], resolveSessionRef: () => ({ id: s.id }),
      applyLifecycle: (s, next) => { s.lifecycle = next; }, persist() {}, broadcast() {},
      emitSessionFactKind() {}, workspaceIdFor: () => '', notifyBus: { report() {} } });
    ctx.sessions.applyActivitySignal = service.applyActivitySignal.bind(service);
    // The UI can display a cold session before the host has an execution
    // projection. The real IPC send must open it at the user-send boundary.
    host.registerDriver(driver);
    assert.equal(host.isOpen(s.id), false, 'fixture starts as a visible cold session');
    ctx.agentSessions = host;
    const activities = [];
    ctx.usage = { recordSessionActivity(id, info) { activities.push({ id, ...info }); }, recordGuiWorkerSend() {} };
    // 提取的真实回调需要显式提供其模块依赖；附件 Worker 本身不在此夹具中启动。
    const send = new Function('ctx', 'prepareGuiInput',
      ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
      ctx, async (_ctx, _session, text, images) => ({ text, images }));
    const pending = send(null, { sessionId: s.id, text: 'run long command' });
    await sleep(25);
    state.resolveConnect(); await pending;
    assert.equal(host.isOpen(s.id), true, 'foreground IPC send opens the cold session');
    assert.deepEqual(ctx.__autoNameCalls, [{ id: s.id, text: 'run long command' }], '成功受理的用户首条指令触发自动命名');
    assert.equal(activities.length, 1, '真实发送入口记录一次活跃会话');
    assert.equal(activities[0].id, s.id);
    assert.equal(activities[0].runtime, s.runtime);
    assert.equal(boardStatusOfSession(s, Date.now() + 600_000), 'working', 'actual GUI send clears old phase and survives silence');
    state.queue.push({ type: 'turn-complete' }); await sleep(40);
    assert.equal(boardStatusOfSession(s), 'idle', 'actual completion clears execution fact');
    await host.close(s.id);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(label, predicate, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}
/** 事件泵轮询用：unref 定时器——泵是常驻后台循环，不能阻止测试进程退出 */
const tick = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof t.unref === 'function') t.unref();
  });

/** 事件流受控的 fake driver：冒充 pi（isChatRuntimeId 只认注册表 runtime），
 *  connect 可挂起（测 connecting 竞态），事件手工 push */
function makeFakeDriver(runtimeId = 'pi') {
  const state = {
    connects: 0,
    inputs: [],
    aborts: 0,
    closes: 0,
    sends: [],
    sentImages: [],
    sentParameters: [],
    authorities: [],
    redirects: [],
    redirectReturns: false,
    queue: null,
    resolveConnect: null,
    conn: null
  };
  const driver = {
    runtimeId,
    supportsImages: false,
    supportsSeed: false,
    modelOverridePolicy: 'reconnect',
    thinkingPolicy: 'hot',
    connect(input) {
      state.connects += 1;
      state.inputs.push(input);
      return new Promise((resolve) => {
        state.resolveConnect = () => {
          const q = {
            items: [],
            closed: false,
            push(ev) {
              if (!this.closed) this.items.push(ev);
            },
            async *[Symbol.asyncIterator]() {
              while (true) {
                if (this.items.length) {
                  yield this.items.shift();
                } else if (this.closed) {
                  return;
                } else {
                  await tick(5);
                }
              }
            }
          };
          state.queue = q;
          const conn = {
            events: q,
            // Harness 透明·引擎真身（pi driver 连接期捕获；host 记代际时合并）
            engineCapture: {
              enginePrompt: { chars: 12, hash: 'cccc3333', text: '引擎提示词全文' },
              tools: [{ name: 'read', source: 'native', description: '读文件', params: ['path: string*'] }]
            },
            async send(text, images, parameters, authority) {
              state.authorities.push(authority);
              state.sends.push(text);
              state.sentParameters.push(parameters);
              if (images?.length) state.sentImages.push({ text, images });
            },
            redirect(text) {
              state.redirects.push(text);
              return state.redirectReturns === true;
            },
            async abort() {
              state.aborts += 1;
              q.closed = true;
            },
            async close() {
              state.closes += 1;
              q.closed = true;
            }
          };
          state.conn = conn;
          resolve(conn);
        };
      });
    }
  };
  return { driver, state };
}

function makeCtx(tmp, extraConfig = {}) {
  const sessionsDb = new Map();
  const sessionsClosed = [];
  const signals = [];
  const autoNameCalls = [];
  return {
    getWindow: () => null,
    store: { loadSessions: () => [...sessionsDb.values()] },
    sessions: {
      get: (id) => sessionsDb.get(id),
      peek: (id) => sessionsDb.get(id),
      isChatRuntime: () => true,
      async updateConfigurePermissions(id, enabled, validate, commit, restore) {
        validate();
        const row = sessionsDb.get(id);
        row.nativePermissionRestore = restore();
        row.configurePermissions = enabled;
        commit();
      },
      async updateNativePermissionRestore(id, next, validate) {
        validate();
        sessionsDb.get(id).nativePermissionRestore = next;
      },
      engineSweepRoster: () => [...sessionsDb.values()],
      applyActivitySignal: (id, kind, ev) => signals.push([kind, ev]),
      // 对齐生产 autoNameFromInstruction：仅 autoNamed 会话按首条指令改名（auto-name 回归另有专项）
      autoNameFromInstruction: (id, text) => {
        autoNameCalls.push({ id, text });
        const s = sessionsDb.get(id);
        if (!s?.autoNamed) return s;
        const name = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 10);
        if (!name) return s;
        s.name = name;
        delete s.autoNamed;
        return s;
      },
      // 对齐生产 SessionsService.close：内部清理路径传 allowUnarchived 直接移除注册表行
      close: (id, opts) => { sessionsClosed.push({ id, opts }); sessionsDb.delete(id); },
      touchUsed: () => {},
      updateGuiMode: (id, mode) => {
        const s = sessionsDb.get(id);
        if (s) {
          s.guiMode = mode;
          s.permissionMode = mode === 'auto' ? 'auto' : mode === 'default' ? 'acceptEdits' : 'ask';
        }
      },
      updateThinkingLevel: (id, level) => {
        const s = sessionsDb.get(id);
        if (s) s.thinkingLevel = level ?? undefined;
      },
      updateModelParameters: (id, values) => {
        const s = sessionsDb.get(id);
        if (s) { s.modelParameters = { ...values }; s.thinkingLevel = undefined; }
      },
      updatePiMode: () => {},
      updateModelOverride: (id, override) => {
        const s = sessionsDb.get(id);
        if (!s) return;
        s.modelOverride = override || undefined;
      },
      updateRuntimeHandle: () => {},
      resetRuntimeHandle: () => {},
      resetRuntimeHandleStrict: async (id, validate) => {
        validate();
        const s = sessionsDb.get(id);
        if (!s) throw new Error('Session does not exist.');
        delete s.externalSessionId;
        delete s.runtimeResumeToken;
      },
      // 对齐生产 chat 分支：先执行 GUI fork 的原子准备回调，再发布会话。
      // 夹具提前登记是为了覆盖“准备失败后清理空壳”的可观测合同。
      createTerminal: async (opts) => {
        const row = { id: 'new', ...opts };
        sessionsDb.set(row.id, row);
        try {
          await opts.prepareGuiSession?.(row);
          return row;
        } catch (error) {
          sessionsDb.delete(row.id);
          sessionsClosed.push({ id: row.id, opts: { allowUnarchived: true } });
          throw error;
        }
      }
    },
    config: {
      get: () => ({
        workspaces: [],
        llm: { providers: [{ id: 'p1', name: 'Fixture provider', baseUrl: 'https://example.test/v1', apiKey: 'fixture', models: [{ id: 'm1', name: 'Fixture model' }], enabled: true }], activeProviderId: 'p1', activeModelId: 'm1' },
        agentRules: [],
        ...extraConfig
      }),
      effectiveMcp: () => ({ servers: [] }),
      update: (patch) => Object.assign(extraConfig, patch)
    },
    // turn.ts 的 skill 装配读 ctx.runtimes.list()（guiSkillTargetForRuntime）——
    // 夹具环境无 runtimes 注册表会给空表：不注入技能、不崩回合（与生产空注册表同形）
    runtimes: { list: () => [] },
    bgTasks: null,
    __sessionsDb: sessionsDb,
    __sessionsClosed: sessionsClosed,
    __autoNameCalls: autoNameCalls,
    __signals: signals
  };
}

function makeHost(tmp, extraConfig = {}) {
  const ctx = makeCtx(tmp, extraConfig);
  const host = new AgentSessionHost(ctx, { userDataDir: tmp });
  return { host, ctx };
}

async function testForkDropsTurnSnapshots() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-fork-snapshot-'));
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(makeFakeDriver().driver);
  const row = session('source'); ctx.__sessionsDb.set(row.id,row); openExecution(host, row);
  const snapshot = { id:'original-snapshot',state:'ready',files:[],warnings:[] };
  host.entries.get(row.id).messages = [{id:'m',role:'assistant',parts:[{kind:'text',text:'done'}],ts:1,turnChanges:snapshot}];
  const result = await host.forkSession(row.id,'m');
  assert.equal(result.ok,true);host.store.flushSync();
  assert.equal(host.store.load(result.sessionId)[0].turnChanges,undefined,'fork cannot carry source snapshot authority');
  assert.equal(host.entries.get(row.id).messages[0].turnChanges,snapshot,'source summary remains available');
}

async function testForkAttachmentFailureRecyclesShell() {
  // F-01（multimodal-input）：附件复制失败时新会话已注册但历史/种子尚未落盘——
  // 修复后错误收尾必须回收空壳（entry 关闭 + 注册表移除），不得留下不可用会话。
  const { attachmentDir } = require(path.join(root, 'src/main/attachments/service.ts'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-fork-fail-'));
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(makeFakeDriver().driver);
  const row = session('forkfail'); ctx.__sessionsDb.set(row.id, row); openExecution(host, row);
  host.entries.get(row.id).messages = [{ id: 'm', role: 'user', parts: [{ kind: 'text', text: 'hi' }], ts: 1 }];
  // forkSession 走隔离的 app.getPath('userData')；
  // 目标附件目录预置同名文件使 cpSync errorOnExist 必败（仅空目录不触发），模拟附件复制失败
  const srcDir = attachmentDir(fixtureWorkspace, 'gui:forkfail');
  const dstDir = attachmentDir(fixtureWorkspace, 'gui:new');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'seed.bin'), 'x');
  fs.mkdirSync(dstDir, { recursive: true });
  fs.writeFileSync(path.join(dstDir, 'seed.bin'), 'occupied');
  try {
    const result = await host.forkSession(row.id, 'm');
    assert.equal(result.ok, false, '附件复制失败必须报错');
    assert.match(result.error, /分叉附件复制失败/);
    assert.ok(ctx.__sessionsClosed.some((c) => c.id === 'new' && c.opts?.allowUnarchived === true), '空壳会话已请求注册表回收');
    assert.equal(ctx.__sessionsDb.has('new'), false, '注册表不留空壳行');
    assert.equal(host.entries.has('new'), false, 'host 不留空壳 entry');
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(dstDir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const session = (id, extra = {}) => ({
  id,
  name: id,
  runtime: 'pi',
  type: 'terminal',
  cwd: fixtureWorkspace,
  ...extra
});

function removeDesktopFixture(tmp, prefix) {
  const parent = path.join(fs.realpathSync(root), '.tmp');
  const parentStat = fs.lstatSync(parent), targetStat = fs.lstatSync(tmp);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('Refusing a linked desktop fixture');
  const resolved = fs.realpathSync(tmp), realParent = fs.realpathSync(parent);
  if (path.dirname(resolved).toLowerCase() !== realParent.toLowerCase() || !path.basename(resolved).startsWith(prefix)) throw new Error('Refusing to remove unexpected desktop fixture');
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function testDesktopQueuedBeforeStopCannotResume() {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-desktop-queued-'));
  try {
  const { DesktopActivity } = require(path.join(root, 'src/main/desktop/desktopActivity.ts'));
  const { DesktopTurns } = require(path.join(root, 'src/main/desktop/desktopTurns.ts'));
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const activity = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels);
  const turns = new DesktopTurns(activity), begins = [];
  const originalBegin = turns.begin.bind(turns);
  turns.begin = (...args) => { begins.push(args); return originalBegin(...args); };
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  ctx.desktopTurns = () => turns;
  host.registerDriver(driver); openExecution(host, session('s1')); ctx.__sessionsDb.set('s1', session('s1'));
  const first = host.send('s1', 'first user instruction');
  await sleep(20); state.resolveConnect(); await first; await sleep(30);
  assert.equal(await turns.use('s1', begins[0][1], 'fixture', async () => 1), 1);
  const queued = await host.send('s1', 'queued before stop', undefined, { steerOnBusy: false });
  assert.equal(queued.queued, true);
  await turns.stop();
  state.queue.push({ type: 'turn-complete' }); await sleep(80);
  assert.equal(begins.length, 2);
  await assert.rejects(turns.use('s1', begins[1][1], 'fixture', async () => 2), /predates the latest stop/);
  state.redirectReturns = true;
  assert.equal((await host.send('s1', 'new user instruction')).steered, true);
  assert.equal(begins.length, 3);
  assert.notEqual(begins[2][1], begins[1][1]);
  assert.equal(await turns.use('s1', begins[2][1], 'fixture', async () => 3), 3);
  state.queue.push({ type: 'turn-complete' }); await sleep(40);
  await host.close('s1');
  } finally { removeDesktopFixture(tmp, 'gui-desktop-queued-'); }
}

async function testMessagingSessionUsesLiteralRemoteAuthority() {
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-messaging-session-'));
  const { MusterMessagingSessionHost } = require(path.join(root, 'src/main/messaging/sessionHost.ts'));
  const { MESSAGING_SESSION_OWNER, messagingSessionOwner, messagingTurnIdentity } = require(path.join(root, 'src/main/messaging/sessionAuthority.ts'));
  const workspace = { id: 'workspace', name: 'Messaging fixture', path: tmp };
  const { host, ctx } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: workspace.id });
  const { driver, state } = makeFakeDriver();
  const begin = [];
  const account = { channelKey: 'fixture', botId: 'one' };
  const sessionId = 'remote-session';
  const requestId = 'fixture-source-message';
  const row = session(sessionId, { cwd: tmp, workspaceId: workspace.id, configurePermissions: true, guiMode: 'ask',
    meta: { [MESSAGING_SESSION_OWNER]: messagingSessionOwner(account) } });
  const owner = new MusterMessagingSessionHost(ctx);
  const base = owner.createHarness({ workspace: tmp }, account.channelKey);
  const messaging = base.forBot(account.botId);
  let turn;
  try {
    ctx.agentSessions = host;
    ctx.desktopTurns = () => ({ begin: (...args) => begin.push(args) });
    ctx.__sessionsDb.set(sessionId, row);
    host.registerDriver(driver);
    const mirrored = [];
    const detach = owner.subscribeSessionEvents((session, event) => { if (session.id === sessionId) mirrored.push(event); });
    assert.equal(await base.health(), true);
    assert.equal(await base.forBot('other').sessionExists(sessionId), false);
    await assert.rejects(base.forBot('other').ask(sessionId, 'foreign'), { code: 'session-not-found' });
    assert.equal((await host.setMode(sessionId, 'auto')).ok, false);
    const controls = { owner: {}, key: 'synthetic-chat' };
    const offered = [];
    turn = messaging.ask(sessionId, '/skill:fixture /clear', {
      requestId, control: controls, timeoutMs: 4000, onInteraction: request => offered.push(request)
    });
    void turn.catch(() => {});
    await waitUntil('remote connection', () => state.resolveConnect);
    state.resolveConnect();
    await waitUntil('literal remote input', () => state.sends.length === 1);
    const ids = messagingTurnIdentity(requestId);
    assert.equal(host.currentAssistantMessageId(sessionId), ids.assistantMessageId);
    assert.equal(await messaging.hasActiveTurn(sessionId, controls), true);
    assert.equal(await messaging.stopActiveTurn(sessionId, { owner: {}, key: controls.key }), false);
    assert.deepEqual(begin, []);
    assert.equal(state.authorities[0].userText, undefined);
    assert.equal(state.authorities[0].literalText, true);
    assert.match(state.sends[0], /\/skill:fixture \/clear$/);

    const approval = state.inputs[0].requestApproval({ toolCallId: 'call-fixture', toolName: 'fixture-tool', input: { private: 'fixture' } });
    await waitUntil('scoped approval', () => offered.length === 1);
    assert.equal(offered[0].payload.input, undefined);
    await assert.rejects(offered[0].respond({ ok: true, value: { sessionId: 'foreign', approvalId: offered[0].interactionId, outcome: 'allowed-once' } }),
      { code: 'interaction-bad-response' });
    await offered[0].respond({ ok: true, value: { sessionId, approvalId: offered[0].interactionId, outcome: 'allowed-once' } });
    assert.equal((await approval).approved, true);

    state.queue.push({ type: 'text-delta', delta: 'remote reply' });
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('remote turn completion', () => !host.isBusy(sessionId));
    assert.equal(await turn, 'remote reply');
    assert.equal(await messaging.ask(sessionId, 'duplicate', { requestId }), 'remote reply');
    assert.equal(state.sends.length, 1);
    assert.deepEqual(mirrored, []);
    const history = (await messaging.readSessionHistory(sessionId)).events.map(({ event }) => event);
    assert.deepEqual(history.map(event => event.type), ['turn/start', 'user/message', 'assistant/message', 'turn/end']);
    assert.deepEqual(history[1].data.content, [{ type: 'text', text: '/skill:fixture /clear' }]);
    assert.equal(history[1].data.source.rpcId, ids.userMessageId);
    assert.equal(history[1].data.turn, history.at(-1).data.turn);

    turn = messaging.ask(sessionId, 'Review this text', { timeoutMs: 4000,
      files: [{ name: 'message.txt', mediaType: 'text/plain', load: async () => Buffer.from('Synthetic attachment contents') }] });
    let attachmentFailure;
    void turn.catch(error => { attachmentFailure = error; });
    await waitUntil('prepared remote attachment', () => state.sends.length === 2 || attachmentFailure);
    if (attachmentFailure) throw attachmentFailure;
    assert.match(state.sends[1], /Synthetic attachment contents/);
    state.queue.push({ type: 'text-delta', delta: 'file reply' });
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('remote attachment turn completion', () => !host.isBusy(sessionId));
    assert.equal(await turn, 'file reply');

    assert.equal((await host.send(sessionId, 'local mirror instruction')).ok, true);
    await waitUntil('local dedicated turn', () => state.sends.length === 3);
    assert.deepEqual(begin, []);
    state.queue.push({ type: 'text-delta', delta: 'local mirror answer' });
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('local mirror completion', () => mirrored.length === 4);
    assert.deepEqual(mirrored.map(event => event.type), ['turn/start', 'user/message', 'assistant/message', 'turn/end']);
    assert.deepEqual(mirrored[1].data.content, [{ type: 'text', text: 'local mirror instruction' }]);
    assert.equal(mirrored[1].data.turn, mirrored.at(-1).data.turn);
    detach();
    owner.stopAdmission();
    await assert.rejects(messaging.ask(sessionId, 'after shutdown'), { code: 'harness-closing' });
    assert.equal(host.pushSubs.size, 0);
  } finally {
    await owner.stopAndWait();
    await turn?.catch(() => {});
    await host.close(sessionId);
    removeDesktopFixture(tmp, 'gui-messaging-session-');
  }
}

async function testMessagingArtifactReceiptBoundary() {
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-messaging-artifact-'));
  const { MusterMessagingSessionHost } = require(path.join(root, 'src/main/messaging/sessionHost.ts'));
  const { MESSAGING_SESSION_OWNER, messagingSessionOwner, messagingTurnIdentity } = require(path.join(root, 'src/main/messaging/sessionAuthority.ts'));
  const workspace = { id: 'workspace', name: 'Messaging artifact fixture', path: tmp };
  const { host, ctx } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: workspace.id });
  const account = { channelKey: 'fixture', botId: 'artifact' };
  const row = session('release-artifact', { cwd: tmp, workspaceId: workspace.id, configurePermissions: true, guiMode: 'ask',
    meta: { [MESSAGING_SESSION_OWNER]: messagingSessionOwner(account) } });
  const owner = new MusterMessagingSessionHost(ctx);
  const offered = [];
  const harness = owner.createHarness({ workspace: tmp, createArtifact: async file => file }, account.channelKey).forBot(account.botId);
  const completions = new Map();
  try {
    ctx.agentSessions = host;
    ctx.__sessionsDb.set(row.id, row);
    fs.writeFileSync(path.join(tmp, 'result.txt'), 'synthetic deliverable');
    host.getHistoryRange = (_id, _before, _max, messageId) => ({ messages: completions.has(messageId) ? [completions.get(messageId)] : [] });
    host.sendMessagingInput = (_id, input) => {
      const { assistantMessageId } = messagingTurnIdentity(input.requestId);
      if (!completions.has(assistantMessageId)) {
        const finalizing = input.requestId === 'still-preparing';
        const assistant = { id: assistantMessageId, role: 'assistant', ts: Date.now(), finishedAt: Date.now(),
          parts: [{ kind: 'text', text: '[Result](result.txt)' }], turnChanges: { id: 'fixture',
            state: finalizing ? 'collecting' : 'ready', finalizing, files: [{ path: 'result.txt', kind: 'added', origin: 'native-tool' }], warnings: [] } };
        completions.set(assistantMessageId, assistant);
        for (const subscriber of host.pushSubs) subscriber({ kind: 'sync', sessionId: row.id, messages: [assistant] });
      }
      return { status: 'accepted', turnId: assistantMessageId };
    };
    const request = { requestId: 'quick-result', onArtifact: artifact => offered.push(artifact) };
    assert.equal(await harness.ask(row.id, 'prepare the result', request), '[Result](result.txt)');
    assert.equal(offered.length, 1);
    assert.equal(offered[0].fileName, 'result.txt');
    assert.equal(await harness.ask(row.id, 'duplicate', request), '[Result](result.txt)');
    assert.equal(offered.length, 1);

    const answer = await harness.ask(row.id, 'prepare another result', { ...request, requestId: 'still-preparing', timeoutMs: 100 });
    assert.match(answer, /still being prepared and were not attached/);
    assert.equal(offered.length, 1);
  } finally {
    await owner.stopAndWait();
    await host.close(row.id);
    removeDesktopFixture(tmp, 'gui-messaging-artifact-');
  }
}

async function testWorkbenchRemoteExistingGuiTurn() {
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-workbench-remote-'));
  const { WorkbenchMessagingHost } = require(path.join(root, 'src/main/messaging/workbenchBridge.ts'));
  const workspace = { id: 'workspace', name: 'Workbench fixture', path: tmp };
  const { host, ctx } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: workspace.id });
  const { driver, state } = makeFakeDriver();
  const row = session('existing-worker', { cwd: tmp, workspaceId: workspace.id });
  const desktop = [];
  ctx.agentSessions = host;
  ctx.workspaces = { list: () => [workspace] };
  ctx.sessions.listForAgent = () => ({ sessions: [row] });
  ctx.sessions.isChatRuntime = runtime => runtime === 'pi';
  ctx.orchestrator = {};
  ctx.desktopTurns = () => ({ begin: (...args) => desktop.push(args), end() {} });
  ctx.__sessionsDb.set(row.id, row);
  host.registerDriver(driver);
  const bridge = new WorkbenchMessagingHost(ctx);
  const receive = (messageId, text) => bridge.handle({ channelKey: 'weixin', botId: 'test-bot', conversationId: 'test-chat',
    messageId, senderId: 'paired-user', senderIsBot: false, conversationType: 'direct', addressed: false, text });
  let remote;
  try {
    assert.match((await receive('bind', '/bind 1')).text, /existing-worker/);
    remote = receive('remote-input', '/skill:fixture');
    await waitUntil('bound Worker connects', () => state.resolveConnect);
    state.resolveConnect();
    await waitUntil('bound remote input reaches driver', () => state.sends.length === 1);
    assert.equal(state.authorities[0].literalText, true);
    assert.equal(state.authorities[0].userText, undefined);
    assert.deepEqual(desktop, []);
    state.redirectReturns = true;
    const desktopResult = await host.send(row.id, 'desktop work', undefined, { steerOnBusy: true });
    assert.equal(desktopResult.queued, true);
    assert.deepEqual(state.redirects, []);

    state.queue.push({ type: 'text-delta', delta: 'bound Worker reply' });
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('desktop input begins as another turn', () => state.sends.length === 2);
    assert.deepEqual(await remote, { text: 'bound Worker reply' });
    assert.equal(desktop.length, 1);
    state.queue.push({ type: 'text-delta', delta: 'desktop-only reply' });
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('desktop turn completion', () => !host.isBusy(row.id));
    assert.equal(host.pushSubs.size, 0);

    remote = receive('remote-stop-eligible', 'stop this remote task');
    await waitUntil('next remote task starts', () => state.sends.length === 3);
    assert.match((await receive('stop', '/stop')).text, /已请求停止/);
    await waitUntil('remote stop reaches the driver', () => state.aborts === 1 && !host.isBusy(row.id));
    assert.deepEqual(await remote, { text: '' });
  } finally {
    await bridge.stopAndWait();
    await remote?.catch(() => {});
    await host.close(row.id);
    removeDesktopFixture(tmp, 'gui-workbench-remote-');
  }
}

async function testDesktopAttachmentAcceptedBeforeStopCannotResume() {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-desktop-attachment-'));
  try {
  const { DesktopActivity } = require(path.join(root, 'src/main/desktop/desktopActivity.ts'));
  const { DesktopTurns } = require(path.join(root, 'src/main/desktop/desktopTurns.ts'));
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const turns = new DesktopTurns(new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels));
  const begins = [], originalBegin = turns.begin.bind(turns);
  turns.begin = (...args) => { begins.push(args); return originalBegin(...args); };
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  const row = session('s1');
  ctx.desktopTurns = () => turns;
  ctx.__sessionsDb.set('s1', row); host.registerDriver(driver); openExecution(host, row); ctx.agentSessions = host;
  ctx.usage = { recordSessionActivity() {}, recordGuiWorkerSend() {} };
  let attachmentEntered, finishAttachment;
  const entered = new Promise(resolve => { attachmentEntered = resolve; });
  const delayed = new Promise(resolve => { finishAttachment = resolve; });
  const ipcFile = path.join(root, 'src/main/ipc/agentSession.ts');
  const ipcAst = ts.createSourceFile(ipcFile, fs.readFileSync(ipcFile, 'utf8'), ts.ScriptTarget.Latest, true);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ipcAst) === 'handle' && node.arguments[0]?.text === 'agentSession:send') callback = node.arguments[1].getText(ipcAst);
    ts.forEachChild(node, visit);
  }
  visit(ipcAst);
  const send = new Function('ctx', 'prepareGuiInput', 'randomUUID',
    ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
    ctx, async (_ctx, _session, text) => { attachmentEntered(); await delayed; return { text, images: [] }; },
    () => 'host-message-id');
  const result = send(null, { sessionId: 's1', text: 'message accepted before stop', images: [{ data: 'x', mimeType: 'text/plain' }] });
  await Promise.race([entered, result.then(receipt => assert.fail(`send settled before input preparation: ${JSON.stringify(receipt)}`))]);
  await turns.stop();
  finishAttachment();
  assert.equal((await result).ok, true);
  await sleep(20); state.resolveConnect(); await sleep(20);
  assert.equal(begins.length, 1);
  await assert.rejects(turns.use('s1', begins[0][1], 'fixture', async () => 1), /predates the latest stop/,
    'attachment conversion must not refresh a pre-stop user instruction');
  state.queue.push({ type: 'turn-complete' }); await sleep(40);
  await host.close('s1');
  } finally { removeDesktopFixture(tmp, 'gui-desktop-attachment-'); }
}

async function testDesktopInjectedMessagesAreNotUserInstructions() {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-desktop-injected-'));
  try {
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  const begins = [];
  ctx.desktopTurns = () => ({ begin(owner, turnId, current, userInstruction) { begins.push({ owner, turnId, current, userInstruction }); }, end() {} });
  host.registerDriver(driver); openExecution(host, session('s1')); ctx.__sessionsDb.set('s1', session('s1'));
  const first = host.send('s1', 'automated task', undefined, { fromInject: true });
  await sleep(20); state.resolveConnect(); await first; await sleep(30);
  assert.equal(begins[0].userInstruction, false, '自动注入的首轮不代表用户恢复桌面');
  state.redirectReturns = true;
  assert.equal((await host.send('s1', 'automatic steer', undefined, { fromInject: true })).steered, true);
  assert.equal(begins.length, 1, '自动注入插话不能恢复桌面');
  state.conn.receiveMessage = async message => {
    state.queue.push({ type: 'native-message-start', messageId: message.messageId, text: message.text });
    await sleep(25); return { status: 'accepted', method: 'queued' };
  };
  await host.send('s1', 'automatic native', undefined, { fromInject: true, messageId: 'auto-native' });
  assert.equal(begins.length, 1, '自动消息先于回执消费时也不能恢复桌面');
  state.conn.receiveMessage = undefined;
  state.redirectReturns = false;
  const queued = await host.send('s1', 'automatic queued', undefined, { fromInject: true });
  assert.equal(queued.queued, true);
  state.queue.push({ type: 'turn-complete' }); await sleep(80);
  assert.equal(begins.at(-1).userInstruction, false, '自动队列出队时不能恢复桌面');
  state.queue.push({ type: 'turn-complete' }); await sleep(40);
  const nudge = await host.injectHostNudge('s1', '内部领域状态提醒');
  assert.equal(nudge.ok, true, '宿主提醒仍应投递给 Agent');
  await sleep(30);
  assert.equal(
    host.getHistory('s1').messages.some(message => message.parts.some(part => part.kind === 'text' && part.text.includes('内部领域状态提醒'))),
    false,
    '宿主提醒不应出现在普通聊天转写中'
  );
  await host.close('s1');
  } finally { removeDesktopFixture(tmp, 'gui-desktop-injected-'); }
}

async function testDefaultModeAuto() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { host } = makeHost(tmp);
  host.registerDriver(makeFakeDriver().driver);
  openExecution(host, session('s1'));
  assert.equal(host.getMode('s1'), 'auto', '新会话默认档 auto');
  openExecution(host, session('s2', { permissionMode: 'ask' }));
  assert.equal(host.getMode('s2'), 'auto', 'legacy ask is archived until manual configuration is enabled');
  openExecution(host, session('s2-manual', { configurePermissions: true, permissionMode: 'ask' }));
  assert.equal(host.getMode('s2-manual'), 'ask');
  openExecution(host, session('s3', { configurePermissions: true, permissionMode: 'acceptEdits' }));
  assert.equal(host.getMode('s3'), 'default', 'acceptEdits 迁 default，不得升成 auto');
  openExecution(host, session('s4', { configurePermissions: true, guiMode: 'ask', permissionMode: 'auto' }));
  assert.equal(host.getMode('s4'), 'ask', '显式 guiMode 优先于 permissionMode');
  openExecution(host, session('cursor-default', { runtime: 'acp', piModeId: 'cursor' }));
  assert.equal(host.getMode('cursor-default'), 'default', 'Cursor follows its native default');
  openExecution(host, session('cursor-ask', { runtime: 'acp', piModeId: 'cursor', guiMode: 'ask' }));
  assert.equal(host.getMode('cursor-ask'), 'default', 'legacy Cursor host modes never become effective native values');
}

async function testAbortDuringConnecting() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  // 发送 → startTurn await ensureConnection（connect 挂起中）→ 用户点停止
  const sendP = host.send('s1', '干活');
  await sleep(20);
  assert.equal(state.connects, 1, '连接已发起');
  assert.equal(host.isBusy('s1'), true, 'busy 已置位（防并发）');
  await host.abort('s1');
  state.resolveConnect(); // 连接此时才落地
  await sendP;
  await sleep(60);
  assert.equal(state.aborts >= 1, true, '迟到落地的连接被补停（abort 链上 connecting）');
  assert.equal(state.sends.length, 0, '回合没有发起（不再照跑完）');
  const hist = host.getHistory('s1');
  assert.equal(hist.messages[hist.messages.length - 1].aborted, true, '回合标记 aborted');
}

async function testLatePrepareFailureDoesNotFinishReplacement() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-late-prepare-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver); openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  // 旧回合的基线准备挂起；同步登记后引擎必须照常启动，不再等待准备。
  let settleOldReady;
  const oldSummary = { id: 'old-snapshot', state: 'error', files: [], warnings: ['文件基线不可用：controlled'] };
  nextTurnChangeBegin = { summary: oldSummary, ready: new Promise(resolve => { settleOldReady = resolve; }), toolStart() {}, toolEnd() {}, finish: async () => ({ ...oldSummary }) };
  await host.send('s1', '旧请求');
  await sleep(20);
  assert.equal(state.connects, 1, '旧回合已建连（同步登记后引擎立即启动）');
  await host.abort('s1');
  state.resolveConnect(); // 连接落地，旧回合按中止收口
  await sleep(20);
  assert.equal(host.isBusy('s1'), false);
  await host.send('s1', '重新发送的请求');
  await sleep(20);
  assert.equal(state.connects >= 2, true, '新回合不等基线，直接建连');
  settleOldReady(); // 旧准备的迟到结果
  await sleep(20);
  assert.equal(host.isBusy('s1'), true, '旧准备迟到结果不得把新回合提前收口');
  state.resolveConnect(); await sleep(50);
  assert.deepEqual(state.sends, ['重新发送的请求']);
  state.queue.push({ type: 'text-delta', delta: '新回合正常回复' });
  state.queue.push({ type: 'turn-complete' }); await sleep(40);
  const reply = host.observe('s1').lastReply;
  assert.equal(reply.status, 'completed'); assert.equal(reply.text, '新回合正常回复');
  await host.close('s1');
}

/** 审阅准备无限期挂起：引擎必须照常发送/回复（启动链无硬依赖）。 */
async function testHangingPreparationNeverBlocksEngine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-hanging-prepare-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver); openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const summary = { id: 'hanging-snapshot', state: 'collecting', files: [], warnings: [] };
  nextTurnChangeBegin = { summary, ready: new Promise(() => {}), toolStart() {}, toolEnd() {}, finish: async () => ({ ...summary, state: 'error', warnings: ['文件基线不可用'] }) };
  const sendP = host.send('s1', '干活');
  await sleep(20);
  assert.equal(state.connects, 1, '连接不被基线准备阻塞');
  state.resolveConnect();
  await sendP; await sleep(40);
  assert.deepEqual(state.sends, ['干活'], '引擎照常收到发送');
  state.queue.push({ type: 'text-delta', delta: '照常回复' });
  state.queue.push({ type: 'turn-complete' }); await sleep(40);
  const reply = host.observe('s1').lastReply;
  assert.equal(reply.status, 'completed'); assert.equal(reply.text, '照常回复');
  assert.equal(host.isBusy('s1'), false);
  await host.close('s1');
}

async function testCloseDuringConnecting() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', '干活');
  await sleep(20);
  await host.close('s1'); // connect 还在途
  state.resolveConnect(); // 迟到落地：closed 检查必须把它关掉
  await sendP;
  await sleep(60);
  assert.equal(state.closes >= 1, true, '迟到连接被回收，无泄漏');
}

async function testApprovalAnchorAndErrorSettle() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1', { configurePermissions: true }));
  ctx.__sessionsDb.set('s1', session('s1', { configurePermissions: true }));

  // 手动驱动：连接后先来一段文本，再挂审批，随后事件流 error 收口
  let approvalReq = null;
  const origDriverConnect = driver.connect;
  driver.connect = (input) => {
    approvalReq = input; // 捕获 connect input（requestApproval 等）
    return origDriverConnect(input);
  };
  const sendP = host.send('s1', '跑个命令');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  assert.ok(approvalReq?.requestApproval, 'connect input 带审批回调');
  state.queue.push({ type: 'text-delta', delta: '先想想…' });
  await sleep(20);
  // 挂起审批（不弹 UI，直接拿 promise）——锚点应=当前 parts 长度（1）
  // 2026-10-26 对齐现行审批门：authorizeWorkerOperation 先过 policy 三档表，bash/npm
  // 在 auto 档恒 auto 放行、ctx.safety/humanConfirm 已不在宿主审批链（safety 门移至
  // catalog executor）。挂卡改走 fail-closed 路径：未注册工具名 classifyToolName=null
  // → prompt → 人类审批卡（生命周期语义不变：锚点/blocked/error 收口终态化）
  const decisionP = approvalReq.requestApproval({
    toolCallId: 'tc-1',
    toolName: 'vendor-native-tool',
    input: { command: 'npm test' }
  });
  await sleep(20);
  let hist = host.getHistory('s1');
  const assistant = hist.messages[hist.messages.length - 1];
  assert.ok(assistant.approval, '审批卡挂上');
  assert.equal(assistant.approval.anchorPartIndex, 1, '锚点=请求时 parts 长度');
  assert.equal(ctx.__signals.some(([k]) => k === 'blocked'), true, '看板 blocked');
  // 事件流 error 收口：悬挂审批必须终态化，不能留僵尸卡
  state.queue.push({ type: 'error', message: '引擎崩了' });
  await sleep(60);
  hist = host.getHistory('s1');
  const settled = hist.messages[hist.messages.length - 1];
  assert.equal(settled.approval, undefined, 'error 收口后审批卡被清除');
  assert.equal(settled.error, '引擎崩了', '错误落在消息上');
  assert.equal(host.isBusy('s1'), false, '回合收口');
  const decision = await Promise.race([decisionP, sleep(200).then(() => 'timeout')]);
  assert.equal(decision.approved, false, '悬挂审批被拒绝终态化');
  assert.match(decision.reason, /回合已结束|Session changed/, '结束回合不得沿用审核许可');
  assert.equal(
    ctx.__signals.some(([k, ev]) => k === 'idle' && ev === 'gui-turn-end'),
    true,
    '看板回 idle（不被悬挂审批卡死在 blocked）'
  );
}

async function testQueueDispatch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  // 第一轮：连接挂起中再排一条（busy 入队）
  const p1 = host.send('s1', '第一条');
  await sleep(20);
  const sourceAgent = { sessionId: 'child-pixel', name: '像素 · 按钮布局', characterId: 'pixel' };
  const queued = await host.send('s1', '第二条', undefined, { fromInject: true, source: 'agent', sourceAgent });
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true, 'busy 中入队');
  assert.deepEqual(host.getHistory('s1').messages.find(m => m.source === 'agent')?.sourceAgent, sourceAgent, '忙时汇报立即保留职业身份');
  state.resolveConnect();
  await p1;
  await sleep(40);
  // 第一轮回合：完成 → 派发队列（queued 标记清除）
  state.queue.push({ type: 'turn-complete' });
  await sleep(60);
  assert.equal(state.sends.length, 2, '队列消息在回合结束后派发');
  const hist = host.getHistory('s1');
  assert.deepEqual(hist.messages.find(m => m.source === 'agent')?.sourceAgent, sourceAgent, '出队后职业身份不能丢失');
  assert.equal(
    hist.messages.some((m) => m.queued),
    false,
    '派发后无残留 queued 标记'
  );
  state.queue.push({ type: 'turn-complete' });
  await sleep(40);
  const observed = host.observe('s1');
  assert.equal(observed.busy, false);
  assert.ok(observed.lastReply.finishedAt > 0, '只有实际收口后才有结束时间');
  host.flushPersist();
  assert.equal(host.store.load('s1').find(m => m.id === observed.lastReply.messageId).finishedAt,
    observed.lastReply.finishedAt, '回复结束标记随统一历史持久化');
}

// 回归：插话不支持时选择“中断后发送”，中止收口不得先把待发送条目
// 自动派发成一轮，再让替代消息重复入队。兜底发送完成后由界面摘掉选中条目。
async function testAbortHoldQueueForSteerFallback() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-steer-fallback-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));

  const first = host.send('s1', '当前回合');
  await sleep(20);
  const queued = await host.send('s1', '立即改做', undefined, { steerOnBusy: false });
  assert.equal(queued.queued, true);
  const queuedId = host.getHistory('s1').messages.find((m) => m.queued)?.id;
  assert.ok(queuedId);
  state.resolveConnect();
  await first;
  await sleep(40);

  await host.abort('s1', { holdQueue: true });
  await sleep(40);
  assert.equal(state.sends.length, 1, 'holdQueue 中止不能先派发待发送条目');
  assert.equal(host.entries.get('s1').queue.length, 1, '中止后队列仍保留待发送条目');

  const replacement = await host.send('s1', '立即改做', undefined, { steerOnBusy: false });
  assert.equal(replacement.ok, true);
  assert.equal(replacement.queued, undefined, '中止后替代消息应直接发送');
  await waitUntil('replacement connection requested', () => state.connects >= 2);
  state.resolveConnect();
  await sleep(30);
  assert.equal(state.sends.at(-1), '立即改做');
  assert.equal(host.entries.get('s1').queue.length, 1, '替代发送不会复制队列条目');

  assert.equal(host.cancelQueued('s1', queuedId), true, '发送成功后可摘掉原排队条目');
  assert.equal(host.entries.get('s1').queue.length, 0);
  await host.abort('s1');
}

// M-7：driver 上报插话注入失败 → Host 把文本回队，本回合结束后自动送达
async function testSteeringFailedRequeue() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const p1 = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await p1;
  await sleep(30);
  state.queue.push({ type: 'steering-failed', text: '关键补充', reason: 'stream closed' });
  await sleep(30);
  let hist = host.getHistory('s1');
  assert.ok(
    hist.messages.some((m) => m.role === 'user' && m.queued),
    'M-7：失败插话落为 queued 消息'
  );
  state.queue.push({ type: 'turn-complete' });
  await sleep(60);
  assert.ok(state.sends.includes('关键补充'), 'M-7：回合结束自动送达回队的插话');
  hist = host.getHistory('s1');
  assert.equal(
    hist.messages.some((m) => m.queued),
    false,
    '派发后 queued 标记清除'
  );
  state.queue.push({ type: 'turn-complete' });
  await sleep(40);
}

// gui-worker-session F-02：插话失败回队遇队列满（8 条）不得静默丢——必须推 error 回执
async function testSteeringFailedQueueFullErrorReceipt() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const pushes = [];
  host.onPush((p) => pushes.push(p));
  const p1 = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await p1;
  await sleep(30);
  // 队列填满 8 条（MAX_QUEUE）
  const entry = host.entries.get('s1');
  for (let i = 0; i < 8; i++) entry.queue.push({ messageId: `f02-q${i}`, text: `占位${i}` });
  state.queue.push({ type: 'steering-failed', text: '队满插话', reason: 'stream closed' });
  await sleep(30);
  const errPush = pushes.find((p) => p.kind === 'error');
  assert.ok(errPush, 'F-02：队满丢插话必须推 error 回执（发送方可见），不得只写日志');
  assert.ok(errPush.sessionId === 's1', 'error 回执带 sessionId');
  assert.ok(String(errPush.message).includes('排队已满'), 'error 回执文案点名排队已满');
  assert.ok(String(errPush.message).includes('stream closed'), 'error 回执携带失败原因');
  // 文本既没入队也没落历史：确认是「显式失败」而非「静默丢失」
  assert.equal(entry.queue.some((q) => q.text === '队满插话'), false, '队满时不得入队');
  assert.equal(
    host.getHistory('s1').messages.some((m) => m.role === 'user' && m.parts?.some?.((p) => p.text === '队满插话')),
    false,
    '队满时不得落历史消息'
  );
  state.queue.push({ type: 'turn-complete' });
  await sleep(40);
}

async function testStoreCorruptJson() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-store-'));
  const store = new GuiSessionStore(tmp);
  // 正常读写
  store.save('s1', [{ id: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }], ts: 1 }]);
  store.flushSync();
  assert.equal(store.load('s1').length, 1, '正常保存可读');
  // 半写/损坏 JSON：load 不抛、按空处理
  store.delete('s1');
  fs.writeFileSync(path.join(tmp, 'agent-sessions', 's1.json'), '{"version":2,"messages":[{broken', 'utf8');
  assert.deepEqual(store.load('s1'), [], '损坏 JSON 降级为空数组');
}

/** 一次恢复只解析一个信封；外改后下一次恢复重新读盘，不能靠陈旧缓存省工作。 */
async function testSingleReadHistorySnapshot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-history-snapshot-'));
  const { host, ctx } = makeHost(tmp);
  const id = 'single-read';
  const meta = session(id);
  ctx.__sessionsDb.set(id, meta);
  const target = path.join(tmp, 'agent-sessions', `${id}.json`);
  const envelope = (text, tokens) => ({
    version: 1,
    messages: [
      { id: 'u', role: 'user', text: 'question', ts: 1, queued: true },
      { id: 'a', role: 'assistant', text, thinking: 'reasoning', ts: 2,
        tools: [{ id: 'tool', name: 'read', input: {}, status: 'running' }],
        approval: { approvalId: 'old', toolCallId: 'tool', toolName: 'read', input: {} },
        plan: { status: 'executing', active: true, steps: [{ text: 'step', done: false }], markdown: 'plan' } }
    ],
    injections: [null, { at: 3, segments: [{ source: 'policy', text: 'rules' }] }],
    compactions: [null, { at: 4, tokensBefore: 150, tokensAfter: 50 }, { at: 'invalid' }],
    lastUsage: { tokens, contextWindow: 1000, ts: 100 }
  });
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...args) {
    if (file === target) reads++;
    return originalRead.call(this, file, ...args);
  };
  const singleRead = (operation, label) => {
    reads = 0;
    const result = operation();
    assert.equal(reads, 1, `${label}: same JSON is read and parsed once`);
    return result;
  };
  try {
    fs.writeFileSync(target, JSON.stringify(envelope('first', 125)), 'utf8');
    const raw = singleRead(() => host.store.loadSnapshot(id), 'store snapshot');
    assert.deepEqual(raw.messages[1].parts.map(part => part.kind), ['thinking', 'tool', 'text'], 'v1 migration order is unchanged');
    assert.equal(raw.messages[0].queued, true, 'store does not take over host sanitization');
    assert.equal(raw.lastUsage.tokens, 125);
    assert.equal(raw.injections[0].segments[0].text, 'rules');
    assert.deepEqual(raw.compactions, [{ at: 4, tokensBefore: 150, tokensAfter: 50 }]);

    const cold = singleRead(() => host.getHistory(id), 'unopened getHistory');
    assert.equal(cold.messages[0].queued, undefined, 'restored queue is sanitized');
    assert.equal(cold.messages[1].approval, undefined, 'stale approval is removed');
    assert.equal(cold.messages[1].parts[1].tool.status, 'cancelled', 'orphan running tool is settled');
    assert.equal(cold.usage.tokens, 125); assert.equal(cold.usage.stale, true);
    assert.deepEqual(cold.injections, raw.injections); assert.deepEqual(cold.compactions, raw.compactions);

    fs.writeFileSync(target, JSON.stringify(envelope('external edit', 250)), 'utf8');
    const edited = singleRead(() => host.getHistory(id), 'next unopened getHistory after external edit');
    assert.equal(edited.messages[1].parts.at(-1).text, 'external edit');
    assert.equal(edited.usage.tokens, 250, 'no cross-call snapshot cache');

    fs.writeFileSync(target, JSON.stringify(envelope('latest before open', 500)), 'utf8');
    singleRead(() => openExecution(host, meta), 'first execution materialization');
    reads = 0;
    openExecution(host, meta);
    const live = host.getHistory(id);
    assert.equal(reads, 0, 'idempotent open and live history remain entirely in memory');
    assert.equal(live.messages[1].parts.at(-1).text, 'latest before open');
    assert.equal(live.messages[1].plan.status, 'pending', 'plan rehydration still restores a pending plan');
    assert.equal(live.messages[1].parts[1].tool.status, 'cancelled');
    assert.equal(live.usage.tokens, 500); assert.equal(live.usage.stale, true);
    assert.deepEqual(live.injections, raw.injections); assert.deepEqual(live.compactions, raw.compactions);
  } finally {
    fs.readFileSync = originalRead;
    await host.close(id);
    host.flushPersist();
    assert.equal(path.dirname(tmp), os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Live-entry validators omit only messages; metadata is read again on every request. */
async function testConditionalHistoryVersion() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-history-version-'));
  const { host, ctx } = makeHost(tmp);
  const { push, persistEntry } = require(path.join(root, 'src/main/agentSession/host/base.ts'));
  const meta = session('conditional-history');
  ctx.__sessionsDb.set(meta.id, meta); openExecution(host, meta);
  const entry = host.entries.get(meta.id);
  entry.messages = [{ id: 'large', role: 'user', ts: 1, parts: [{ kind: 'text', text: 'fixture '.repeat(40_000) }] }];
  persistEntry(host, entry, 'replace');
  const originalSave = host.store.save;
  const fullFor = (version, label, opts = {}) => {
    const history = host.getHistory(meta.id, { knownMessagesVersion: version, ...opts });
    assert.ok(Object.hasOwn(history, 'messages'), `${label}: full messages are required`);
    assert.notEqual(history.messagesUnchanged, true, `${label}: cannot claim unchanged messages`);
    return history;
  };
  try {
    const full = host.getHistory(meta.id);
    assert.equal(full.messages, entry.messages, 'legacy caller always receives the complete live messages');
    assert.match(full.messagesVersion, /^[0-9a-f-]+:\d+$/i);
    const reused = host.getHistory(meta.id, { knownMessagesVersion: full.messagesVersion });
    assert.equal(reused.messagesUnchanged, true);
    assert.equal(Object.hasOwn(reused, 'messages'), false, 'matching token omits the large payload entirely');
    assert.equal(reused.messagesVersion, full.messagesVersion);
    assert.ok(JSON.stringify(full).length > 300_000, 'fixture exercises a materially large message body');
    assert.ok(JSON.stringify(reused).length < 2000, 'unchanged response contains no copied message body');
    assert.equal(host.getHistory(meta.id).messages, entry.messages, 'a prior conditional request never changes the old caller contract');
    for (const token of [undefined, null, '', 'bad-token', `${full.messagesVersion}junk`, full.messagesVersion.replace(/:\d+$/, ':999')]) {
      fullFor(token, 'missing, malformed, or stale token');
    }

    // Metadata can change independently of messages or a UI push. A matching
    // message validator must still return every current metadata field.
    entry.mode = 'ask'; entry.busy = true; entry.thinkingLevel = 'high';
    meta.piModeId = 'updated-preset';
    meta.modelOverride = { providerId: 'p1', modelId: 'm2', params: [{ id: 'effort', value: 'high' }] };
    entry.lastUsage = { tokens: 321, contextWindow: 4096, ts: 123 };
    entry.injections = [{ at: 3, segments: [{ source: 'policy', text: 'latest', chars: 6, hash: 'fixture' }] }];
    entry.compactions = [{ at: 4, tokensBefore: 900, tokensAfter: 300 }];
    entry.slashCommands = [{ name: 'latest', description: 'updated command' }];
    entry.engineMode = { modeId: 'updated', name: 'Updated engine' };
    const metadata = host.getHistory(meta.id, { knownMessagesVersion: full.messagesVersion });
    assert.equal(metadata.messagesUnchanged, true);
    assert.equal(metadata.mode, 'ask'); assert.equal(metadata.busy, true);
    assert.equal(metadata.piModeId, 'updated-preset'); assert.equal(metadata.thinkingLevel, 'high');
    assert.deepEqual(metadata.modelOverride, meta.modelOverride);
    assert.equal(metadata.usage.tokens, 321); assert.equal(metadata.usage.stale, true);
    assert.deepEqual(metadata.injections, entry.injections); assert.deepEqual(metadata.compactions, entry.compactions);
    assert.deepEqual(metadata.slashCommands, entry.slashCommands); assert.deepEqual(metadata.engineMode, entry.engineMode);
    const { messages, messagesUnchanged, ...allMetadata } = host.getHistory(meta.id);
    const { messagesUnchanged: omitted, ...conditionalMetadata } = metadata;
    assert.deepEqual(conditionalMetadata, allMetadata, 'conditional and full replies carry the same complete metadata');
    entry.busy = false;

    const pushes = [
      { kind: 'sync', messages: entry.messages },
      { kind: 'delta', messageId: 'large', partIndex: 0, deltaKind: 'text', delta: 'x' },
      { kind: 'part', messageId: 'large', partIndex: 0, part: { kind: 'text', text: 'x' } },
      { kind: 'busy', busy: false, queued: 0 }, { kind: 'error', message: 'fixture error' },
      { kind: 'context', usage: null }, { kind: 'injections', injection: { kind: 'summary', at: 1, segments: [], toolCount: 0, toolsFingerprint: '', details: { key: '0'.repeat(64) } } },
      { kind: 'compaction', markerId: 'fixture', status: 'complete', at: 1 },
      { kind: 'engine-meta', slashCommands: [] }, { kind: 'parameters', controls: [] }
    ];
    for (const delivery of ['absent', 'throws']) {
      ctx.getWindow = delivery === 'absent' ? () => null : () => ({ webContents: { send() { throw new Error('destroyed window'); } } });
      for (const payload of pushes) {
        const before = host.getHistory(meta.id).messagesVersion;
        push(host, { sessionId: meta.id, ...payload });
        const changed = fullFor(before, `${delivery} window / ${payload.kind}`);
        assert.notEqual(changed.messagesVersion, before, 'version advances even when no window receives the push');
      }
    }
    ctx.getWindow = () => null;
    let version = host.getHistory(meta.id).messagesVersion;
    fullFor(version, 'light caller remains full', { light: true });
    entry.closed = true; fullFor(version, 'closed entry remains full'); entry.closed = false;
    entry.clearing = true; fullFor(version, 'clearing entry remains full'); entry.clearing = false;

    const warnings = [];
    entry.messages[0].turnChanges = { id: 'collecting-fixture', state: 'collecting', files: [], warnings };
    fullFor(version, 'collecting tracker remains full');
    warnings.push('late tracker warning before its final push');
    assert.deepEqual(fullFor(version, 'shared summary changed without a push').messages[0].turnChanges.warnings, warnings);
    entry.messages[0].turnChanges.state = 'ready';
    push(host, { kind: 'sync', sessionId: meta.id, messages: entry.messages });
    const settled = fullFor(version, 'finished tracker publishes a new version');
    version = settled.messagesVersion;
    assert.equal(host.getHistory(meta.id, { knownMessagesVersion: version }).messagesUnchanged, true, 'settled tracker no longer blocks conditional reads');

    version = host.getHistory(meta.id).messagesVersion;
    entry.messages.push({ id: 'persisted-edit', role: 'user', ts: 2, parts: [{ kind: 'text', text: 'edited without a push' }] });
    host.store.save = () => { throw new Error('fixture save failure'); };
    assert.throws(() => persistEntry(host, entry, [entry.assistant]), /fixture save failure/);
    const failedSave = fullFor(version, 'persist failure already invalidated the old snapshot');
    assert.notEqual(failedSave.messagesVersion, version);
    assert.equal(failedSave.messages.at(-1).id, 'persisted-edit');
  } finally {
    host.store.save = originalSave; ctx.getWindow = () => null;
    entry.closed = false; entry.clearing = false; entry.busy = false;
    await host.close(meta.id); host.flushPersist();
    assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testConditionalHistoryEditsAndGenerations() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-history-generation-'));
  const { host, ctx } = makeHost(tmp);
  const { handleEvent } = require(path.join(root, 'src/main/agentSession/host/events.ts'));
  const meta = session('history-generation');
  const fake = makeFakeDriver();
  ctx.__sessionsDb.set(meta.id, meta); host.registerDriver(fake.driver); openExecution(host, meta);
  const entry = host.entries.get(meta.id);
  const assistant = { id: 'assistant', role: 'assistant', ts: 1, parts: [{ kind: 'text', text: 'before tool' }] };
  entry.messages = [assistant, { id: 'queued', role: 'user', ts: 2, queued: true, parts: [{ kind: 'text', text: 'queued before edit' }] }];
  entry.assistant = assistant; entry.queue = [{ messageId: 'queued', text: 'queued before edit' }];
  require(path.join(root, 'src/main/agentSession/host/base.ts')).persistEntry(host, entry, 'replace');
  try {
    let before = host.getHistory(meta.id).messagesVersion;
    const initialVersion = before;
    handleEvent(host, entry, { type: 'tool-start', toolCallId: 'real-tool', toolName: 'read', input: { path: path.join(tmp, 'fixture.txt') } });
    let changed = host.getHistory(meta.id, { knownMessagesVersion: before });
    assert.notEqual(changed.messagesVersion, before);
    assert.equal(changed.messages[0].parts.at(-1).tool.status, 'running', 'real tool-start syncPart invalidates messages');
    before = changed.messagesVersion;
    handleEvent(host, entry, { type: 'tool-result', toolCallId: 'real-tool', ok: true, output: 'complete output', durationMs: 12 });
    changed = host.getHistory(meta.id, { knownMessagesVersion: before });
    assert.notEqual(changed.messagesVersion, before);
    assert.equal(changed.messages[0].parts.at(-1).tool.status, 'ok');
    assert.equal(changed.messages[0].parts.at(-1).tool.output, 'complete output');
    before = changed.messagesVersion;
    assert.equal(host.editQueued(meta.id, 'queued', 'edited queued text'), true);
    changed = host.getHistory(meta.id, { knownMessagesVersion: before });
    assert.notEqual(changed.messagesVersion, before);
    assert.equal(changed.messages.find(message => message.id === 'queued').parts[0].text, 'edited queued text');

    before = changed.messagesVersion;
    const reminderTarget = { kind: 'session', sessionId: meta.id };
    const oldInjection = {at: 1, segments: [{source: 'policy', chars: 12, hash: 'old-context', text: 'old metadata'}]};
    entry.injections.push(oldInjection);
    const oldDetails = host.store.recordInjection(meta.id, oldInjection).details;
    entry.compactions.push({at: 1, tokensBefore: 100, tokensAfter: 10});
    host.store.recordCompaction(meta.id, 0, entry.compactions[0]);
    reminderService.addSessionReminder(ctx, reminderTarget, '旧对话的待办', null);
    const clearing = host.clear(meta.id);
    const duringClear = host.getHistory(meta.id, { knownMessagesVersion: before });
    assert.notEqual(duringClear.messagesVersion, before, 'clear invalidates at entry, before awaiting abort or teardown');
    assert.ok(Object.hasOwn(duringClear, 'messages'));
    await clearing;
    assert.deepEqual(reminderService.listSessionReminders(ctx, reminderTarget).items, [], 'clearing the conversation also removes its reminders');
    assert.equal(host.entries.get(meta.id), entry, 'clear retains the same live entry identity');
    const empty = host.getHistory(meta.id, { knownMessagesVersion: before });
    assert.deepEqual(empty.messages, []); assert.notEqual(empty.messagesVersion, before);
    assert.equal(host.getHistory(meta.id, { knownMessagesVersion: empty.messagesVersion }).messagesUnchanged, true);
    const emptyRange = host.getHistoryRange(meta.id, undefined, 10);
    assert.deepEqual(emptyRange.messages, []);
    assert.deepEqual(emptyRange.metadataStatus, {injectionCount: 0, compactionCount: 0, compactionsOverflow: false});
    for (const kind of ['injections', 'compactions']) {
      const timeline = host.metadataTimeline(meta.id, kind);
      assert.equal(timeline.ok, true); assert.deepEqual(timeline.page.records, []); assert.equal(timeline.page.total, 0);
    }
    assert.equal(host.injectionDetails(meta.id, oldDetails).ok, false, 'old details are genuinely deleted');
    await host.send(meta.id, 'fresh turn after clear');
    for (let attempts = 0; !fake.state.resolveConnect && attempts < 100; attempts++) await sleep(5);
    assert.equal(typeof fake.state.resolveConnect, 'function', 'fresh send reaches a new engine connection');
    fake.state.resolveConnect(); await sleep(30);
    fake.state.queue.push({type: 'turn-complete'}); await sleep(30);
    assert.equal(host.getHistoryRange(meta.id, undefined, 10).injections.some(item => item.details.key === oldDetails.key), false);
    assert.equal(host.injectionDetails(meta.id, oldDetails).ok, false, 'next turn never resurrects the cleared generation');

    await host.close(meta.id); host.flushPersist();
    const target = path.join(tmp, 'agent-sessions', `${meta.id}.json`);
    fs.writeFileSync(target, JSON.stringify({ version: 2, messages: [
      { id: 'restored-user', role: 'user', ts: 3, queued: true, parts: [{ kind: 'text', text: 'disk edit after close' }] },
      { id: 'restored-assistant', role: 'assistant', ts: 4, parts: [{ kind: 'tool', tool: { id: 'restored-tool', name: 'read', input: {}, status: 'running' } }],
        plan: { status: 'executing', active: true, steps: [{ text: 'step', done: false }], markdown: 'restored plan' } }
    ] }), 'utf8');
    const disk = host.getHistory(meta.id, { knownMessagesVersion: empty.messagesVersion });
    assert.equal(disk.messagesVersion, undefined, 'disk fallback never claims a live-entry validator');
    assert.notEqual(disk.messagesUnchanged, true); assert.equal(disk.messages[0].queued, undefined);
    assert.equal(disk.messages[0].parts[0].text, 'disk edit after close');
    assert.equal(disk.messages[1].parts[0].tool.status, 'cancelled', 'disk fallback still sanitizes interrupted tools');
    openExecution(host, meta);
    const reopened = host.getHistory(meta.id, { knownMessagesVersion: empty.messagesVersion });
    assert.notEqual(host.entries.get(meta.id), entry);
    assert.notEqual(reopened.messagesVersion, empty.messagesVersion, 'new entry identity receives a different generation');
    assert.notEqual(reopened.messagesVersion, initialVersion, 'a fresh entry cannot collide with the previous entry revision-zero validator');
    assert.ok(Object.hasOwn(reopened, 'messages'));
    assert.equal(reopened.messages[1].plan.status, 'pending', 'open still rehydrates executing plans');
    assert.equal(host.getHistory(meta.id, { knownMessagesVersion: reopened.messagesVersion }).messagesUnchanged, true);
  } finally {
    await host.close(meta.id); host.flushPersist();
    assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testSnapshotDefaultsAndCompat() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-snapshot-defaults-'));
  const store = new GuiSessionStore(tmp);
  const target = path.join(tmp, 'agent-sessions', 'defaults.json');
  const empty = { messages: [], lastUsage: null, injections: [], compactions: [] };
  try {
    assert.deepEqual(store.loadSnapshot('missing'), empty, 'missing history keeps all previous defaults');
    fs.writeFileSync(target, JSON.stringify({ messages: 'bad', lastUsage: { tokens: 0, contextWindow: 1000, ts: 100 }, injections: 'bad', compactions: 'bad' }), 'utf8');
    assert.deepEqual(store.loadSnapshot('defaults'), empty, 'bad fields retain permissive parsing and fork-placeholder rejection');
    const modern = { id: 'u', role: 'user', parts: [{ kind: 'text', text: 'modern' }], ts: 1, steering: 'send', futureField: 'preserved' };
    fs.writeFileSync(target, JSON.stringify({ version: 2, messages: [modern] }), 'utf8');
    assert.deepEqual(store.loadSnapshot('defaults'), { ...empty, messages: [modern] }, 'v2 and unknown message fields remain intact');
    assert.deepEqual(store.load('defaults'), [modern], 'message-only loader retains its contract');
    const error = console.error;
    const diagnostics = [];
    try {
      console.error = (...args) => diagnostics.push(args);
      fs.writeFileSync(target, '{broken', 'utf8');
      assert.deepEqual(store.loadSnapshot('defaults'), empty, 'corrupt JSON keeps previous fallback');
      assert.equal(diagnostics.length, 1, 'one failed recovery reports one parse diagnostic');
    } finally { console.error = error; }
  } finally {
    assert.equal(path.dirname(tmp), os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testSteerVsQueue() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', 'first');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  assert.equal(host.isBusy('s1'), true, '首回合仍 busy（未 turn-complete）');

  state.redirectReturns = true;
  const steered = await host.send('s1', 'steer me');
  assert.equal(steered.ok, true);
  assert.equal(steered.steered, true, 'redirect 成功返回 steered');
  assert.equal(steered.queued, undefined, 'steer 不得标 queued');
  let hist = host.getHistory('s1');
  const steeredUser = [...hist.messages].reverse().find((m) => m.role === 'user');
  assert.equal(steeredUser?.queued, undefined, 'steer 消息无 queued 标记');
  assert.deepEqual(state.redirects, ['steer me']);
  assert.equal(hist.messages.at(-1)?.role, 'assistant', 'steer 后应新开 assistant');
  assert.equal(hist.messages.at(-2)?.role, 'user', '新 assistant 紧跟插话');
  assert.equal(hist.messages.at(-2)?.parts[0]?.text, 'steer me');

  state.redirectReturns = false;
  const queued = await host.send('s1', 'queue me');
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true, '无 redirect 才 queued');
  assert.equal(queued.steered, undefined);
  hist = host.getHistory('s1');
  const queuedUser = hist.messages.find((m) => m.queued);
  assert.equal(queuedUser?.parts[0]?.text, 'queue me');

  await host.abort('s1');
  await sleep(40);
}

// 回归：GUI 适配器没有真实 turn-scoped steer 时，不应把它自己的 native
// queue 当成“立即插话”成功；Host 必须在提交前直接返回 steerUnsupported，
// 让工作台自己的排队/兜底路径接管。
async function testUserSteerCapabilityGate() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-steer-capability-'));
  const { driver, state } = makeFakeDriver();
  driver.runtimeId = 'claude';
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1', { runtime: 'claude' }));
  ctx.__sessionsDb.set('s1', session('s1', { runtime: 'claude' }));

  const first = host.send('s1', '当前回合');
  await sleep(20);
  state.resolveConnect();
  await first;
  await sleep(35);

  let nativeCalls = 0;
  state.conn.receiveMessage = async () => {
    nativeCalls += 1;
    return { status: 'accepted', method: 'queued' };
  };
  const result = await host.send('s1', '立即改做', undefined, { steerOnBusy: true });
  assert.equal(result.ok, true);
  assert.equal(result.steerUnsupported, true, '无真实 steer 能力时只返回不支持插话');
  assert.equal(nativeCalls, 0, '不应把用户立即消息提交到 Harness 自带队列');
  assert.equal(host.entries.get('s1').queue.length, 0, 'unsupported 结果不进入 Host 队列');
  assert.equal(host.getHistory('s1').messages.some((m) => m.parts?.[0]?.text === '立即改做'), false);
  await host.abort('s1');
}

async function testSteerSplitsTranscriptTurn() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  const desktopBegins = [];
  ctx.desktopTurns = () => ({ begin(owner, turnId, current, userInstruction) { desktopBegins.push({ owner, turnId, current, userInstruction }); }, end() {} });
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', '第一条');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  state.queue.push({ type: 'text-delta', delta: '正在写旧内容…' });
  await sleep(20);
  assert.equal(host.isBusy('s1'), true);
  assert.deepEqual(state.sends, ['第一条']);

  state.redirectReturns = true;
  const r = await host.send('s1', '改做这件事');
  assert.equal(r.ok, true);
  assert.equal(r.steered, true, '投递仍走弱 steer，不中止');
  assert.equal(desktopBegins.length, 2, '已投递的用户插话要创建新的桌面活动代次');
  assert.notEqual(desktopBegins[1].turnId, desktopBegins[0].turnId, '用户插话必须切换桌面代次');
  assert.equal(desktopBegins[1].userInstruction, true);
  assert.equal(r.queued, undefined);
  assert.equal(state.aborts, 0, 'steer 不得 abort 当前流');
  assert.deepEqual(state.sends, ['第一条'], '不得另开引擎回合重发');

  const hist = host.getHistory('s1');
  assert.deepEqual(
    hist.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
    '插话应闭合旧回合并开新 assistant'
  );
  assert.equal(hist.messages[0].parts[0]?.text, '第一条');
  assert.equal(hist.messages[1].parts[0]?.text, '正在写旧内容…', '旧回复冻结');
  assert.equal(hist.messages[1].aborted, undefined, '弱 steer 不定稿 aborted');
  assert.equal(hist.messages[2].parts[0]?.text, '改做这件事');
  assert.equal(hist.messages[2].queued, undefined);
  assert.equal(hist.messages[2].steering, 'send', '可见插话标 steering:send（OFF 态渲染同普通用户气泡）');
  assert.equal(hist.messages[3].parts.length, 0, '新回合尚空，等后续 delta');
  assert.notEqual(hist.messages[1].id, hist.messages[3].id);

  // steering 事件去重：send() 已同步落 'send' 插话，driver 事件到达不得双落
  state.queue.push({ type: 'steering', text: '改做这件事' });
  await sleep(20);
  let after = host.getHistory('s1').messages;
  assert.equal(after.filter((m) => m.parts[0]?.text === '改做这件事').length, 1, '同文本插话事件被去重');
  // 另一条插话（宿主静默路径，未经 send 可见落定）→ 落 'host' 消息
  state.queue.push({ type: 'steering', text: '【后台任务】定时器到点' });
  await sleep(20);
  after = host.getHistory('s1').messages;
  const hostSteer = after.find((m) => m.parts[0]?.text === '【后台任务】定时器到点');
  assert.ok(hostSteer, '宿主静默插话落转写');
  assert.equal(hostSteer.steering, 'host', '静默插话标 steering:host（OFF 态不渲染）');
  assert.equal(hostSteer.role, 'user');
  assert.equal(desktopBegins.length, 2, '宿主静默插话不能解除桌面停止');

  state.queue.push({ type: 'text-delta', delta: '按新指令写…' });
  await sleep(20);
  const hist2 = host.getHistory('s1');
  assert.equal(hist2.messages[1].parts[0]?.text, '正在写旧内容…', '后续输出不得拼回旧流');
  assert.equal(hist2.messages[3].parts[0]?.text, '按新指令写…', '后续输出进新回合');
}

async function testCorePermissionProjection() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-permission-projection-'));
  const { host, ctx } = makeHost(tmp);
  ctx.sessions.get = id => {
    const row = ctx.sessions.peek(id);
    return row && { ...row };
  };
  const modes = [];
  host.onPush(event => {
    if (event.kind === 'permission-mode') modes.push([event.sessionId, event.mode]);
  });

  const cold = session('core-cold', { guiMode: 'ask' });
  ctx.__sessionsDb.set(cold.id, cold);
  host.open(cold);
  assert.equal(host.entries.has(cold.id), false);
  assert.equal((await host.setConfigurePermissions(cold.id, true)).ok, true);
  assert.equal(host.getHistory(cold.id).mode, 'ask');
  assert.equal(host.entries.has(cold.id), false, 'permission updates keep cold sessions cold');

  const row = session('core-live', { guiMode: 'auto' });
  openExecution(host, row);
  assert.equal((await host.setConfigurePermissions(row.id, true)).ok, true);
  assert.equal((await host.setMode(row.id, 'standard')).ok, true);
  assert.equal(host.getMode(row.id), 'standard');
  assert.equal((await host.setConfigurePermissions(row.id, false)).ok, true);
  assert.equal(host.getHistory(row.id).mode, 'auto');
  assert.equal(ctx.sessions.peek(row.id).guiMode, 'standard', 'automatic access keeps the manual mode on record');
  assert.equal((await host.setConfigurePermissions(row.id, true)).ok, true);
  assert.equal(host.getMode(row.id), 'standard');
  assert.equal(host.getHistory(row.id).mode, 'standard');

  ctx.sessions.updateConfigurePermissions = async () => { throw new Error('fixture persistence failed'); };
  assert.equal((await host.setConfigurePermissions(row.id, false)).ok, false);
  assert.equal(host.getMode(row.id), 'standard');
  assert.deepEqual(modes, [[cold.id, 'ask'], [row.id, 'auto'], [row.id, 'auto'], [row.id, 'standard']]);
  await host.close(row.id);
  await host.close(cold.id);
}

async function testPermissionOptIn() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-permission-'));
  const { driver, state } = makeFakeDriver('acp');
  driver.permissionStrategyHot = true;
  const { host, ctx } = makeHost(tmp);
  ctx.sessions.get = id => {
    const row = ctx.sessions.peek(id);
    return row && { ...row };
  };
  host.registerDriver(driver);
  let callbacks;
  let restoreFailure = true;
  const restored = [];
  const original = driver.connect.bind(driver);
  driver.connect = async input => {
    callbacks = input;
    return Object.assign(await original(input), {
      async restorePermissionStrategy(selections) {
        if (restoreFailure) throw new Error('native permission restore refused');
        restored.push(...selections);
      }
    });
  };
  const row = session('permission-opt-in', { runtime: 'acp' });
  openExecution(host, row);
  const send = host.send(row.id, 'request permissions');
  await waitUntil('connect', () => !!state.resolveConnect);
  state.resolveConnect();
  await send;
  await waitUntil('request callbacks', () => state.sends.length === 1 && !!callbacks.getTurnId());
  const request = (id, choices, signal) => callbacks.requestApproval({
    toolCallId: id, toolName: 'tool', input: {}, nativeChoices: choices
  }, signal);
  const allow = [{ id: 'persistent-native', name: 'Always', kind: 'allow_always' },
    { id: 'exact-allow-2', name: 'Once', kind: 'allow_once' }];
  assert.deepEqual(await request('auto', allow), { approved: true, nativeChoiceId: 'exact-allow-2' });
  assert.match((await request('no-allow', [{ id: 'deny', name: 'Deny', kind: 'reject_once' }])).reason, /native allow choice/);
  const alreadyAborted = AbortSignal.abort();
  assert.equal((await request('cancelled', allow, alreadyAborted)).approved, false);
  assert.equal(host.entries.get(row.id).activeApproval, null);

  assert.equal((await host.setConfigurePermissions(row.id, true)).ok, true);
  const first = request('manual', allow);
  const cancelQueued = new AbortController();
  const queued = request('queued', allow, cancelQueued.signal);
  await waitUntil('manual approval', () => !!host.entries.get(row.id).activeApproval);
  cancelQueued.abort();
  assert.equal((await queued).approved, false);
  const question = callbacks.requestUserQuestion({ questions: [{ id: 'question', question: 'Choose', options: [] }] });
  await waitUntil('ordinary question', () => !!host.entries.get(row.id).activeUserQuestion);
  assert.equal((await host.setConfigurePermissions(row.id, false)).ok, true);
  assert.deepEqual(await first, { approved: true, nativeChoiceId: 'exact-allow-2' });
  assert.ok(host.entries.get(row.id).activeUserQuestion, 'ordinary questions are not answered by a permission toggle');
  assert.equal(state.closes, 0, 'ACP permission toggles retain its native connection');
  const pendingQuestion = host.entries.get(row.id).activeUserQuestion;
  host.respondUserQuestion(row.id, pendingQuestion.questionId, 'abort');
  assert.equal((await question).kind, 'aborted');
  state.queue.push({ type: 'text-delta', delta: 'done' });
  state.queue.push({ type: 'turn-complete' });
  await waitUntil('turn complete', () => !host.isBusy(row.id));
  assert.equal((await request('stale', allow)).approved, false);

  await callbacks.onNativePermissionRestore([{ id: 'mode', value: 'ask' }]);
  assert.deepEqual(row.nativePermissionRestore, {
    identity: host.getNativeConfig(row.id).identity, selections: [{ id: 'mode', value: 'ask' }]
  });
  const failed = await host.setConfigurePermissions(row.id, true);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /native permission restore refused/);
  assert.equal(ctx.__sessionsDb.get(row.id).configurePermissions, false);
  assert.equal(row.nativePermissionRestore.selections[0].value, 'ask');
  restoreFailure = false;
  assert.equal((await host.setConfigurePermissions(row.id, true)).ok, true);
  assert.deepEqual(restored, [{ id: 'mode', value: 'ask' }]);
  assert.equal(row.nativePermissionRestore, undefined);
  assert.equal(row.configurePermissions, true);
  await host.close(row.id);
}

async function testOmpLaunchOnlyPermissionRestore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-permission-omp-'));
  const { driver, state } = makeFakeDriver('omp');
  const { host } = makeHost(tmp);
  host.registerDriver(driver);
  const row = session('permission-omp', { runtime: 'omp', runtimeResumeToken: 'native-omp-session', configurePermissions: true });
  openExecution(host, row);
  row.nativeConfig = { identity: host.getNativeConfig(row.id).identity,
    selections: [{ id: 'tools.approvalMode', value: 'always-ask' }] };
  const run = async (count, enabled) => {
    const sent = host.send(row.id, `round ${count}`);
    await waitUntil('OMP connects', () => state.connects === count);
    state.resolveConnect();
    assert.equal((await sent).ok, true);
    await waitUntil('OMP submits', () => state.sends.length === count);
    const input = state.inputs.at(-1);
    assert.equal(input.automaticPermissions, !enabled);
    assert.equal(input.resumeToken, 'native-omp-session');
    assert.deepEqual(input.nativeConfig, enabled ? row.nativeConfig : undefined);
    state.queue.push({ type: 'text-delta', delta: 'finished' });
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('OMP finishes', () => !host.isBusy(row.id));
  };
  await run(1, true);
  assert.equal((await host.setConfigurePermissions(row.id, false)).ok, true);
  await run(2, false);
  assert.equal((await host.setConfigurePermissions(row.id, true)).ok, true);
  await run(3, true);
  assert.equal(state.closes, 2);
  await host.close(row.id);
}

async function testAutomaticPlanApproval() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-permission-plan-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  let callbacks;
  const original = driver.connect.bind(driver);
  driver.connect = input => { callbacks = input; return original(input); };
  let confirms = 0;
  ctx.ui = { confirm: async (_title, _detail, options) => {
    confirms++;
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ confirmed: false }), { once: true }));
  } };
  const row = session('permission-plan', { configurePermissions: true, guiMode: 'plan' });
  openExecution(host, row);
  const send = host.send(row.id, 'plan this');
  await waitUntil('connect', () => !!state.resolveConnect);
  state.resolveConnect();
  await send;
  await waitUntil('plan prompt submitted', () => state.sends.length === 1);
  const request = {
    toolCallId: 'plan', toolName: 'ExitPlanMode', input: {
      plan: '# Test plan\n1. Inspect the fixture and validate the proposal before writing code.',
      allowedPrompts: ['npm test']
    }
  };
  const waiting = callbacks.requestApproval(request);
  await waitUntil('plan confirmation', () => confirms === 1);
  assert.equal((await host.setConfigurePermissions(row.id, false)).ok, true);
  const decision = await waiting;
  assert.equal(decision.approved, true);
  assert.match(decision.feedback, /Approved Plan/);
  assert.deepEqual(decision.allowedPrompts, ['npm test']);
  assert.equal((await callbacks.requestApproval({ ...request, toolCallId: 'second-plan' })).approved, true);
  assert.equal(confirms, 1);
  await host.close(row.id);
}

async function testExternalLegacyModeRejected() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  driver.runtimeId = 'acp';
  driver.resolveMode = id => id === 'cursor' ? { connectExtras: { acpAgent: id } } : null;
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1', { runtime: 'acp', piModeId: 'cursor' }));
  ctx.__sessionsDb.set('s1', session('s1', { runtime: 'acp', piModeId: 'cursor' }));
  const sendP = host.send('s1', '干活');
  await sleep(20);
  assert.equal(host.isBusy('s1'), true);
  // External modes use the native contract even for old sessions.
  const res = await host.setMode('s1', 'ask');
  assert.equal(res.ok, false, 'busy 中重建连接类切档被拒绝');
  assert.equal(host.getMode('s1'), 'default', '外部 Harness 的回执保持默认投影');
  assert.equal(ctx.__sessionsDb.get('s1').guiMode, undefined, '持久层未被写过（重启后不会静默切档）');
  // 收口
  await host.abort('s1');
  state.resolveConnect();
  await sendP;
  await sleep(60);
}

async function testNativePendingSettings() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-native-config-'));
  const { driver, state } = makeFakeDriver('codex-gui');
  const original = driver.connect.bind(driver);
  const calls = [];
  let queued;
  const native = { status: 'ready', options: [{ id: 'mode', name: 'Mode', type: 'select', changePolicy: 'idle', currentValue: 'build',
    choices: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
    { id: 'review', name: 'Review', type: 'boolean', changePolicy: 'idle', currentValue: true }] };
  driver.connect = async input => Object.assign(await original(input), {
    getNativeConfig: () => native,
    async setNativeConfig(id, value) {
      calls.push([id, value]);
      if (id === 'mode') queued = native.options[0].currentValue === value ? undefined : value;
    }
  });
  const { host, ctx } = makeHost(tmp);
  ctx.sessions.get = id => {
    const row = ctx.sessions.peek(id);
    return row && { ...row };
  };
  host.registerDriver(driver);
  const row = session('s1', { runtime: 'codex-gui', guiMode: 'auto', configurePermissions: true });
  openExecution(host, row);
  const refresh = host.refreshNativeConfig('s1');
  for (let i = 0; !state.resolveConnect && i < 20; i++) await sleep(5);
  state.resolveConnect();
  const first = await refresh;
  assert.equal(first.options[0].currentValue, 'build');
  row.nativePermissionRestore = { identity: first.identity, selections: [{ id: 'mode', value: 'build' }] };
  const set = (snapshot, id, value) => host.setNativeConfig('s1', { identity: snapshot.identity, revision: snapshot.revision, id, value });
  const plan = await set(first, 'mode', 'plan');
  assert.equal(plan.pending, true);
  assert.equal(queued, 'plan');
  assert.deepEqual(row.nativePermissionRestore.selections, [{ id: 'mode', value: 'plan' }]);
  assert.equal((await set(first, 'review', false)).ok, false, 'stale revisions are rejected');
  const review = await set(plan.snapshot, 'review', false);
  assert.deepEqual(review.snapshot.requested, [{ id: 'mode', value: 'plan' }, { id: 'review', value: false }]);
  const withdraw = await set(review.snapshot, 'mode', 'build');
  assert.deepEqual(withdraw.snapshot.requested, [{ id: 'review', value: false }]);
  assert.equal(queued, undefined);
  assert.equal(row.nativePermissionRestore, undefined);
  assert.deepEqual(calls, [['mode', 'plan'], ['review', false], ['mode', 'build']]);
  await host.close('s1');
}

async function testSetModelThreeStates() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));

  const idle = await host.setSessionModel('s1', { providerId: 'p1', modelId: 'm2' });
  assert.equal(idle.ok, true);
  assert.equal(idle.applied, 'immediate');
  assert.equal(ctx.__sessionsDb.get('s1').modelOverride.modelId, 'm2');

  const sendP = host.send('s1', '干活');
  await sleep(20);
  assert.equal(host.isBusy('s1'), true);
  const mid = await host.setSessionModel('s1', { providerId: 'p1', modelId: 'm3' });
  assert.equal(mid.ok, true, '运行中应接下回合生效而不是拒绝');
  assert.equal(mid.applied, 'next-turn');
  assert.equal(ctx.__sessionsDb.get('s1').modelOverride.modelId, 'm3');

  driver.runtimeId = 'claude';
  openExecution(host, session('s2', { runtime: 'claude' }));
  ctx.__sessionsDb.set('s2', session('s2', { runtime: 'claude' }));
  const denied = await host.setSessionModel('s2', { providerId: 'x', modelId: 'y' });
  assert.equal(denied.ok, false, '快照型不支持会话级模型时应拒绝');
  ctx.__sessionsDb.set('codex-closed', session('codex-closed', { runtime: 'codex-gui' }));
  const codex = await host.setSessionModel('codex-closed', { providerId: 'codex-gui', modelId: 'chosen' });
  assert.equal(codex.ok, true, 'Codex 未打开也可保存模型覆盖');
  assert.equal(ctx.__sessionsDb.get('codex-closed').modelOverride.modelId, 'chosen');
  assert.equal((await host.setSessionModel('codex-closed', null)).ok, true);
  assert.equal(ctx.__sessionsDb.get('codex-closed').modelOverride, undefined, '清除恢复 CLI 默认');

  await host.abort('s1');
  state.resolveConnect();
  await sendP;
  await sleep(40);
}

async function testPiProviderConfigurationLifecycle(race = false) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-provider-config-'));
  const skills = race === 'skill' ? makeSkillDir() : null;
  let releaseSkill;
  if (skills) piStub = { agentDir: tmp, gate: null,
    skills: [{ name: 'demo', description: 'demo', filePath: skills.filePath, baseDir: skills.cwd }] };
  const provider = { id: 'p1', name: 'Provider', api: 'openai-completions',
    baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', enabled: true,
    compat: { supportsDeveloperRole: false },
    models: [{ id: 'm1', name: 'Selected', reasoning: true, contextWindow: 64000, maxTokens: 8000 },
      { id: 'm2', name: 'Unselected', contextWindow: 64000 }] };
  const other = { id: 'other', name: 'Other', apiKey: 'other-fixture', baseUrl: 'https://other.invalid/v1',
    enabled: true, models: [{ id: 'other-model' }] };
  const llm = { activeProviderId: 'p1', activeModelId: 'm1', providers: [provider, other] };
  const { host, ctx } = makeHost(tmp, { llm, guiTurnRetry: { enabled: false } });
  const { driver, state } = makeFakeDriver();
  const configurations = [];
  const connect = driver.connect.bind(driver);
  driver.connect = input => { configurations.push(structuredClone(ctx.config.get().llm)); return connect(input); };
  host.registerDriver(driver);
  const meta = session('provider-config', skills ? { cwd: skills.cwd } : {});
  openExecution(host, meta);
  const finish = async () => {
    state.queue.push({ type: 'text-delta', delta: 'completed' });
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('provider fixture finishes its turn', () => !host.isBusy(meta.id));
  };
  const send = async (expectedConnections, label) => {
    const sent = state.sends.length;
    const before = state.connects;
    const pending = host.send(meta.id, label);
    if (expectedConnections > before) {
      await waitUntil(`${label} connection`, () => state.connects === expectedConnections);
      state.resolveConnect();
    }
    await pending;
    await waitUntil(`${label} dispatch`, () => state.sends.length === sent + 1);
    assert.equal(state.connects, expectedConnections, label);
  };
  try {
    if (skills) {
      const { invalidateAgentSkills } = require(path.join(root, 'src/main/agent/skillsList.ts'));
      const pending = host.send(meta.id, '/skill:demo dispatch after skill preparation');
      await waitUntil('provider connection is ready to resolve', () => state.connects === 1);
      let preparingSkill = false;
      const gate = new Promise(resolve => { releaseSkill = resolve; });
      invalidateAgentSkills();
      piStub.gate = { promise: { then(resolve, reject) { preparingSkill = true; return gate.then(resolve, reject); } } };
      state.resolveConnect();
      await waitUntil('skill preparation waits after connection', () => preparingSkill);
      assert.ok(host.entries.get(meta.id).connection, 'the connection is already accepted before this race');
      assert.equal(state.connects, 1);
      assert.equal(state.closes, 0);
      assert.equal(state.sends.length, 0, 'skill preparation still precedes engine dispatch');
      provider.compat.supportsDeveloperRole = true;
      piStub.gate = null;
      releaseSkill();
      await pending;
      await waitUntil('stale configuration blocks prepared input', () => !host.isBusy(meta.id));
      assert.equal(state.sends.length, 0, 'configuration must be rechecked after skill preparation, immediately before dispatch');
      assert.ok(host.getHistory(meta.id).messages.some(message => /模型连接配置在准备期间变化/.test(message.error ?? '')));
      await send(2, 'retry after preparation race');
      assert.equal(configurations[1].providers[0].compat.supportsDeveloperRole, true);
      await finish();
      return;
    }
    if (race) {
      const pending = host.send(meta.id, 'connect with captured compatibility');
      await waitUntil('first provider connection waits', () => state.connects === 1);
      provider.compat.supportsDeveloperRole = true;
      state.resolveConnect();
      await pending;
      await waitUntil('stale provider connection is retired', () => state.closes === 1 && !host.isBusy(meta.id));
      assert.equal(state.sends.length, 0, 'a late connection with old compatibility must never receive a turn');
      assert.equal(host.entries.get(meta.id).connection, null);
      assert.ok(host.getHistory(meta.id).messages.some(message => /模型连接配置在准备期间变化/.test(message.error ?? '')),
        'configuration race is an explicit retryable failure');
      assert.equal(configurations[0].providers[0].compat.supportsDeveloperRole, false);
      await send(2, 'retry with latest compatibility');
      assert.equal(configurations[1].providers[0].compat.supportsDeveloperRole, true);
      await finish();
      return;
    }

    await send(1, 'initial provider configuration');
    await finish();
    for (const [label, mutate] of [
      ['provider display name', () => { provider.name = 'Renamed provider'; }],
      ['model display name', () => { provider.models[0].name = 'Renamed selected model'; }],
      ['unselected provider', () => { other.apiKey = 'changed-other-fixture'; }],
      ['unselected model', () => { provider.models[1].contextWindow = 32000; }]
    ]) {
      mutate();
      await send(1, `${label} does not reconnect`);
      await finish();
    }
    provider.compat.supportsDeveloperRole = true;
    await send(2, 'same provider/model IDs apply new compatibility');
    const activeConnection = host.entries.get(meta.id).connection;
    const closesBefore = state.closes;
    provider.apiKey = 'replacement-fixture-key';
    await sleep(20);
    assert.equal(state.aborts, 0, 'editing provider settings does not interrupt the running turn');
    assert.equal(state.closes, closesBefore);
    assert.equal(host.entries.get(meta.id).connection, activeConnection);
    await finish();
    await send(3, 'credential update applies at the next turn');
    await finish();
    let expectedConnections = 3;
    for (const [label, mutate] of [
      ['API protocol', () => { provider.api = 'openai-responses'; }],
      ['endpoint', () => { provider.baseUrl = 'https://changed.invalid/v1'; }],
      ['thinking mapping', () => { provider.thinking = { reasoningEffortField: false }; }],
      ['selected model configuration', () => { provider.models[0].contextWindow = 128000; }],
      ['compatibility restored', () => { provider.compat.supportsDeveloperRole = false; }]
    ]) {
      mutate();
      await send(++expectedConnections, `${label} rebuilds the selected connection`);
      await finish();
    }
  } finally {
    releaseSkill?.();
    if (skills) piStub = null;
    await host.close(meta.id);
    host.flushPersist();
    assert.equal(path.dirname(tmp), os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
    if (skills) {
      assert.equal(path.dirname(skills.cwd), os.tmpdir());
      fs.rmSync(skills.cwd, { recursive: true, force: true });
    }
  }
}

const FAST_RETRY = { guiTurnRetry: { enabled: true, maxRetries: 2, baseDelayMs: 100, maxDelayMs: 100 } };

/** 造一个带 SKILL.md 的临时 cwd（skill 展开单测用；桩按 cwd 缓存隔离） */
function makeSkillDir(name = 'demo') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-cwd-'));
  const filePath = path.join(cwd, 'SKILL.md');
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: demo skill\n---\nDEMO_SKILL_BODY 先读文档再动手`,
    'utf8'
  );
  return { cwd, filePath };
}

async function testResendSendsExpandedSkillPayload() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { cwd, filePath } = makeSkillDir();
  piStub = {
    agentDir: tmp,
    gate: null,
    skills: [{ name: 'demo', description: 'demo', filePath, baseDir: cwd }]
  };
  try {
    const { driver, state } = makeFakeDriver();
    const { host, ctx } = makeHost(tmp, FAST_RETRY);
    host.registerDriver(driver);
    openExecution(host, session('s1', { cwd }));
    ctx.__sessionsDb.set('s1', session('s1', { cwd }));
    const sendP = host.send('s1', '/skill:demo 干活');
    await sleep(20);
    state.resolveConnect();
    await sendP;
    await waitUntil('initial skill resend test send', () => state.sends.length === 1);
    // 前置：首发已展开（/skill: 前缀 → <skill> 块），证明桩与展开路径生效
    assert.match(state.sends[0], /<skill name="demo"/, '首发即应带展开后的 skill 块');
    assert.doesNotMatch(state.sends[0], /\/skill:demo/);
    assert.equal(state.authorities[0]?.userText, '/skill:demo 干活', '技能正文不能混入记忆授权原文');
    // 首发即败（引擎从未收到）→ 网络续作重发
    state.queue.push({ type: 'error', message: 'read ECONNRESET' });
    await sleep(40);
    assert.equal(host.isBusy('s1'), true);
    await sleep(180);
    await waitUntil('skill network resend', () => state.sends.length === 2);
    assert.equal(state.sends.length, 2, '退避后重发');
    assert.equal(state.authorities[1]?.userText, '/skill:demo 干活', '重发保留原始授权，不使用展开后的 payload');
    assert.equal(
      state.sends[1],
      state.sends[0],
      '重发必须是 startTurn 存档的最终 payload（展开后的 skill 文本），不得重放 /skill: 原文'
    );
    state.queue.push({ type: 'turn-complete' });
    await sleep(40);
    assert.equal(host.isBusy('s1'), false);
  } finally {
    piStub = null;
  }
}

async function testSteerFallsBackWhenTurnClosesDuringExpand() {
  const { invalidateAgentSkills } = require(path.join(root, 'src/main/agent/skillsList.ts'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { cwd, filePath } = makeSkillDir();
  let releaseExpand;
  const gate = new Promise((r) => {
    releaseExpand = r;
  });
  piStub = {
    agentDir: tmp,
    gate: null,
    skills: [{ name: 'demo', description: 'demo', filePath, baseDir: cwd }]
  };
  try {
    const { driver, state } = makeFakeDriver();
    const { host, ctx } = makeHost(tmp);
    host.registerDriver(driver);
    openExecution(host, session('s1', { cwd }));
    ctx.__sessionsDb.set('s1', session('s1', { cwd }));
    const firstP = host.send('s1', 'first');
    await sleep(20);
    state.resolveConnect();
    await firstP;
    await sleep(30);
    assert.equal(host.isBusy('s1'), true);
    state.redirectReturns = true;
    // busy steer：卡进 expandSkillText 的 await 窗口（gate 挂起）
    invalidateAgentSkills();
    piStub.gate = { promise: gate };
    const steerP = host.send('s1', '/skill:demo 插话');
    await sleep(30);
    // await 期间回合收口
    state.queue.push({ type: 'turn-complete' });
    await sleep(80);
    assert.equal(host.isBusy('s1'), false, '回合已收口');
    piStub.gate = null;
    releaseExpand();
    const r = await steerP;
    assert.equal(r.steered, undefined, '回合已收口不得再 redirect（插话会落错回合）');
    assert.equal(r.queued, undefined, '也不得入队：应按空闲消息开新回合');
    assert.equal(state.redirects.length, 0, 'redirect 未被调用');
    await sleep(30); // startTurn 是 fire-and-forget：等它把插话发进引擎
    assert.equal(state.sends.length, 2, '插话按新回合发进引擎');
    assert.match(state.sends[1], /<skill name="demo"/, '新回合 startTurn 重新展开 skill');
    assert.equal(host.isBusy('s1'), true, '插话开了新回合');
    await host.abort('s1');
    await sleep(40);
  } finally {
    piStub = null;
  }
}

async function testCompactionEnvelopeAndPush() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const pushes = [];
  host.onPush((p) => {
    if (p.kind === 'compaction') pushes.push(p);
  });
  const sendP = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);

  // 引擎压缩事件 → running/complete 推送 + 信封落一条
  state.queue.push({ type: 'compaction', phase: 'start' });
  await sleep(20);
  state.queue.push({ type: 'compaction', phase: 'end' });
  await sleep(20);
  let hist = host.getHistory('s1');
  assert.equal(hist.compactions.length, 1, '压缩完成落信封');
  assert.equal(pushes.length, 2, 'running + complete 两条推送');
  assert.equal(pushes[0].status, 'running');
  assert.equal(pushes[1].status, 'complete');
  assert.equal(pushes[1].markerId, pushes[0].markerId, '同一标记 id 认领');

  // 重复 start（并发保护）与 willRetry 保持打开
  state.queue.push({ type: 'compaction', phase: 'start' });
  state.queue.push({ type: 'compaction', phase: 'start' });
  await sleep(20);
  state.queue.push({ type: 'compaction', phase: 'end', willRetry: true });
  await sleep(20);
  hist = host.getHistory('s1');
  assert.equal(hist.compactions.length, 1, 'willRetry 不收口');
  state.queue.push({ type: 'compaction', phase: 'end' });
  await sleep(20);
  assert.equal(host.getHistory('s1').compactions.length, 2, '重试后收口');

  // 失败收口：摘线不落信封
  state.queue.push({ type: 'compaction', phase: 'start' });
  await sleep(20);
  state.queue.push({ type: 'compaction', phase: 'end', errorMessage: '摘要失败' });
  await sleep(20);
  assert.equal(host.getHistory('s1').compactions.length, 2, '失败不进信封');
  const last = pushes.at(-1);
  assert.equal(last.status, 'error', '失败推 error（渲染层摘线）');

  // 落盘可恢复
  host.store.flushSync();
  openExecution(host, session('s2'));
  const reopened = host.getHistory('s1');
  assert.equal(reopened.compactions.length, 2, '信封随消息文件持久化');
}

async function testNetworkErrorRetriesThenContinues() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp, FAST_RETRY);
  const pushes = [];
  host.onPush((p) => pushes.push(p));
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await waitUntil('initial network test send', () => state.sends.length === 1);
  state.queue.push({ type: 'error', message: '[unknown] [aborted] read ECONNRESET' });
  await sleep(40);
  assert.equal(host.isBusy('s1'), true, '网络错误不得立刻收口');
  const mid = host.getHistory('s1').messages.at(-1);
  assert.match(mid.retryHint ?? '', /续作/, '应提示自动续作');
  assert.equal(host.observe('s1').busy, true);
  assert.match(host.observe('s1').retry.message, /续作/);
  assert.equal(
    pushes.some((p) => p.kind === 'busy' && p.busy === false),
    false,
    '续作等待期不得推 busy:false（否则调度会当成正常回合结束）'
  );
  await sleep(160);
  await waitUntil('network resend', () => state.sends.length === 2);
  assert.equal(state.sends.length, 2, '退避后重发原用户消息（尚无进度）');
  assert.equal(state.sends[1], '干活');
  // 续作成功 = 引擎有产出并正常收口（空收口属空转，由空转守卫另测）
  state.queue.push({ type: 'text-delta', delta: '续上了' });
  await sleep(20);
  state.queue.push({ type: 'turn-complete' });
  await sleep(40);
  assert.equal(host.isBusy('s1'), false);
  const done = host.getHistory('s1').messages.at(-1);
  assert.equal(done.error, undefined, '续作成功后错误应清除');
  assert.equal(done.retryHint, undefined);
  assert.equal(host.observe('s1').retry, null, '收口后清除恢复中的提示');
  assert.equal(host.observe('s1').lastReply.status, 'completed');
  assert.equal(host.observe('s1').lastReply.retryAttempts, 1, '保留成功恢复事实，不能只看到先失败后成功');
}

async function testNetworkErrorContinueAfterProgress() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp, FAST_RETRY);
  const desktopEvents = [];
  ctx.desktopTurns = () => ({
    begin(owner, turnId, current, userInstruction) { desktopEvents.push({ kind: 'begin', owner, turnId, current, userInstruction }); },
    end(owner, turnId) { desktopEvents.push({ kind: 'end', owner, turnId }); }
  });
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  assert.equal(desktopEvents.length, 1);
  assert.equal(desktopEvents[0].userInstruction, true);
  assert.equal(desktopEvents[0].current(), true);
  state.queue.push({ type: 'text-delta', delta: '已经写了一半' });
  await sleep(20);
  state.queue.push({ type: 'error', message: 'read ECONNRESET' });
  await sleep(40);
  assert.equal(desktopEvents.length, 1, '可重试错误不得提前结束桌面回合');
  await sleep(160);
  assert.equal(state.sends.length, 2);
  assert.match(state.sends[1], /^<muster_host_context source="automatic">\n.*网络中断.*\n<\/muster_host_context>$/, '续作提示属于宿主上下文');
  state.queue.push({ type: 'turn-complete' });
  await sleep(40);
  assert.deepEqual(desktopEvents[1], { kind: 'end', owner: 's1', turnId: desktopEvents[0].turnId });
  assert.equal(desktopEvents[0].current(), false);
  await host.send('s1', '后台续接', undefined, { host: true });
  await sleep(30);
  assert.equal(desktopEvents[2].kind, 'begin');
  assert.equal(desktopEvents[2].userInstruction, false, '宿主消息不能恢复用户停止的桌面会话');
  state.queue.push({ type: 'turn-complete' });
  await sleep(40);
  assert.equal(desktopEvents[3].turnId, desktopEvents[2].turnId);
}

async function testNetworkErrorExhaustReportsOutcome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp, { guiTurnRetry: { enabled: true, maxRetries: 1, baseDelayMs: 100, maxDelayMs: 100 } });
  const pushes = [];
  host.onPush((p) => pushes.push(p));
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  state.queue.push({ type: 'error', message: 'read ECONNRESET' });
  await sleep(50);
  assert.equal(host.isBusy('s1'), true);
  await sleep(160);
  assert.equal(state.sends.length, 2, '第一次失败后续作一次');
  state.queue.push({ type: 'error', message: 'read ECONNRESET' });
  await sleep(50);
  assert.equal(host.isBusy('s1'), false, '用尽后续作必须收口');
  const busyFalse = pushes.filter((p) => p.kind === 'busy' && p.busy === false);
  assert.equal(busyFalse.length, 1);
  assert.equal(busyFalse[0].outcome, 'network_error');
  assert.match(busyFalse[0].error ?? '', /ECONNRESET/);
  assert.equal(busyFalse[0].retryAttempts, 1);
  const last = host.getHistory('s1').messages.at(-1);
  assert.match(last.error ?? '', /ECONNRESET/);
}

async function testUserAbortDoesNotRetryNetworkError() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp, FAST_RETRY);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  state.queue.push({ type: 'error', message: 'read ECONNRESET' });
  await sleep(20);
  assert.equal(host.isBusy('s1'), true);
  await host.abort('s1');
  await sleep(140);
  assert.equal(state.sends.length, 1, '用户停止后不得再续作');
  assert.equal(host.isBusy('s1'), false);
  const last = host.getHistory('s1').messages.at(-1);
  assert.equal(last.aborted, true);
}

const GLM_ONLY_LLM = {
  llm: {
    providers: [
      {
        id: 'zhipu',
        name: 'Zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'sk-test',
        models: [{ id: 'glm-5.3', name: 'GLM-5.3', multimodal: false, multimodalExplicit: true }],
        enabled: true
      }
    ],
    activeProviderId: 'zhipu',
    activeModelId: 'glm-5.3'
  }
};

const MIXED_LLM = {
  llm: {
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        models: [{ id: 'gpt-4o', name: 'GPT-4o', multimodal: true }],
        enabled: true
      },
      {
        id: 'zhipu',
        name: 'Zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'sk-test',
        models: [{ id: 'glm-5.3', name: 'GLM-5.3', multimodal: false, multimodalExplicit: true }],
        enabled: true
      }
    ],
    activeProviderId: 'openai',
    activeModelId: 'gpt-4o'
  }
};

async function testRejectImagesWhenModelLacksSupport() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  driver.supportsImages = true;
  const { host, ctx } = makeHost(tmp, GLM_ONLY_LLM);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const r = await host.send('s1', '看图', [
    { data: 'AAAA', mimeType: 'image/png', name: 'shot.png' }
  ]);
  assert.equal(r.ok, false, '非多模态模型带图必须拒绝');
  assert.match(r.error ?? '', /GLM-5\.3/);
  assert.match(r.error ?? '', /不支持图片输入/);
  assert.equal(state.sends.length, 0, '拒绝时不得把图交给引擎');
  assert.equal(host.getHistory('s1').messages.length, 0, '拒绝时消息不得入历史');
}

/** 行内编辑只改文本，随文图片必须保留（丢图=改错别字丢附件） */
async function testEditQueuedPreservesImages() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  driver.supportsImages = true;
  const { host, ctx } = makeHost(tmp, {
    llm: {
      providers: [
        { id: 'p1', baseUrl: 'https://example.test/v1', apiKey: 'fixture', models: [{ id: 'gpt-4o', multimodal: true }], enabled: true }
      ],
      activeProviderId: 'p1',
      activeModelId: 'gpt-4o'
    }
  });
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));

  const p1 = host.send('s1', '第一条');
  await sleep(20);
  const imgs = [{ data: 'AAAA', mimeType: 'image/png', name: 'shot.png' }];
  const queued = await host.send('s1', '看图', imgs);
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true, 'busy 中带图入队');
  state.resolveConnect();
  await p1;
  await sleep(30);

  const hist = host.getHistory('s1');
  const qmsg = hist.messages.find((m) => m.queued);
  assert.ok(qmsg, '排队消息在历史里');
  assert.equal(qmsg.images?.length, 1, '入队时带图');

  assert.equal(host.editQueued('s1', qmsg.id, '看图（改）'), true);
  const edited = host.getHistory('s1').messages.find((m) => m.id === qmsg.id);
  assert.equal(edited.parts[0].text, '看图（改）', '文本改写生效');
  assert.equal(edited.images?.length, 1, '行内编辑保留随文图片');

  // 第一回合收口 → 出队派发必须带图
  state.queue.push({ type: 'turn-complete' });
  await sleep(80);
  assert.equal(state.sends.at(-1), '看图（改）', '出队文本为编辑后内容');
  assert.equal(state.sentImages.at(-1)?.images?.length, 1, '出队派发带上图片');
  assert.equal(state.sentImages.at(-1)?.text, '看图（改）');
}

async function testRejectImagesWhenOverrideLacksSupport() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  driver.supportsImages = true;
  const { host, ctx } = makeHost(tmp, MIXED_LLM);
  host.registerDriver(driver);
  openExecution(host, session('s1', { modelOverride: { providerId: 'zhipu', modelId: 'glm-5.3' } }));
  ctx.__sessionsDb.set(
    's1',
    session('s1', { modelOverride: { providerId: 'zhipu', modelId: 'glm-5.3' } })
  );
  const r = await host.send('s1', '看图', [{ data: 'AAAA', mimeType: 'image/png' }]);
  assert.equal(r.ok, false, '全局多模态、会话覆盖非多模态时仍须拒绝');
  assert.match(r.error ?? '', /GLM-5\.3/);
  assert.match(r.error ?? '', /不支持图片输入/);
  assert.equal(state.sends.length, 0);
}

/** 出错后点重试：复用原用户消息、替换失败 assistant，不得再追加一条用户副本。 */
async function testManualRetryReusesUserMessage() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));

  const sendP = host.send('s1', '同一句消息');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  state.queue.push({
    type: 'error',
    message: 'AI Model Not Found: Invalid parameters for registry model: grok-4.7'
  });
  await sleep(40);
  assert.equal(host.isBusy('s1'), false);
  const before = host.getHistory('s1').messages;
  assert.equal(before.filter((m) => m.role === 'user').length, 1);
  assert.match(before.at(-1).error ?? '', /AI Model Not Found/);

  const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const empty = makeHost(emptyTmp);
  empty.host.registerDriver(makeFakeDriver().driver);
  openExecution(empty.host, session('s2'));
  empty.ctx.__sessionsDb.set('s2', session('s2'));
  const noFail = empty.host.retry('s2');
  assert.equal(noFail.ok, false);
  assert.match(noFail.error ?? '', /没有可重试/);

  const r = host.retry('s1');
  assert.equal(r.ok, true);
  await sleep(40);
  assert.equal(state.sends.length, 2);
  assert.equal(state.sends[1], '同一句消息');
  const after = host.getHistory('s1').messages;
  assert.equal(after.filter((m) => m.role === 'user').length, 1, '重试不得追加用户消息副本');
  assert.equal(after.filter((m) => m.role === 'assistant').length, 1, '失败 assistant 被替换');
  assert.equal(after[0].role, 'user');
  assert.equal(after[1].role, 'assistant');
  assert.equal(after[1].error, undefined, '新 assistant 尚未失败');

  // 忙时再点重试必须拒绝（否则会叠第二条用户消息）
  const busy = host.retry('s1');
  assert.equal(busy.ok, false);
  assert.match(busy.error ?? '', /正忙/);
  assert.equal(host.getHistory('s1').messages.filter((m) => m.role === 'user').length, 1);

  state.queue.push({
    type: 'error',
    message: 'AI Model Not Found: Invalid parameters for registry model: grok-4.7'
  });
  await sleep(40);
  host.retry('s1');
  await sleep(40);
  const again = host.getHistory('s1').messages;
  assert.equal(again.filter((m) => m.role === 'user').length, 1, '连续重试仍只有一条用户消息');
  assert.equal(again.filter((m) => m.role === 'assistant').length, 1);
}

async function testRecallAbortedRemovesTurnAndReturnsDraft() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  driver.supportsImages = true;
  const { host, ctx } = makeHost(tmp, {
    llm: {
      providers: [
        { id: 'p1', baseUrl: 'https://example.test/v1', apiKey: 'fixture', models: [{ id: 'gpt-4o', multimodal: true }], enabled: true }
      ],
      activeProviderId: 'p1',
      activeModelId: 'gpt-4o'
    }
  });
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));

  // 第一轮正常完成
  const sendP1 = host.send('s1', '第一轮保留');
  await sleep(20);
  state.resolveConnect();
  await sendP1;
  await sleep(20);
  state.queue.push({ type: 'text-delta', delta: '第一轮答复' });
  await sleep(10);
  state.queue.push({ type: 'turn-complete' });
  await sleep(30);

  // 非终止状态下调用 recallAborted 应被拒绝
  const notAborted = host.recallAborted('s1');
  assert.equal(notAborted.ok, false);
  assert.match(notAborted.error ?? '', /没有可重新编辑/);

  // 第二轮带图片发送后手动 abort
  const sendRes2 = await host.send('s1', '第二轮需要重新编辑', [
    { data: 'BBBB', mimeType: 'image/png', name: 'cap.png' }
  ]);
  assert.equal(sendRes2.ok, true);
  await sleep(30);
  state.queue.push({ type: 'text-delta', delta: '半截内容' });
  await sleep(10);
  await host.abort('s1');
  state.queue.push({ type: 'turn-complete' });
  await sleep(30);

  const msgsBefore = host.getHistory('s1').messages;
  assert.equal(msgsBefore.length, 4);
  assert.equal(msgsBefore[3].aborted, true);

  // 传入第一轮的 messageId 应拒绝（只能撤回末轮已终止回合）
  const wrongId = host.recallAborted('s1', msgsBefore[0].id);
  assert.equal(wrongId.ok, false);

  // 传入第二轮用户 messageId：成功撤回第二轮并返回原文本+图片，第一轮完好保留
  const recalled = host.recallAborted('s1', msgsBefore[2].id);
  assert.equal(recalled.ok, true);
  assert.equal(recalled.text, '第二轮需要重新编辑');
  assert.equal(recalled.images?.length, 1);
  assert.equal(recalled.images?.[0]?.name, 'cap.png');
  assert.equal(recalled.images?.[0]?.data, 'BBBB');

  const msgsAfter = host.getHistory('s1').messages;
  assert.equal(msgsAfter.length, 2, '已终止的第二轮用户与助手消息一并移除');
  assert.equal(msgsAfter[0].id, msgsBefore[0].id);
  assert.equal(msgsAfter[1].id, msgsBefore[1].id);
}

async function testTurnCompleteSummaryStampsHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  state.queue.push({ type: 'text-delta', delta: '结果' });
  await sleep(20);
  // turn-complete 携带 summary（pi driver 计量状态机组装）→ 盖到 assistant.harness
  state.queue.push({
    type: 'turn-complete',
    summary: {
      usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 7 },
      model: 'glm-5',
      durationMs: 4200,
      calls: [
        { usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 7 }, ttftMs: 120, durationMs: 4100, model: 'glm-5' }
      ]
    }
  });
  await sleep(40);
  const hist = host.getHistory('s1');
  const assistant = hist.messages.at(-1);
  assert.equal(assistant.role, 'assistant');
  assert.ok(assistant.harness, 'summary 盖到 assistant.harness');
  assert.equal(assistant.harness.model, 'glm-5');
  assert.equal(assistant.harness.usage.inputTokens, 100);
  assert.equal(assistant.harness.calls.length, 1);
  assert.equal(host.isBusy('s1'), false, '回合已收口');
  // 落盘可恢复（重启后透明标注数据仍在转写 json）
  host.store.flushSync();
  const store = new GuiSessionStore(tmp);
  const loaded = store.load('s1');
  const persisted = loaded.find((m) => m.role === 'assistant');
  assert.ok(persisted?.harness, 'harness 随消息落盘');
  assert.equal(persisted.harness.usage.reasoningTokens, 7);
}

async function testHostIntroOnlyOnFirstNativeTurn() {
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-host-intro-'));
  const { formatGuiHostContext } = require(path.join(root, 'src/main/agentSession/prompt.ts'));
  const { driver, state } = makeFakeDriver();
  let row = session('host-intro', { runtimeResumeToken: 'same-native-thread' });
  let { host } = makeHost(tmp, { guiTurnRetry: { enabled: false } });
  const open = () => {
    host.registerDriver(driver);
    openExecution(host, row);
  };
  const reopen = async () => {
    await host.close(row.id);
    host.flushPersist();
    ({ host } = makeHost(tmp, { guiTurnRetry: { enabled: false } }));
    open();
  };
  const send = async (text, includeIntro, event, submitIntro = includeIntro) => {
    const previousSends = state.sends.length;
    const previousConnections = state.connects;
    assert.equal((await host.send(row.id, text)).ok, true);
    await waitUntil('new host connection', () => state.connects > previousConnections);
    state.resolveConnect();
    await waitUntil('host input submitted', () => state.sends.length === previousSends + 1);
    const { firstPromptPrefix } = state.inputs.at(-1);
    assert.equal(Boolean(firstPromptPrefix), includeIntro, text);
    if (includeIntro) assert.match(firstPromptPrefix, /^Muster Console opens or resumes your Harness session\./);
    const submitted = submitIntro ? `${text}\n\n${formatGuiHostContext(firstPromptPrefix)}` : text;
    state.queue.push({ type: 'engine-input', identity: state.authorities.at(-1).forkIdentity, text: submitted });
    if (event.type === 'turn-complete') state.queue.push({ type: 'text-delta', delta: 'received' });
    state.queue.push(event);
    await waitUntil('host turn settled', () => !host.isBusy(row.id));
    state.queue.closed = true;
    await waitUntil('host connection retired', () => !host.entries.get(row.id).connection);
  };
  try {
    open();
    await send('first submission fails before native acceptance', true, { type: 'error', message: 'rejected before model start' });
    await send('/native-command', true, { type: 'turn-complete' }, false);
    await reopen();
    await send('first ordinary input succeeds', true, { type: 'turn-complete' });
    await send('reconnect with the same native conversation', false, { type: 'turn-complete' });
    await reopen();
    await send('cold reopen of the same native conversation', false, { type: 'turn-complete' });
    assert.equal(state.inputs.at(-1).resumeToken, 'same-native-thread');
    await host.clear(row.id);
    await send('first input after clear', true, { type: 'turn-complete' });
    assert.equal(state.inputs.at(-1).resumeToken, undefined);
    await host.close(row.id);
    row = session('legacy-host-intro', { runtimeResumeToken: 'legacy-native-thread' });
    host.store.save(row.id, [
      { id: 'legacy-user', role: 'user', ts: 1, parts: [{ kind: 'text', text: 'Earlier question' }] },
      { id: 'legacy-assistant', role: 'assistant', ts: 2, parts: [{ kind: 'text', text: 'Earlier answer' }] }
    ]);
    openExecution(host, row);
    await send('continue a session saved before delivery receipts existed', false, { type: 'turn-complete' });
  } finally {
    await host.close(row.id);
    host.flushPersist();
    removeDesktopFixture(tmp, 'gui-host-intro-');
  }
}

async function testInjectionSnapshotEnvelope() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const injPushes = [];
  host.onPush((p) => {
    if (p.kind === 'injections') injPushes.push(p);
  });
  const sendP = host.send('s1', '第一条');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(40);

  // 连接级注入快照入信封：政策层分段（pi 记忆段不再连接时预记——逐轮钩子报到）+ 引擎真身
  const hist1 = host.getHistory('s1');
  assert.equal(hist1.injections.length, 1, 'connect 物化时记录注入快照');
  assert.match(state.inputs[0].firstPromptPrefix, /Your session ID in Muster is s1\./, 'Pi receives host context through the first input');
  assert.doesNotMatch(state.inputs[0].systemPromptAppend, /Muster Console opens or resumes/, 'host context is absent from the recurring system prompt');
  assert.deepEqual(hist1.messages.find(m => m.role === 'user').parts, [{ kind: 'text', text: '第一条' }], 'transcript keeps the original user text');
  assert.equal(injPushes.length, 1, '快照落信封时推送 injections（活跃会话即时更新标注）');
  assert.equal(injPushes[0].injection.kind, 'summary');
  assert.equal('text' in injPushes[0].injection.segments[0], false, 'live metadata does not republish old/full prompt text');
  assert.equal(host.injectionDetails('s1', injPushes[0].injection.details).ok, true, 'expanded details use the real host single-record path');
  const snap = hist1.injections[0];
  assert.ok(snap.at > 0);
  assert.equal(snap.segments.length, 1, '无 persona/记忆时只有政策层一段');
  assert.equal(snap.segments[0].source, '政策层（材料化）');
  assert.ok(snap.segments[0].text.includes('You are the Worker for this chat.'), '快照含材料化基底全文');
  assert.equal(snap.segments[0].chars, snap.segments[0].text.length);
  assert.match(snap.segments[0].hash, /^[0-9a-f]{8}$/, 'FNV-1a 指纹');
  // 引擎真身合并进代际（conn.engineCapture → 信封）
  assert.equal(snap.enginePrompt.hash, 'cccc3333', '引擎系统提示词真身入代际');
  assert.equal(snap.tools.length, 1, '工具目录入代际');
  assert.equal(snap.tools[0].name, 'read');
  assert.deepEqual(snap.tools[0].params, ['path: string*']);

  // 逐轮注入变化（injection-update，pi modeHooks 首轮报到）在回合进行中到达：
  // modeHooks 的 before_agent_start 在引擎开跑时触发，此刻回合仍 busy
  const firstTurnUserTs = hist1.messages.find((m) => m.role === 'user').ts;
  state.queue.push({ type: 'injection-update', source: '记忆段', text: '工作区记忆（逐轮快照）全文' });
  await sleep(30);
  state.queue.push({ type: 'turn-complete' });
  await sleep(30);

  // injection-update 落新代际（基底 + 逐轮记忆段；引擎真身原样继承）
  assert.equal(host.getHistory('s1').injections.length, 2, 'injection-update 追加新代际');
  assert.equal(injPushes.length, 2, '逐轮代际也推送 injections');
  const gen2 = host.getHistory('s1').injections[1];
  assert.equal(gen2.segments.length, 2, '新代际 = 基底 + 逐轮记忆段');
  assert.equal(gen2.segments[1].source, '记忆段');
  assert.equal(gen2.segments[1].text, '工作区记忆（逐轮快照）全文');
  // at 回填当前回合用户消息 ts：该段确实是这一轮提示词的一部分
  assert.equal(gen2.at, firstTurnUserTs, '逐轮代际 at 回填当前回合用户消息');
  assert.equal(gen2.enginePrompt.hash, 'cccc3333', '逐轮代际继承引擎真身');
  assert.ok(gen2.tools.length === 1, '逐轮代际继承工具目录');

  // 逐轮重连（内容不变）→ 去重不换代
  await host.setSessionModel('s1', { providerId: 'p1', modelId: 'm2' });
  const sendP2 = host.send('s1', '第二条');
  await sleep(40);
  state.resolveConnect();
  await sendP2;
  await sleep(40);
  state.queue.push({ type: 'turn-complete' });
  await sleep(30);
  assert.equal(host.getHistory('s1').injections.length, 2, '同内容重连不追加快照代际（含引擎真身一致）');
  assert.equal(injPushes.length, 2, '同内容重连不推 injections');

  // 内容变化（agentRules 追加）→ 新代际（保留的逐轮记忆段合并进连接快照，不产生假「移除」代）
  const baseCfg = ctx.config.get();
  ctx.config.get = () => ({ ...baseCfg, agentRules: [{ id: 'r1', enabled: true, text: '新规约' }] });
  await host.setSessionModel('s1', { providerId: 'p1', modelId: 'm3' });
  const sendP3 = host.send('s1', '第三条');
  await sleep(40);
  state.resolveConnect();
  await sendP3;
  await sleep(40);
  state.queue.push({ type: 'turn-complete' });
  await sleep(30);
  const inj3 = host.getHistory('s1').injections;
  assert.equal(inj3.length, 3, '注入内容变化后追加新代际');
  assert.ok(inj3[2].at >= inj3[1].at);
  assert.notEqual(inj3[2].segments[0].hash, inj3[1].segments[0].hash, '政策层段落随 agentRules 变化');
  assert.ok(
    inj3[2].segments.some((s) => s.source === '记忆段'),
    '重连快照合并保留的逐轮记忆段（不产生假「移除」代）'
  );

  // 落盘 + 重启恢复（重开 entry 从信封加载）
  host.store.flushSync();
  openExecution(host, session('s2'));
  const reopened = host.getHistory('s1');
  assert.equal(reopened.injections.length, 3, '重开（未 open 的会话）从盘上读信封');
}

async function testLegacySessionCompat() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { host, ctx } = makeHost(tmp);
  // 旧会话文件：v2 形状、无 injections 信封；消息带未知新字段（harness/steering）不剥
  const legacyId = '11111111-2222-3333-4444-555555555555';
  const badId = '11111111-2222-3333-4444-666666666666';
  ctx.__sessionsDb.set(legacyId, session(legacyId));
  ctx.__sessionsDb.set(badId, session(badId));
  const dir = path.join(tmp, 'agent-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '11111111-2222-3333-4444-555555555555.json'),
    JSON.stringify({
      version: 2,
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ kind: 'text', text: '旧会话的第一句' }],
          ts: 1
        },
        {
          id: 'm2',
          role: 'assistant',
          parts: [{ kind: 'text', text: '旧回复' }],
          ts: 2,
          harness: { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 10 }
        },
        {
          id: 'm3',
          role: 'user',
          parts: [{ kind: 'text', text: '当时的插话' }],
          ts: 3,
          steering: 'send'
        }
      ]
    }),
    'utf8'
  );
  const hist = host.getHistory('11111111-2222-3333-4444-555555555555');
  assert.equal(hist.messages.length, 3, '旧会话照常加载');
  assert.deepEqual(hist.injections, [], '无信封字段 → 空注入快照（宽松解析）');
  assert.equal(hist.messages[1].harness.usage.inputTokens, 1, 'harness 字段保留');
  assert.equal(hist.messages[2].steering, 'send', 'steering 字段保留');
  // 坏信封（非数组）不炸、不丢消息
  fs.writeFileSync(
    path.join(dir, '11111111-2222-3333-4444-666666666666.json'),
    JSON.stringify({ version: 2, messages: [{ id: 'x', role: 'user', parts: [{ kind: 'text', text: 'hi' }], ts: 1 }], injections: 'garbage' }),
    'utf8'
  );
  const bad = host.getHistory('11111111-2222-3333-4444-666666666666');
  assert.equal(bad.messages.length, 1, '坏信封不丢消息');
  assert.deepEqual(bad.injections, [], '坏信封回空');
}

/**
 * 空转回合守卫（2026-09-25 诊断）：引擎秒退/未登录断连时事件流静默结束或直接
 * turn-complete，旧行为留一条空 assistant（用户看到空回复+回合结束，不知差什么）。
 * 回归锁：空回合收口时 assistant 必须标错误；有产出的回合不受影响。
 */
async function testEmptyTurnGuard() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { driver, state } = makeFakeDriver();
  const { host, ctx } = makeHost(tmp);
  host.registerDriver(driver);
  openExecution(host, session('s1'));
  ctx.__sessionsDb.set('s1', session('s1'));
  const sendP = host.send('s1', '干活');
  await sleep(20);
  state.resolveConnect();
  await sendP;
  await sleep(30);
  // 引擎无任何输出直接 turn-complete（典型：CLI 未安装进程秒退 / 未登录断连）
  state.queue.push({ type: 'turn-complete' });
  await sleep(40);
  let hist = host.getHistory('s1');
  const empty = hist.messages.at(-1);
  assert.equal(empty.role, 'assistant');
  assert.ok(empty.error, '空转回合必须标错误，不得静默结束');
  assert.match(empty.error, /未产生任何输出/, '错误说明差什么、怎么排查');
  assert.equal(host.isBusy('s1'), false, '回合已收口');

  // 对照组：有正文产出的回合收口不标错误（既有行为回归）
  const send2 = host.send('s1', '再干一件事');
  await sleep(20);
  state.resolveConnect = () => {};
  await send2;
  await sleep(30);
  state.queue.push({ type: 'text-delta', delta: '有产出' });
  await sleep(20);
  state.queue.push({ type: 'turn-complete' });
  await sleep(40);
  hist = host.getHistory('s1');
  const okTurn = hist.messages.at(-1);
  assert.equal(okTurn.error, undefined, '有产出的回合不标错误');
  assert.equal(host.isBusy('s1'), false);
}

async function testWorkspaceContextLifecycle() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-context-'));
  const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b'); const c = path.join(tmp, 'c');
  for (const dir of [a, b, c]) fs.mkdirSync(dir);
  const workspace = { id: 'ws', name: 'project', path: b, defaultRootId: 'b', controlRoot: a, rootsRevision: 1,
    roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
  const { host, ctx } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: 'ws' });
  const { driver, state } = makeFakeDriver();
  const row = session('scoped', { workspaceId: 'ws', cwd: a, sourceRoot: { rootId: 'a', path: a, cwd: a } });
  const { workspaceRootUsesFor } = require(path.join(root, 'src/main/workspaceRootUses.ts'));
  const uses = workspaceRootUsesFor(ctx.config);
  host.registerDriver(driver); openExecution(host, row); ctx.__sessionsDb.set(row.id, row);
  try {
    const first = host.send(row.id, 'first'); await sleep(30);
    assert.deepEqual(uses.list('ws').map(use => use.rootId), ['a', 'b'], 'all roots are held while connecting');
    assert.equal(state.inputs[0].workspaceContext.controlRoot, a);
    assert.equal(state.inputs[0].workspaceContext.cwd, a);
    workspace.roots.push({ id: 'c', path: c }); workspace.rootsRevision++;
    state.resolveConnect(); await first; await sleep(30);
    assert.equal(state.inputs[0].workspaceContext.roots.length, 2, 'running turn keeps the captured range');
    const injected = host.getHistory(row.id).injections.at(-1).segments.find(segment => segment.source === '工作区目录范围');
    assert.ok(injected && injected.text.includes(JSON.stringify(b)) && !injected.text.includes(JSON.stringify(c)));
    state.queue.push({ type: 'text-delta', delta: 'done' }); state.queue.push({ type: 'turn-complete' }); await sleep(45);
    assert.equal(uses.list('ws').length, 0, 'idle engine does not pin source folders');
    const second = host.send(row.id, 'second'); await sleep(30);
    assert.equal(state.connects, 2, 'directory revision rebuilds the connection');
    assert.equal(state.inputs[1].workspaceContext.roots.length, 3);
    assert.equal(state.inputs[1].cwd, a, 'default change does not relocate session cwd');
    state.resolveConnect(); await second; await sleep(20);
    state.queue.push({ type: 'text-delta', delta: 'done' }); state.queue.push({ type: 'turn-complete' }); await sleep(45);
    const third = host.send(row.id, 'third'); await sleep(30); await third;
    assert.equal(state.connects, 2, 'unchanged directory snapshot reuses the connection');
    assert.equal(uses.list('ws').length, 3);
    await host.close(row.id);
    assert.equal(uses.list('ws').length, 0, 'close releases every referenced root');
  } finally { await host.close(row.id); }
}

async function testUnavailableWorkspaceMessageRefusal() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-message-refusal-'));
  const a = path.join(tmp, 'a'), offline = path.join(tmp, 'offline'); fs.mkdirSync(a);
  const workspace = { id: 'ws', path: a, controlRoot: a, roots: [{ id: 'a', path: a }], defaultRootId: 'a', rootsRevision: 0 };
  const { host, ctx } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: 'ws' });
  const { driver, state } = makeFakeDriver(); host.registerDriver(driver);
  const row = session('refused', { workspaceId: 'ws', cwd: a, sourceRoot: { rootId: 'a', path: a, cwd: a } });
  openExecution(host, row); ctx.__sessionsDb.set(row.id, row);
  const before = structuredClone(host.getHistory(row.id).messages); let touches = 0;
  ctx.sessions.touchUsed = () => { touches++; };
  let operation;
  try {
    fs.renameSync(a, offline);
    const missing = await host.send(row.id, 'must not accept an unavailable directory');
    assert.equal(missing.ok, false); assert.ok(missing.error);
    assert.deepEqual(host.getHistory(row.id).messages, before); assert.equal(state.connects, 0); assert.equal(touches, 0);
    fs.renameSync(offline, a);
    const { beginTaskWorktreeOperation } = require(path.join(root, 'src/main/git/worktreeTaskOperation.ts'));
    operation = beginTaskWorktreeOperation(ctx.config, row.id, 'cleanup');
    for (const busy of [false, true]) {
      host.entries.get(row.id).busy = busy;
      const closing = await host.send(row.id, 'must not queue or steer while cleanup is running');
      assert.equal(closing.ok, false); assert.match(closing.error, /cleanup already running/);
      assert.deepEqual(host.getHistory(row.id).messages, before); assert.equal(host.entries.get(row.id).queue.length, 0);
      assert.equal(state.connects, 0); assert.equal(touches, 0);
    }
  } finally {
    operation?.release();
    if (fs.existsSync(offline)) fs.renameSync(offline, a);
    await host.close(row.id);
  }
}

async function testCodexExecutesInWorktree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-codex-worktree-'));
  const source = path.join(tmp, 'source'); const tree = path.join(tmp, 'tree');
  const placement = codexWorktreeFixture(source, tree, 'a');
  const workspace = { id: 'ws', path: source, roots: [{ id: 'a', path: source }] };
  const { host, ctx } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: 'ws' });
  const { driver, state } = makeFakeDriver('codex-gui');
  host.modelAdmission.catalog = async () => ({ items: [], defaultModel: undefined });
  ctx.bgTasks = {
    prepareDigest: () => null,
    killAllForSessionAndWait: async () => {},
    spawnShell: (id, cwd) => {
      assert.equal(id, row.id);
      assert.equal(cwd, tree);
      return { ok: true, id: 'isolated-bg-fixture' };
    }
  };
  const row = session('codex-worktree', { ...placement, runtime: 'codex-gui', workspaceId: workspace.id });
  host.registerDriver(driver); openExecution(host, row);
  try {
    assert.equal((await host.send(row.id, 'generate files')).ok, true);
    await waitUntil('Codex worktree connection', () => state.inputs.length === 1);
    const input = state.inputs[0];
    state.resolveConnect();
    await waitUntil('Codex worktree turn', () => state.sends.length === 1);
    assert.equal(input.cwd, tree);
    assert.equal(input.workspaceContext.cwd, tree);
    assert.equal(row.cwd, source);
    const shell = input.hostTools.find(tool => tool.id === 'host.bgtasks.shell');
    assert.ok(shell);
    const result = await shell.execute({ command: 'npm run dev' }, { sessionId: row.id, cwd: input.cwd });
    assert.match(result, /isolated-bg-fixture/);
    fixtureGit(tree, 'switch', '-qc', 'wrong-branch');
    const blocked = await host.send(row.id, 'must reject a changed branch');
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /branch changed/);
    assert.equal(state.connects, 1);
  } finally {
    await host.close(row.id);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testLegacyThinkingParameterMigration() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-parameter-legacy-'));
  const profiles = [{ runtimeId: 'pi', parameters: { reasoning: { options: [{ value: 'quiet', label: '关闭', mappedValue: 'off' }, { value: 'deep', label: '深入', mappedValue: 'high' }] } } }];
  const { host, ctx } = makeHost(tmp, { modelParameterProfiles: profiles });
  const { driver } = makeFakeDriver();
  driver.thinkingPolicy = 'hot';
  driver.describeModelParameters = async () => ({ runtimeId: 'pi', providerId: 'p1', modelId: 'm1', parameters: [{ id: 'reasoning', semantic: 'reasoning', label: 'Effort', apply: 'next-turn', supportsDefault: true, options: ['off', 'high'].map(value => ({ value, label: value })) }] });
  host.registerDriver(driver);
  const meta = session('modern-legacy', { modelParameters: { reasoning: 'quiet' } });
  ctx.__sessionsDb.set(meta.id, meta);
  try {
    assert.equal((await host.setThinkingLevel(meta.id, 'high')).ok, true);
    assert.deepEqual(meta.modelParameters, { reasoning: 'deep' });
    assert.equal(meta.thinkingLevel, undefined, 'old IPC does not create a second authority');
    assert.equal((await host.setThinkingLevel(meta.id, null)).ok, true);
    assert.deepEqual(meta.modelParameters, {});
  } finally { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function testModelParameterCommitBoundary() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-parameter-commit-'));
  const profile = { runtimeId: 'pi', parameters: { reasoning: { options: [{ value: 'deep', label: '深入', mappedValue: 'high' }] } } };
  const { host, ctx } = makeHost(tmp, { modelParameterProfiles: [profile] });
  const { driver } = makeFakeDriver();
  let discoveries = 0;
  driver.describeModelParameters = async () => {
    if (++discoveries > 2) throw new Error('catalog disappeared after validation');
    return { runtimeId: 'pi', providerId: 'p1', modelId: 'm1', parameters: [{ id: 'reasoning', semantic: 'reasoning', label: 'Effort', apply: 'next-turn', supportsDefault: true, options: ['off', 'high'].map(value => ({ value, label: value })) }] };
  };
  host.registerDriver(driver);
  const meta = session('commit-boundary'); ctx.__sessionsDb.set(meta.id, meta);
  try {
    const result = await host.setModelParameters(meta.id, { reasoning: 'deep' });
    assert.equal(result.ok, true);
    assert.equal(discoveries, 2, 'commit returns the validated context without a post-write catalog query');
    assert.deepEqual(result.snapshot.values, { reasoning: 'high' }, 'the committed alias still maps to a native value');
    assert.equal(result.snapshot.unavailable, undefined);
    discoveries = 0;
    const editedProfiles = [{ ...profile, parameters: { reasoning: { ...profile.parameters.reasoning, label: 'New label' } } }];
    assert.deepEqual(await host.validateParameterProfiles(editedProfiles), editedProfiles);
    assert.deepEqual(ctx.config.get().modelParameterProfiles, [profile], 'profile validation does not commit configuration');
    discoveries = 0;
    const update = ctx.sessions.updateModelParameters;
    ctx.sessions.updateModelParameters = (id, values) => { update(id, values); ctx.__sessionsDb.delete(id); };
    const removed = await host.setModelParameters(meta.id, { reasoning: null });
    assert.equal(removed.ok, true, 'a committed write is not reported as failed if the session is subsequently removed');
    assert.deepEqual(meta.modelParameters, {});
  } finally { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); }
}

const acpParameterProfileScopeCases = [
  { label: '其他预设的默认值不拦截', profile: { providerId: 'acp:opencode', modelId: 'visible-model', defaultValue: 'high' } },
  { label: '同预设其他模型的默认值不拦截', profile: { providerId: 'acp:kimi', modelId: 'other-model', defaultValue: 'high' } },
  { label: '当前模型仅配置显示名称不拦截', profile: { providerId: 'acp:kimi', modelId: 'visible-model', label: 'Effort' } },
  { label: '当前模型旧通用范围默认值须确认', profile: { modelId: 'visible-model', defaultValue: 'high' }, blocked: true },
  { label: '目录缺失时当前预设的默认值须确认', profile: { providerId: 'acp:kimi', modelId: 'visible-model', defaultValue: 'high' }, missingCatalog: true, blocked: true },
  { label: '目录缺失时其他预设的默认值不拦截', profile: { providerId: 'acp:opencode', modelId: 'visible-model', defaultValue: 'high' }, missingCatalog: true },
  { label: '当前模型旧显式值须确认并保留', overrides: { reasoning: 'high' }, blocked: true },
  { label: '已确认无参数可发送', profile: { providerId: 'acp:opencode', defaultValue: 'high' }, knownEmpty: true }
];

async function testAcpModelParameterProfileScope({ profile, overrides, blocked, knownEmpty, missingCatalog }) {
  const prefix = 'gui-picker-profile-scope-';
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', prefix));
  const workspace = { id: 'ws', path: tmp, controlRoot: tmp, roots: [{ id: 'root', path: tmp }], defaultRootId: 'root', rootsRevision: 0 };
  const profiles = profile ? [{ runtimeId: 'acp', ...(profile.providerId ? { providerId: profile.providerId } : {}),
    ...(profile.modelId ? { modelId: profile.modelId } : {}), parameters: { reasoning: {
      ...(profile.defaultValue ? { defaultValue: profile.defaultValue } : {}), ...(profile.label ? { label: profile.label } : {})
    } } }] : [];
  const { host } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: 'ws', modelParameterProfiles: profiles });
  const { driver, state } = makeFakeDriver('acp');
  driver.resolveMode = id => id === 'kimi' ? { connectExtras: { acpAgent: id } } : null;
  driver.describeModelParameters = async input => {
    assert.equal(input.piModeId, 'kimi');
    assert.equal(input.modelOverride.modelId, 'visible-model');
    if (missingCatalog) throw new Error('尚未读取模型目录，请手动刷新');
    return { runtimeId: 'acp', providerId: 'acp:kimi', modelId: 'visible-model', parameters: [],
      ...(knownEmpty ? {} : { unavailable: true, warning: '当前模型的参数尚未读取，请手动刷新模型目录' }) };
  };
  host.registerDriver(driver);
  const row = session('acp-parameters', { runtime: 'acp', workspaceId: 'ws', cwd: tmp, piModeId: 'kimi',
    sourceRoot: { rootId: 'root', path: tmp, cwd: tmp }, modelOverride: { providerId: 'acp', modelId: 'visible-model' }, modelParameters: overrides });
  openExecution(host, row);
  try {
    const pending = host.send(row.id, 'Continue with the current model.');
    const lastError = () => host.getHistory(row.id)?.messages.at(-1)?.error;
    await waitUntil('parameter check or engine connection', () => state.connects || lastError());
    state.resolveConnect?.();
    await pending;
    assert.deepEqual(row.modelParameters, overrides);
    if (blocked) {
      assert.equal(state.connects, 0);
      assert.match(lastError(), /模型参数尚未读取/);
    } else {
      assert.equal(lastError(), undefined, 'unrelated profiles must not require model discovery');
      await waitUntil('native submission without overrides', () => state.sends.length === 1);
      assert.match(state.inputs[0].firstPromptPrefix, /You are the Worker for this chat\./, 'ACP receives the same host prefix field as Pi');
      assert.doesNotMatch(state.inputs[0].systemPromptAppend, /Muster Console opens or resumes/);
      assert.deepEqual(state.sentParameters[0], {});
      state.queue.push({ type: 'text-delta', delta: 'Continued.' });
      state.queue.push({ type: 'turn-complete' });
      await waitUntil('native turn settlement', () => !host.isBusy(row.id));
    }
  } finally {
    await host.close(row.id);
    host.store.flushSync();
    removeDesktopFixture(tmp, prefix);
  }
}

async function testExecutionOwnership() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-execution-'));
  const { host, ctx } = makeHost(tmp);
  const { driver, state } = makeFakeDriver();
  host.registerDriver(driver); openExecution(host, session('execution'));
  ctx.__sessionsDb.set('execution', session('execution'));
  await host.send('execution', 'first');
  await sleep(20); state.resolveConnect(); await sleep(40);
  const execution = { id: 'owned-turn', revision: 1, at: Date.now(), result: 'completed', process: 'draining' };
  state.queue.push({ type: 'execution', state: execution });
  state.queue.push({ type: 'text-delta', delta: 'answer' });
  await sleep(30);
  assert.equal(host.getHistory('execution').execution.process, 'draining');
  assert.equal(host.isBusy('execution'), true);
  await host.send('execution', 'queued');
  state.queue.push({ type: 'execution', state: { ...execution, revision: 2, process: 'reclaim_failed' } });
  state.queue.push({ type: 'turn-complete' }); // A premature terminal must not release an owned writer.
  await sleep(30);
  assert.equal(host.isBusy('execution'), true);
  assert.equal(state.sends.length, 1);
  assert.equal(host.getHistory('execution').execution.process, 'reclaim_failed');
  state.queue.push({ type: 'execution', state: execution }); // stale revision
  await sleep(20);
  assert.equal(host.getHistory('execution').execution.process, 'reclaim_failed');
  state.queue.push({ type: 'execution', state: { ...execution, revision: 3, process: 'released' } });
  state.queue.push({ type: 'turn-complete' });
  await sleep(60);
  assert.equal(state.sends.length, 2, 'queued message starts only after process release');
  assert.equal(host.getHistory('execution').execution, undefined, 'new turn clears prior lifecycle');
  state.queue.push({ type: 'turn-complete' }); await sleep(30);
  host.close('execution');
}

async function testMailboxWakeAdmission() {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gui-mailbox-'));
  const {driver,state}=makeFakeDriver();const {host,ctx}=makeHost(tmp);
  host.registerDriver(driver);openExecution(host, session('s1'));ctx.__sessionsDb.set('s1',session('s1'));
  const first=host.send('s1','人正在工作');await sleep(20);
  const busy=await host.send('s1','有新信',undefined,{host:true,requireIdle:true,messageId:'wake-1'});
  assert.equal(busy.ok,false);assert.equal(busy.error,'busy');
  assert.equal(host.entries.get('s1').queue.length,0);assert.equal(host.getHistory('s1').messages.some(m=>m.id==='wake-1'),false);
  state.resolveConnect();await first;await sleep(30);state.queue.push({type:'turn-complete'});await sleep(40);
  const delivered=await host.send('s1','【宿主收信提醒】有新信',undefined,{host:true,requireIdle:true,messageId:'wake-1'});
  assert.equal(delivered.ok,true);await sleep(30);
  const duplicate=await host.send('s1','【宿主收信提醒】有新信',undefined,{host:true,requireIdle:true,messageId:'wake-1'});
  assert.equal(duplicate.ok,true);assert.equal(state.sends.length,2);
  assert.equal(host.entries.get('s1').lastTurnInput.userText,undefined,'宿主提醒不得成为用户原话或授权证据');
  state.queue.push({type:'turn-complete'});await sleep(40);host.flushPersist();
  assert.equal(host.getHistory('s1').messages.find(m=>m.id==='wake-1').host,true);
  host.close('s1');openExecution(host, session('s1'));
  assert.equal(host.getHistory('s1').messages.find(m=>m.id==='wake-1').host,true,'恢复仍为宿主身份');
  assert.equal((await host.send('s1','same',undefined,{host:true,requireIdle:true,messageId:'wake-1'})).ok,true);
  assert.equal(state.sends.length,2,'重开后固定通知 ID 不重启回合');host.close('s1');
}

async function testInitialAssignmentNativeReceipt() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-assignment-'));
  const { setAgentMessagesUserDataDir, readAgentMessageLedger } = require(path.join(root, 'src/main/metaAgent/messageStore.ts'));
  const { sendSessionMail } = require(path.join(root, 'src/main/messages/assignment.ts'));
  const { attachMailboxWakes, flushMailboxWake } = require(path.join(root, 'src/main/messages/wake.ts'));
  const workspace = { id: 'assignment-fixture', name: 'Fixture', path: fixtureWorkspace };
  const { host, ctx } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: workspace.id });
  const { driver, state } = makeFakeDriver();
  const row = session('assignment', { workspaceId: workspace.id, lifecycle: 'idle' });
  ctx.workspaces = { list: () => [workspace] };
  ctx.resolveBubbleWorkspaceId = () => workspace.id;
  ctx.sessions.isChatRuntime = runtime => runtime === 'pi';
  ctx.sessions.onLifecycle = () => () => {};
  ctx.sessions.broadcastMessagesChanged = () => {};
  ctx.agentSessions = host;
  setAgentMessagesUserDataDir(tmp);
  host.registerDriver(driver);
  openExecution(host, row);
  const detach = attachMailboxWakes(ctx);
  const flush = () => flushMailboxWake(ctx, row.id, workspace.id);
  const receipt = () => readAgentMessageLedger(workspace.path, workspace.id).messages[0];
  try {
    await flush();
    assert.equal(state.connects, 0, 'opening a new blank session does not ask the model to recognize the host');
    const task = 'Compile the changed module and report the exact result.';
    const mail = await sendSessionMail(ctx, { sessionId: row.id, text: task,
      idempotencyKey: 'initial-assignment', initialAssignment: true, reuseExisting: true });
    await flush();
    await waitUntil('assignment connection', () => state.resolveConnect);
    state.resolveConnect();
    await waitUntil('assignment native input', () => state.sends.length === 1);
    assert.match(state.sends[0], /^<muster_host_context source="automatic">\n[\s\S]*Compile the changed module[\s\S]*\n<\/muster_host_context>/);
    assert.match(state.sends[0], /Compile the changed module and report the exact result\./);
    assert.ok(state.sends[0].includes(mail.messageId));
    assert.doesNotMatch(state.sends[0], /host\.mail\.read/);
    assert.equal(receipt().initialAssignmentReceipt.deliveredAt, undefined);
    const id = state.authorities[0].forkIdentity.userMessageId;
    state.queue.push({ type: 'turn-started', userMessageId: 'other-turn' });
    await waitUntil('wrong native receipt drained', () => !state.queue.items.length);
    assert.equal(receipt().initialAssignmentReceipt.deliveredAt, undefined);
    state.queue.push({ type: 'turn-started', userMessageId: id });
    await waitUntil('matching native delivery receipt', () => receipt().initialAssignmentReceipt.deliveredAt);
    assert.equal(receipt().read, false);
    state.queue.push({ type: 'text-delta', delta: 'Working.' });
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('first assignment turn settles', () => !host.isBusy(row.id));
    await host.send(row.id, 'Now inspect the logs.');
    await waitUntil('follow-up native input', () => state.sends.length === 2);
    assert.equal(state.sends[1], 'Now inspect the logs.');
    state.queue.push({ type: 'turn-complete' });
  } finally {
    detach();
    await host.closeAll();
    await detach.drain();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function installWorkerRouteSessionProjection(ctx) {
  const source = fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8');
  const ast = ts.createSourceFile('sessions.ts', source, ts.ScriptTarget.Latest, true);
  const klass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionsService');
  const methods = ['commitWorkerRoute', 'noteWorkerRoute'].map(name =>
    klass.members.find(node => node.name?.getText(ast) === name).getText(ast));
  const Projection = new Function(ts.transpileModule(`return class { ${methods.join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText)();
  const projection = new Projection();
  Object.assign(projection, {
    peek: ctx.sessions.get,
    persister: { flushStrict: async (validate, project, commit) => {
      validate();
      const rows = project?.([...ctx.__sessionsDb.values()]);
      if (ctx.failWorkerRouteCommit && rows?.some(row => row.workerRouting?.attempts.length === 2)) throw new Error('Fixture registry write failed');
      commit?.();
    } },
    persist() {},
    broadcast() {}
  });
  ctx.sessions.commitWorkerRoute = projection.commitWorkerRoute.bind(projection);
  ctx.sessions.noteWorkerRoute = projection.noteWorkerRoute.bind(projection);
}

async function testWorkerRouteNativeHandoff(scenario) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-route-host-'));
  const { GuiDeliveryError } = require(path.join(root, 'src/main/agentSession/types.ts'));
  const { setAgentMessagesUserDataDir, readAgentMessageLedger } = require(path.join(root, 'src/main/metaAgent/messageStore.ts'));
  const { sendSessionMail } = require(path.join(root, 'src/main/messages/assignment.ts'));
  const { attachMailboxWakes, holdMailboxWake } = require(path.join(root, 'src/main/messages/wake.ts'));
  const { readMailbox } = require(path.join(root, 'src/main/messages/read.ts'));
  const { workerOptionsHost } = require(path.join(root, 'src/main/capabilities/hosts/workerOptions.ts'));
  const { runAsAgentSession } = require(path.join(root, 'src/main/agent/agentScope.ts'));
  const { resolveSessionTarget } = require(path.join(root, 'src/main/sessions/targets.ts'));
  const { captureWorkerRoute, routingSettings, saveWorkerRoutingSettings } = require(path.join(root, 'src/main/tasks/workerRouting.ts'));
  const codexModels = require(path.join(root, 'src/main/agentSession/drivers/codex/models.ts'));
  const originalCodexModels = codexModels.listCodexModels;
  const workspace = { id: 'route-fixture', name: 'Fixture', path: fixtureWorkspace };
  const worktreePath = path.join(tmp, 'task-worktree');
  fs.mkdirSync(worktreePath);
  const changed = path.join(worktreePath, 'changed.txt');
  fs.writeFileSync(changed, 'verified edit from the first Worker');
  const nativeOrigin = scenario === 'native-policy';
  const consentGiven = scenario.startsWith('authorized');
  const crossProduct = consentGiven || nativeOrigin || scenario === 'restricted-core' || scenario === 'core-full-cross';
  const core = { harnessId: 'muster-core', surface: 'gui', runtimeId: 'pi' };
  const members = [
    { id: 'core', enabled: true, config: crossProduct ? core : { ...core, model: { providerId: 'primary', modelId: 'fixture' } } },
    { id: 'backup', enabled: true, config: crossProduct ? { harnessId: 'codex', surface: 'gui', runtimeId: 'codex-gui',
      ...(consentGiven ? { model: { providerId: 'codex-gui', modelId: 'codex-fixture' } } : {}) }
      : { ...core, model: { providerId: 'backup', modelId: 'fixture' } } }
  ];
  if (scenario === 'authorized-next-unbound') members.push({ id: 'another', enabled: true,
    config: { harnessId: 'codex', surface: 'gui', runtimeId: 'codex-gui', model: { providerId: 'codex-gui', modelId: 'codex-second' } } });
  if (nativeOrigin) members.reverse();
  const { host, ctx } = makeHost(tmp, { workspaces: [workspace], activeWorkspaceId: workspace.id,
    llm: { activeProviderId: 'primary', activeModelId: 'fixture', providers: ['primary', 'backup'].map(id => ({
      id, name: id, baseUrl: 'http://127.0.0.1:1/v1', apiKey: `fixture-${id}`, models: [{ id: 'fixture', name: 'Fixture model' }]
    })) },
    workerRoutingByWorkspace: { [workspace.id]: { revision: 1, tiers: [
      { id: 'deep', name: 'Deep', description: 'Multi-stage work', members, fallbackTierIds: [] }
    ] } } });
  const old = makeFakeDriver(members[0].config.runtimeId);
  const replacement = makeFakeDriver(members[1].config.runtimeId);
  old.driver.probe = async () => ({ status: 'available', problems: [] });
  replacement.driver.probe = async () => ({ status: 'available', problems: [] });
  ctx.workspaces = { list: () => [workspace] };
  ctx.resolveBubbleWorkspaceId = () => workspace.id;
  const runtimes = members.map(member => ({ id: member.config.runtimeId, surface: 'chat', enabled: true }));
  ctx.runtimes = { list: () => runtimes, get: id => runtimes.find(runtime => runtime.id === id) };
  ctx.sessions.isChatRuntime = runtime => runtimes.some(item => item.id === runtime);
  ctx.sessions.onLifecycle = () => () => {};
  ctx.sessions.broadcastMessagesChanged = () => {};
  ctx.agentSessions = host;
  installWorkerRouteSessionProjection(ctx);
  host.registerDriver(old.driver);
  if (crossProduct) host.registerDriver(replacement.driver);
  else {
    const connectPrimary = old.driver.connect.bind(old.driver);
    old.driver.connect = input => old.state.connects ? replacement.driver.connect(input) : connectPrimary(input);
  }
  const target = await resolveSessionTarget(ctx.config.get(), { workspaceId: workspace.id });
  ctx.config.updateWorkerRouting = patch => ctx.config.update(patch);
  const saveRoute = (config, baseline) => saveWorkerRoutingSettings(ctx, target, { layer: 'workspace', expectedVersion: baseline.version, config });
  let authorizedSettings;
  if (consentGiven) {
    replacement.driver.nativeConfigVersion = () => 'codex-fixture-v1';
    replacement.driver.captureWorkerPermission = async () => 'a'.repeat(64);
    codexModels.listCodexModels = async () => ({ ok: true, items: ['codex-fixture', 'codex-second'].map(id => ({ id, displayName: id })) });
    const nativeConfig = { identity: { runtimeId: 'codex-gui', version: 'codex-fixture-v1',
      sourceKey: JSON.stringify([workspace.id, target.sourceRoot.rootId, target.sourceRoot.cwd]) }, selections: [
      { id: 'permissions', value: ':workspace' }, { id: 'approvalPolicy', value: 'on-request' }, { id: 'approvalsReviewer', value: 'user' }
    ] };
    const baseline = await routingSettings(ctx, target, 'workspace');
    const draft = structuredClone(baseline.config);
    draft.tiers[0].members[1].crossHarness = { nativeConfig };
    authorizedSettings = await saveRoute(draft, baseline);
    const forged = structuredClone(authorizedSettings.config);
    forged.tiers[0].members[1].crossHarness.binding = `wp1.${'0'.repeat(64)}.${'0'.repeat(64)}`;
    await assert.rejects(saveRoute(forged, authorizedSettings), /permissions changed/);
  }
  const plan = await captureWorkerRoute(ctx, target, { tierId: 'deep' });
  const row = session('logical-worker', { workspaceId: workspace.id, sourceRoot: target.sourceRoot, cwd: worktreePath,
    runtime: members[0].config.runtimeId,
    modelOverride: members[0].config.model,
    ...(scenario === 'authorized-child' ? { parentSessionId: 'parent-worker' } : {}),
    ...(nativeOrigin ? { nativeConfig: { identity: { runtimeId: 'codex-gui', sourceKey: JSON.stringify([workspace.id, target.sourceRoot.rootId, target.sourceRoot.cwd]) },
      selections: [{ id: 'approvalPolicy', value: 'on-request' }] } } : {}),
    worktreePath, lifecycle: 'idle', runtimeResumeToken: 'old-pi-native-token', externalSessionId: 'old-pi-native-session',
    workerRouting: { plan, phase: 'starting', attempts: [{ ...plan.candidates[0], attempt: 1, startedAt: Date.now(), state: 'starting' }] } });
  setAgentMessagesUserDataDir(tmp);
  openExecution(host, row);
  const detach = attachMailboxWakes(ctx);
  const releaseWake = holdMailboxWake(ctx, row.id, workspace.id);
  let releaseClose, releaseParameters;
  const connectOld = async () => {
    await waitUntil('old driver connect', () => old.state.resolveConnect);
    old.state.resolveConnect();
    await waitUntil('old driver first input', () => old.state.sends.length === 1);
  };
  const endOldTurn = async () => {
    old.state.queue.push({ type: 'text-delta', delta: 'Recorded result.' });
    old.state.queue.push({ type: 'turn-complete' });
    await waitUntil('old native turn completion', () => !host.isBusy(row.id));
  };
  try {
    if (crossProduct) {
      if (scenario === 'restricted-core') { row.guiMode = 'accept-edits'; host.entries.get(row.id).mode = 'accept-edits'; }
      await host.send(row.id, 'Work under the current permission policy.');
      await connectOld();
      if (scenario === 'authorized-stale') replacement.driver.nativeConfigVersion = () => 'codex-fixture-v2';
      old.state.queue.push({ type: 'error', message: 'Fixture quota', workerFailure: { reason: 'quota', boundary: 'settled' } });
      if (scenario === 'authorized' || scenario === 'authorized-next-unbound') {
        await waitUntil('authorized replacement connects', () => replacement.state.resolveConnect);
        const input = replacement.state.inputs[0];
        assert.equal(row.runtime, 'codex-gui');
        assert.equal(row.workerRouting.attempts.length, 2);
        assert.equal(input.resumeToken, undefined);
        assert.equal(input.cwd, worktreePath);
        assert.equal(input.workerPermission.snapshot, 'a'.repeat(64));
        assert.deepEqual(input.nativeConfig, authorizedSettings.config.tiers[0].members[1].crossHarness.nativeConfig);
        input.workerPermission.assertCurrent(host.entries.get(row.id).activeExecutionTurnId);
        replacement.state.resolveConnect();
        await waitUntil('authorized handoff submitted by fake transport', () => replacement.state.sends.length === 1);
        replacement.state.queue.push({ type: 'text-delta', delta: 'Replacement has the verified worktree.' });
        replacement.state.queue.push({ type: 'turn-complete' });
        await waitUntil('authorized replacement settles', () => row.workerRouting.phase === 'idle');
        row.runtimeResumeToken = 'new-codex-token';
        replacement.state.queue.closed = true;
        await waitUntil('authorized connection is retired before reconnect', () => !host.entries.get(row.id).connection);
        await host.send(row.id, 'Continue the existing verification.');
        await waitUntil('authorized Codex reconnects', () => replacement.state.connects === 2);
        const resumedInput = replacement.state.inputs[1];
        const executionTurn = host.entries.get(row.id).activeExecutionTurnId;
        assert.equal(resumedInput.resumeToken, 'new-codex-token');
        assert.equal(resumedInput.workerPermission.snapshot, 'a'.repeat(64));
        resumedInput.workerPermission.assertCurrent(executionTurn);
        replacement.state.resolveConnect();
        await waitUntil('authorized reconnect submits a new turn', () => replacement.state.sends.length === 2);
        if (scenario === 'authorized-next-unbound') {
          replacement.state.queue.push({ type: 'error', message: 'Second quota failure', workerFailure: { reason: 'quota', boundary: 'settled' } });
          await waitUntil('next same-Harness candidate lacks its own approval', () => row.workerRouting.phase === 'blocked');
          assert.equal(row.workerRouting.attempts.length, 2);
          assert.equal(row.modelOverride.modelId, 'codex-fixture');
          return;
        }
        const revoked = structuredClone(authorizedSettings.config);
        delete revoked.tiers[0].members[1].crossHarness;
        await saveRoute(revoked, authorizedSettings);
        assert.throws(() => resumedInput.workerPermission.assertCurrent(executionTurn), /tiers changed/);
        assert.equal(fs.readFileSync(changed, 'utf8'), 'verified edit from the first Worker');
        replacement.state.queue.push({ type: 'turn-complete' });
        await waitUntil('authorized replacement settles', () => row.workerRouting.phase === 'idle');
        return;
      }
      await waitUntil('different Harness lacks equivalent permission', () => row.workerRouting.phase === 'blocked');
      assert.equal(row.workerRouting.attempts.length, 1);
      assert.equal(row.runtime, members[0].config.runtimeId);
      assert.equal(replacement.state.connects, 0);
      if (nativeOrigin) assert.equal(row.nativeConfig.selections[0].value, 'on-request');
      return;
    }
    if (scenario === 'unconfirmed-assignment') {
      await sendSessionMail(ctx, { sessionId: row.id, text: 'Initial task awaiting native receipt.',
        idempotencyKey: 'initial-assignment', initialAssignment: true, reuseExisting: true });
      await host.send(row.id, 'Start the task.');
      await connectOld();
      const queued = await host.send(row.id, 'Queued follow-up.', undefined, { steerOnBusy: false });
      assert.equal(queued.queued, true);
      old.state.queue.push({ type: 'turn-complete' });
      await waitUntil('unconfirmed native completion pauses queued input', () => row.workerRouting.phase === 'blocked' && !host.isBusy(row.id));
      assert.equal(old.state.sends.length, 1);
      assert.equal(host.entries.get(row.id).queue.length, 1);
      assert.equal(readAgentMessageLedger(workspace.path, workspace.id).messages[0].initialAssignmentReceipt.deliveredAt, undefined);
      return;
    }
    if (scenario === 'cancel' || scenario === 'write-failure' || scenario === 'mode-race' || scenario === 'native-race') {
      await host.send(row.id, 'Work before a controlled attempt change.');
      await connectOld();
      let closeStarted = false;
      const closeGate = new Promise(resolve => { releaseClose = resolve; });
      const close = old.state.conn.close;
      old.state.conn.close = async () => { closeStarted = true; await closeGate; await close(); };
      ctx.failWorkerRouteCommit = scenario === 'write-failure';
      old.state.queue.push({ type: 'error', message: 'Fixture quota', workerFailure: { reason: 'quota', boundary: 'settled' } });
      await waitUntil('old attempt enters retirement', () => closeStarted && row.workerRouting.phase === 'switching');
      if (scenario === 'cancel') await host.abort(row.id);
      if (scenario === 'mode-race') host.entries.get(row.id).mode = 'accept-edits';
      if (scenario === 'native-race') row.nativeConfig = { identity: { runtimeId: 'pi', sourceKey: 'changed' }, selections: [{ id: 'fixture', value: 'new' }] };
      releaseClose();
      await waitUntil('attempt remains on original Harness', () => row.workerRouting.phase === (scenario === 'cancel' ? 'cancelled' : 'blocked'));
      await sleep(25);
      assert.equal(row.workerRouting.attempts.length, 1);
      assert.equal(row.runtime, 'pi');
      assert.equal(row.runtimeResumeToken, 'old-pi-native-token');
      assert.equal(replacement.state.connects, 0);
      if (scenario === 'cancel') {
        const late = await host.send(row.id, 'Late host wake', undefined, { host: true, fromInject: true });
        assert.equal(late.ok, false);
        assert.equal(row.workerRouting.phase, 'cancelled');
      }
      return;
    }
    if (scenario === 'settled') {
      const initialBody = 'Implement the original task. ' + '工作😀'.repeat(1500) + 'Exact final mail requirement.';
      const earlyInstruction = 'Never publish the build outside this workspace. ' + 'Keep local. '.repeat(430) + 'Exact final user restriction.';
      const initial = await sendSessionMail(ctx, { sessionId: row.id, text: initialBody,
        idempotencyKey: 'initial-assignment', initialAssignment: true, reuseExisting: true });
      await host.send(row.id, earlyInstruction, undefined, { messageId: 'early-instruction' });
      await connectOld();
      assert.equal(old.state.inputs[0].resumeToken, 'old-pi-native-token');
      await endOldTurn();
      for (let index = 0; index < 4; index++) {
        await host.send(row.id, `Intermediate step ${index + 1}`);
        await waitUntil('intermediate native input', () => old.state.sends.length === index + 2);
        await endOldTurn();
      }
      await host.send(row.id, 'Continue with the local verification.');
      await waitUntil('native input before quota failure', () => old.state.sends.length === 6);
      old.state.queue.push({ type: 'tool-start', toolCallId: 'write-checked', toolName: 'write', input: { path: changed } });
      old.state.queue.push({ type: 'tool-result', toolCallId: 'write-checked', ok: true, output: 'Verified edit written and checked.' });
      let closeStarted = false, closeFinished = false;
      const closeGate = new Promise(resolve => { releaseClose = resolve; });
      old.state.conn.close = async () => {
        closeStarted = true;
        await closeGate;
        closeFinished = true;
      };
      let preparingReplacement = false;
      const parameterGate = new Promise(resolve => { releaseParameters = resolve; });
      old.driver.describeModelParameters = async input => {
        if (row.workerRouting.attempts.length === 2) { preparingReplacement = true; await parameterGate; }
        return { runtimeId: 'pi', providerId: input.modelOverride?.providerId ?? 'primary', modelId: 'fixture', parameters: [] };
      };
      old.state.queue.push({ type: 'error', message: 'Fixture quota exhausted',
        workerFailure: { reason: 'quota', boundary: 'settled' } });
      await waitUntil('old connection starts retirement', () => closeStarted && row.workerRouting.phase === 'switching');
      assert.equal(replacement.state.connects, 0);
      assert.equal(row.runtime, 'pi');
      releaseClose();
      await waitUntil('replacement turn prepares before connection', () => preparingReplacement);
      assert.equal(closeFinished, true);
      assert.equal(replacement.state.connects, 0);
      // The engine is closed, but its event iterator drains later. Its finally
      // block must leave the replacement turn in preflight alone.
      old.state.queue.closed = true;
      await sleep(25);
      assert.equal(host.isBusy(row.id), true, 'late old pump must not finish the replacement turn');
      releaseParameters();
      await waitUntil('replacement connect after retirement', () => replacement.state.resolveConnect);
      assert.equal(closeFinished, true);
      assert.equal(ctx.__sessionsDb.size, 1, 'same logical session across Harnesses');
      assert.equal(row.workerRouting.attempts.length, 2);
      assert.equal(row.workerRouting.attempts[0].reason, 'quota');
      assert.equal(row.runtime, 'pi');
      assert.equal(row.modelOverride.providerId, 'backup');
      assert.equal(row.worktreePath, worktreePath);
      assert.equal(row.cwd, worktreePath);
      const input = replacement.state.inputs[0];
      assert.equal(input.sessionId, row.id);
      assert.equal(input.cwd, worktreePath);
      assert.equal(input.resumeToken, undefined);
      assert.equal(input.hasPriorConversation, false, 'new Harness uses the handoff, never another engine’s native history');
      assert.equal(row.externalSessionId, undefined);
      assert.equal(fs.readFileSync(changed, 'utf8'), 'verified edit from the first Worker');
      replacement.state.resolveConnect();
      await waitUntil('replacement receives bounded handoff', () => replacement.state.sends.length === 1);
      const handoff = replacement.state.sends[0];
      assert.match(handoff, /Host Worker continuation/);
      assert.match(handoff, /Verified edit written and checked\./);
      assert.ok(handoff.includes(initial.messageId));
      assert.doesNotMatch(handoff, /Exact final (?:mail requirement|user restriction)/);
      assert.match(handoff, /host\.workers\.context/);
      const context = args => runAsAgentSession(row.id, async () => workerOptionsHost['workers.context'](ctx, args));
      let history = await context({});
      assert.ok(history.nextBefore);
      while (!history.messages.some(message => message.messageId === 'early-instruction') && history.nextBefore !== null)
        history = await context({ before: history.nextBefore });
      assert.ok(history.messages.some(message => message.messageId === 'early-instruction'));
      let text = '', bodyOffset = 0;
      while (bodyOffset !== null) {
        const page = await context({ messageId: 'early-instruction', bodyOffset });
        text += page.text;
        bodyOffset = page.nextOffset;
      }
      assert.equal(text, earlyInstruction);
      text = ''; bodyOffset = 0;
      while (bodyOffset !== null) {
        const page = await readMailbox(ctx, { messageId: initial.messageId, bodyOffset },
          { id: row.id, workspaceId: workspace.id, hostView: false });
        text += page.text;
        bodyOffset = page.nextOffset;
      }
      assert.equal(text, initialBody);
      assert.equal(readAgentMessageLedger(workspace.path, workspace.id).messages.length, 1);
      replacement.state.queue.push({ type: 'text-delta', delta: 'Continued with existing result.' });
      replacement.state.queue.push({ type: 'turn-complete' });
      await waitUntil('replacement settles', () => row.workerRouting.phase === 'idle');
      return;
    }

    await host.send(row.id, 'First Worker instruction.');
    await connectOld();
    if (scenario === 'open-tool') {
      old.state.queue.push({ type: 'tool-start', toolCallId: 'in-flight', toolName: 'write', input: { path: changed } });
      old.state.queue.push({ type: 'error', message: 'Quota failure during open tool',
        workerFailure: { reason: 'quota', boundary: 'settled' } });
    } else {
      await endOldTurn();
      old.state.conn.send = async () => {
        throw Object.assign(new GuiDeliveryError('429 followed by ambiguous timeout', 'unknown'), { status: 429 });
      };
      await host.send(row.id, 'Continue after the first turn.');
    }
    await waitUntil('uncertain delivery holds route', () => row.workerRouting.phase === 'blocked');
    assert.equal(row.workerRouting.reason, 'delivery-unknown');
    assert.equal(row.workerRouting.attempts.length, 1);
    assert.equal(replacement.state.connects, 0);
  } finally {
    codexModels.listCodexModels = originalCodexModels;
    releaseClose?.();
    releaseParameters?.();
    if (old.state.queue) old.state.queue.closed = true;
    detach();
    releaseWake();
    await host.closeAll();
    await detach.drain();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testNativeMailboxIntent() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mailbox-'));
  const { driver, state } = makeFakeDriver(); const { host, ctx } = makeHost(tmp);
  const desktopBegins = [];
  ctx.desktopTurns = () => ({ begin(owner, turnId, current, userInstruction) { desktopBegins.push({ owner, turnId, current, userInstruction }); }, end() {} });
  host.registerDriver(driver); openExecution(host, session('s1')); ctx.__sessionsDb.set('s1', session('s1'));
  await host.send('s1', 'working'); await sleep(20); state.resolveConnect();
  // 回合管道（skill 装配/uiWidget 上下文/记忆检索）在连接落地后仍需多个 await+fs，
  // 固定 30ms 在满套件负载下赶不上 conn.send——有界等待引擎实际发出
  for (let i = 0; i < 100 && state.sends.length < 1; i++) await sleep(10);
  const received = [];
  state.conn.receiveMessage = async message => {
    received.push(message);
    return message.intent === 'interrupt' ? { status: 'accepted', method: 'steered' }
      : { status: 'unsupported', reason: 'no native queue' };
  };
  const normal = await host.deliverMessage('s1', { intent: 'normal', messageId: 'normal-mail', text: 'normal notice' });
  assert.equal(normal.ok, false); assert.equal(normal.error, 'native-unsupported');
  assert.equal(host.entries.get('s1').queue.length, 0, 'mailbox owns deferred delivery');
  const interrupt = { intent: 'interrupt', messageId: 'native-mail', text: 'priority notice' };
  const result = await host.deliverMessage('s1', interrupt);
  assert.equal(result.delivery, 'steered'); assert.equal(state.aborts, 0, 'native steering must not abort');
  assert.equal(state.sends.length, 1, 'steering must not start a parallel turn');
  assert.equal(host.getHistory('s1').messages.find(m => m.id === interrupt.messageId).host, true);
  await host.deliverMessage('s1', interrupt);
  assert.equal(received.length, 2, 'stable notice ID deduplicates accepted native delivery');
  state.conn.receiveMessage = async () => ({ status: 'unsupported', reason: 'no native queue' });
  const unsupportedUser = await host.send('s1', 'user fallback', undefined, { steerOnBusy: true, messageId: 'user-fallback' });
  assert.equal(unsupportedUser.steerUnsupported, true, 'unsupported user steering must open a renderer fallback without queueing');
  assert.equal(unsupportedUser.queued, undefined);
  assert.equal(host.entries.get('s1').queue.length, 0, 'unsupported user steering must not enter the host queue');
  assert.equal(host.getHistory('s1').messages.some(m => m.id === 'user-fallback'), false, 'fallback choice must happen before history admission');
  state.conn.receiveMessage = async () => ({ status: 'accepted', method: 'queued' });
  const followUp = { intent: 'normal', messageId: 'native-follow-up', text: 'after current task' };
  const currentAssistant = host.entries.get('s1').assistant;
  assert.equal((await host.deliverMessage('s1', followUp)).delivery, 'queued');
  assert.equal(host.entries.get('s1').assistant, currentAssistant, 'native queue admission does not split the running response');
  assert.equal(host.entries.get('s1').queue.length, 0, 'adapter owns native queue');
  state.queue.push({ type: 'native-message-start', messageId: followUp.messageId, text: followUp.text });
  state.queue.push({ type: 'text-delta', delta: 'native follow-up answer' });
  await sleep(25);
  assert.notEqual(host.entries.get('s1').assistant, currentAssistant);
  assert.equal(host.getHistory('s1').messages.filter(m => m.id === followUp.messageId).length, 1);
  assert.equal(host.getHistory('s1').messages.find(m => m.id === followUp.messageId).queued, false);
  assert.ok(JSON.stringify(host.entries.get('s1').assistant).includes('native follow-up answer'));
  assert.equal(desktopBegins.length, 1, '宿主原生消息不能启动用户桌面回合');
  const { desktopTurnGrants } = require(path.join(root, 'src/main/desktop/turnGrant.ts'));
  const approve = () => desktopTurnGrants.authorize('s1', () => true, async () => true, () => {});
  const beforeQueuedUser = await approve();
  await host.send('s1', 'queued user', undefined, { messageId: 'queued-user', steerOnBusy: false });
  assert.equal(beforeQueuedUser(), false, 'accepting a user message revokes the preceding turn');
  const beforeNativeStart = await approve();
  state.queue.push({ type: 'turn-complete' });
  await sleep(70);
  assert.equal(state.sends.at(-1), 'queued user', '用户消息由工作台队列派发');
  assert.equal(beforeNativeStart(), false, '工作台队列消费也会撤销旧桌面授权');
  assert.equal(desktopBegins.length, 2);
  assert.equal(desktopBegins[1].userInstruction, true, '用户原生消息消费时建立新的桌面代次');
  let releaseSteer, enteredSteer;
  const steerStarted = new Promise(resolve => { enteredSteer = resolve; });
  state.conn.receiveMessage = () => new Promise(resolve => { releaseSteer = resolve; enteredSteer(); });
  const steering = host.send('s1', 'user steering', undefined, { messageId: 'user-steer' });
  await steerStarted;
  await assert.rejects(approve(), /turn changed/, 'user delivery in progress blocks new grants');
  releaseSteer({ status: 'accepted', method: 'steered' });
  assert.equal((await steering).steered, true);
  const afterSteer = await approve();
  assert.equal(afterSteer(), true, 'authorization resumes after user delivery');
  state.conn.receiveMessage = async message => {
    state.queue.push({ type: 'native-message-start', messageId: message.messageId, text: message.text });
    await sleep(25); return { status: 'accepted', method: 'queued' };
  };
  await host.deliverMessage('s1', { intent: 'normal', messageId: 'early-start', text: 'fast consumer' });
  assert.equal(host.getHistory('s1').messages.filter(m => m.id === 'early-start').length, 1, 'native start racing admission cannot append duplicate history');
  let nativeAdmissions = 0, releaseDuplicate;
  state.conn.receiveMessage = () => { nativeAdmissions++; return new Promise(resolve => { releaseDuplicate = resolve; }); };
  const duplicateMessage = { intent: 'normal', messageId: 'duplicate-native', text: 'one native request' };
  const duplicateFirst = host.deliverMessage('s1', duplicateMessage);
  const duplicateSecond = host.deliverMessage('s1', duplicateMessage);
  await waitUntil('native semantic admission', () => nativeAdmissions === 1);
  releaseDuplicate({ status: 'accepted', method: 'queued' });
  await Promise.all([duplicateFirst, duplicateSecond]);
  assert.equal(nativeAdmissions, 1, 'concurrent same-ID native requests submit only once');
  state.queue.push({ type: 'native-message-start', messageId: duplicateMessage.messageId, text: duplicateMessage.text });
  await sleep(25);
  const consumedAssistant = host.entries.get('s1').assistant;
  state.queue.push({ type: 'native-message-start', messageId: duplicateMessage.messageId, text: duplicateMessage.text });
  await sleep(25);
  assert.equal(host.entries.get('s1').assistant, consumedAssistant, 'duplicate native start cannot split or create a second assistant');
  assert.equal(host.getHistory('s1').messages.filter(m => m.id === duplicateMessage.messageId).length, 1);
  // 用户“立即”消息只接受真实 steered 回执；Harness 自己的 queued
  // 由工作台队列替代，不再模拟 native-message-start 消费边界。
  state.conn.receiveMessage = async () => ({ status: 'accepted', method: 'steered' });

  const beforeEarlyUser = desktopBegins.length;
  await host.send('s1', 'early user', undefined, { messageId: 'early-user' });
  assert.equal(desktopBegins.length, beforeEarlyUser + 1, '用户消息先于投递回执消费时仍须恢复桌面回合');
  assert.equal(desktopBegins.at(-1).userInstruction, true);
  state.conn.receiveMessage = async () => {
    state.queue.push({ type: 'turn-complete' });
    await sleep(35);
    return { status: 'accepted', method: 'steered' };
  };
  const ended = await host.deliverMessage('s1', { intent: 'interrupt', messageId: 'late-ack', text: 'priority' });
  assert.equal(ended.delivery, 'steered');
  assert.equal(host.isBusy('s1'), false, 'native receipt after turn end cannot create a phantom busy turn');
  state.queue.push({ type: 'native-message-start', messageId: 'stale-native-start', text: 'late' });
  await sleep(25);
  assert.equal(host.entries.get('s1').assistant, null, 'late native starts cannot manufacture an idle assistant');
  await host.close('s1');
}


async function testHarnessModelAdmissionLifecycle() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-model-admission-'));
  const { host, ctx } = makeHost(tmp);
  const { driver, state } = makeFakeDriver();
  driver.runtimeId = 'codex-gui';
  driver.describeModelParameters = async input => ({ runtimeId: 'codex-gui', providerId: 'codex-gui', modelId: input.modelOverride?.modelId || 'disabled', parameters: [] });
  host.registerDriver(driver);
  const model = modelId => ({ providerId: 'codex-gui', modelId });
  const catalog = () => ({ defaultModel: model('disabled'), items: [model('disabled'), model('allowed-a'), model('allowed-b')] });
  host.modelAdmission.catalog = async () => catalog();
  host.modelAdmission.selections.update('runtime:codex-gui', ['allowed-b', 'allowed-a']);
  const row = session('admission', { runtime: 'codex-gui' });
  ctx.__sessionsDb.set(row.id, row); openExecution(host, row);
  await host.validateLaunchModel('codex-gui', row.cwd, undefined);
  await host.validateLaunchModel('codex-gui', row.cwd, model('allowed-b'));
  await host.validateLaunchModel('pi', row.cwd, undefined);
  await host.validateLaunchModel('claude', row.cwd, undefined);
  assert.equal((await host.getModelParameters(row.id)).modelId, 'allowed-a', 'parameter metadata uses fallback model');
  await assert.rejects(() => host.validateLaunchModel('codex-gui', row.cwd, model('disabled')), /该模型已在设置中禁用.*allowed-b, allowed-a/);
  let set = await host.setSessionModel(row.id, model('disabled'));
  assert.equal(set.ok, false); assert.match(set.error, /该模型已在设置中禁用/);
  assert.equal(row.modelOverride, undefined, 'rejected setModel must not persist');
  set = await host.setSessionModel(row.id, model('allowed-b'));
  assert.equal(set.ok, true); assert.equal(row.modelOverride.modelId, 'allowed-b');
  const { ensureConnection } = require(path.join(root, 'src/main/agentSession/host/connection.ts'));
  const entry = host.entries.get(row.id);
  const selectedConnection = ensureConnection(host, entry); await sleep(25);
  assert.equal(state.inputs[0].modelOverride.modelId, 'allowed-b');
  state.resolveConnect(); await selectedConnection;
  await host.setSessionModel(row.id, null);
  const first = ensureConnection(host, entry); await sleep(25);
  assert.equal(state.connects, 2); assert.equal(state.inputs[1].modelOverride.modelId, 'allowed-a');
  state.resolveConnect(); await first;
  assert.equal(entry.connectionAdmissionModel.modelId, 'allowed-a');
  // Stored overrides pre-dating the setting must not bypass the connection path.
  row.modelOverride = model('disabled');
  await assert.rejects(() => ensureConnection(host, entry), /该模型已在设置中禁用/);
  assert.equal(state.connects, 2);
  row.modelOverride = undefined;
  host.modelAdmission.selections.update('runtime:codex-gui', []);
  await assert.rejects(() => host.validateLaunchModel('codex-gui', row.cwd, undefined), /至少选择一个模型/);
  assert.equal((await host.setSessionModel(row.id, model('allowed-a'))).ok, false);
  await assert.rejects(() => ensureConnection(host, entry), /至少选择一个模型/);
  host.modelAdmission.selections.update('runtime:codex-gui', null);
  await host.validateLaunchModel('codex-gui', row.cwd, undefined);
  assert.equal((await host.setSessionModel(row.id, model('disabled'))).ok, true, 'missing key is unrestricted');
  await host.close(row.id);

  // A selection edit while connect is pending must prevent the stale connection from being used.
  const race = session('admission-race', { runtime: 'codex-gui' });
  ctx.__sessionsDb.set(race.id, race); openExecution(host, race);
  host.modelAdmission.selections.update('runtime:codex-gui', ['allowed-a']);
  const pending = ensureConnection(host, host.entries.get(race.id)); await sleep(25);
  host.modelAdmission.selections.update('runtime:codex-gui', ['allowed-b']);
  state.resolveConnect();
  await assert.rejects(() => pending, /该模型已在设置中禁用/);
  assert.equal(host.entries.get(race.id).connection, null);
  assert.ok(state.closes >= 1, 'stale connection is reclaimed');
  await host.close(race.id);

  // A settings change after persistence must not turn a committed switch into a false failure.
  host.modelAdmission.selections.update('runtime:codex-gui', ['allowed-b']);
  const commitRace = session('admission-commit-race', { runtime: 'codex-gui' });
  ctx.__sessionsDb.set(commitRace.id, commitRace);
  const update = ctx.sessions.updateModelOverride;
  ctx.sessions.updateModelOverride = (id, value) => { update(id, value); host.modelAdmission.selections.update('runtime:codex-gui', []); };
  const committed = await host.setSessionModel(commitRace.id, model('allowed-b'));
  assert.equal(committed.ok, true); assert.match(committed.warning, /至少选择一个模型/);
  assert.equal(commitRace.modelOverride.modelId, 'allowed-b');
  ctx.sessions.updateModelOverride = update;

  let finishCatalog;
  host.modelAdmission.catalog = () => new Promise(resolve => { finishCatalog = resolve; });
  host.modelAdmission.selections.update('runtime:codex-gui', ['allowed-a']);
  const checking = host.validateLaunchModel('codex-gui', race.cwd, undefined); await sleep(10);
  host.modelAdmission.selections.update('runtime:codex-gui', ['allowed-b']);
  finishCatalog(catalog());
  await assert.rejects(() => checking, /模型设置在校验期间发生变化/);
}

async function testShutdownDrainsAllEntries() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-host-'));
  const { host } = makeHost(tmp);
  for (const id of ['broken', 'healthy']) openExecution(host, session(id));
  let healthyClosed = false;
  host.entries.get('broken').connection = { close: async () => { throw new Error('fixture close failed'); } };
  host.entries.get('healthy').connection = { close: async () => { healthyClosed = true; } };
  await assert.rejects(host.closeAll(), /GUI session shutdown failed/);
  assert.equal(healthyClosed, true, 'one failed driver must not skip the remaining connection');
  assert.equal(host.entries.size, 0);
  assert.throws(() => openExecution(host, session('late')), /shutting down/);
}

async function testDurableEventsBeforePublication() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-durable-live-'));
  const { host, ctx } = makeHost(tmp);
  const { push, persistEntry } = require(path.join(root, 'src/main/agentSession/host/base.ts'));
  const { attachPlanCard } = require(path.join(root, 'src/main/agentSession/host/plan.ts'));
  const meta = session('durable-live');
  ctx.__sessionsDb.set(meta.id, meta); openExecution(host, meta);
  const entry = host.entries.get(meta.id);
  const old = { id: 'old', role: 'assistant', ts: 1, parts: [], plan: { status: 'pending', active: true, steps: [], markdown: 'old' } };
  const current = { id: 'current', role: 'assistant', ts: 2, parts: [{ kind: 'text', text: '' }] };
  entry.messages = [old, current];
  persistEntry(host, entry, 'replace');
  let published = 0;
  let projectionAtPublication;
  const check = event => {
    if (event.kind !== 'delta') return;
    published++;
    projectionAtPublication = host.store.loadSnapshot(meta.id).messages[1].parts[0].text;
  };
  // Window send is intentionally observed outside the subscriber error guard.
  let seen;
  ctx.getWindow = () => ({ webContents: { send(_channel, event) { seen = event; check(event); } } });
  try {
    current.parts[0].text = 'accepted';
    push(host, { kind: 'delta', sessionId: meta.id, messageId: current.id, partIndex: 0, deltaKind: 'text', delta: 'accepted' });
    assert.equal(published, 1);
    assert.equal(projectionAtPublication, 'accepted', 'durable projection precedes live publication');
    assert.equal(host.store.loadSnapshot(meta.id).messages[1].parts[0].text, 'accepted');
    const originalRecord = host.store.recordDelta;
    host.store.recordDelta = () => { throw new Error('fixture append rejected'); };
    try {
      const before = seen;
      assert.throws(() => push(host, { kind: 'delta', sessionId: meta.id, messageId: current.id, partIndex: 0, deltaKind: 'text', delta: 'rejected' }), /fixture append rejected/);
      assert.equal(seen, before, 'failed durable acceptance must not publish');
    } finally { host.store.recordDelta = originalRecord; }
    attachPlanCard(host, entry, current, { status: 'pending', active: true, steps: [], markdown: 'new' });
    await host.store.flush();
    const { GuiSessionEventAdapter } = require(path.join(root, 'src/main/runtimeKernel/guiSession.ts'));
    const restored = new GuiSessionEventAdapter(tmp, meta.id, { messages: [], lastUsage: null, injections: [], compactions: [] }, () => false).snapshot();
    assert.equal(restored.messages[0].plan.active, false, 'superseded plan stays inactive after event-only cold replay');
    assert.equal(restored.messages[1].plan.active, true);
    assert.equal(restored.messages[1].parts[0].text, 'accepted');
  } finally {
    ctx.getWindow = () => null;
    await host.close(meta.id); host.flushPersist();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testCorruptSemanticJournalDoesNotBreakDriverEvents() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-semantic-corrupt-'));
  const { host, ctx } = makeHost(tmp);
  const { driver, state } = makeFakeDriver(); host.registerDriver(driver);
  const meta = session('s1');
  ctx.__sessionsDb.set(meta.id, meta);
  try {
    openExecution(host, meta); assert.equal((await host.send(meta.id, 'normal user turn')).ok, true);
    await waitUntil('semantic fixture connection requested', () => typeof state.resolveConnect === 'function');
    state.resolveConnect();
    await waitUntil('normal send before corrupt semantic journal', () => state.sends.length === 1);
    const journal = path.join(tmp, 'sessions', `semantic-${createHash('sha256').update(meta.id).digest('hex')}.ndjson`);
    fs.mkdirSync(path.dirname(journal), { recursive: true }); fs.writeFileSync(journal, '{broken journal}\n');
    const previous = host.entries.get(meta.id).assistant;
    state.queue.push({ type: 'native-message-start', messageId: 'native-with-broken-audit', text: 'native input' });
    await waitUntil('native split despite corrupt semantic journal', () => host.entries.get(meta.id).assistant !== previous);
    const entry = host.entries.get(meta.id);
    assert.equal(entry.messages.filter(message => message.id === 'native-with-broken-audit').length, 1);
    state.queue.push({ type: 'text-delta', delta: 'stream continues' });
    await waitUntil('driver pump continues after failed semantic fact', () => entry.assistant?.parts.some(part => part.kind === 'text' && part.text.includes('stream continues')));
    state.queue.push({ type: 'error', message: 'fatal fixture failure' });
    await waitUntil('driver error still settles the turn', () => !host.isBusy(meta.id));
    assert.ok(entry.messages.some(message => message.error?.includes('fatal fixture failure')));
  } finally { await host.close(meta.id); host.flushPersist(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function testGuiResumeWaitReceipts() {
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-resume-receipt-'));
  const { host, ctx } = makeHost(tmp);
  const { driver, state } = makeFakeDriver();
  const acknowledgements = [];
  ctx.resumeWait = { acknowledge: (owner, id) => acknowledgements.push([owner, id]) };
  host.registerDriver(driver);
  const row = session('resume-receipt'); openExecution(host, row);
  assert.equal(driver.deliveryCapabilities, undefined, 'ordinary send does not require a wake declaration');
  let drainSequence = 0;
  const begin = async label => {
    const previousSends = state.sends.length;
    const previousConnections = state.connects;
    const result = await host.send(row.id, label, undefined, { host: true, messageId: `resume-${label}`, requireIdle: true });
    assert.equal(result.ok, true);
    if (!host.entries.get(row.id).connection) {
      await waitUntil('resume receipt connection', () => state.connects > previousConnections);
      state.resolveConnect();
    }
    await waitUntil('resume receipt input dispatched', () => state.sends.length === previousSends + 1);
    return host.entries.get(row.id);
  };
  const drain = async entry => {
    const name = `drain-${++drainSequence}`;
    state.queue.push({ type: 'available-commands', commands: [{ name, description: '' }] });
    await waitUntil('resume receipt event drain', () => entry.slashCommands.some(command => command.name === name));
  };
  try {
    for (const [label, event] of [
      ['text', { type: 'text-delta', delta: 'received' }],
      ['thinking', { type: 'thinking-delta', delta: 'considering' }],
      ['tool', { type: 'tool-start', toolCallId: 'read-fixture', toolName: 'read', input: {} }],
      ['native-start', { type: 'turn-started', userMessageId: 'resume-native-start' }],
      ['silent-success', { type: 'turn-complete' }]
    ]) {
      const entry = await begin(label);
      const before = acknowledgements.length;
      const identity = { userMessageId: entry.lastTurnInput.userMessageId, assistantMessageId: entry.assistant.id };
      state.queue.push({ type: 'engine-input', identity, text: label });
      state.queue.push({ type: 'text-delta', delta: '' });
      state.queue.push({ type: 'thinking-delta', delta: '' });
      state.queue.push({ type: 'turn-started', userMessageId: `wrong-${label}` });
      await drain(entry);
      assert.equal(acknowledgements.length, before, `${label}: submitted text, metadata and wrong input IDs cannot confirm`);
      state.queue.push(event);
      await waitUntil(`${label} confirms current input`, () => acknowledgements.length > before);
      assert.deepEqual(acknowledgements[before], [row.id, identity.userMessageId]);
      if (event.type !== 'turn-complete') state.queue.push({ type: 'turn-complete' });
      await waitUntil(`${label} finishes`, () => !host.isBusy(row.id));
      assert.equal(acknowledgements.length, before + 1, `${label}: activity and completion confirm each input only once`);
    }
    const entry = await begin('invalid-state');
    const { handleEvent } = require(path.join(root, 'src/main/agentSession/host/events.ts'));
    const currentInput = entry.lastTurnInput.userMessageId;
    for (const [field, blocked] of [['closed', true], ['clearing', true], ['abortRequested', true], ['abortPreparing', true], ['lastSentPayload', null]]) {
      const original = entry[field], before = acknowledgements.length;
      entry[field] = blocked;
      handleEvent(host, entry, { type: 'turn-started', userMessageId: currentInput });
      handleEvent(host, entry, { type: 'text-delta', delta: 'late activity' });
      entry[field] = original;
      assert.equal(acknowledgements.length, before, `${field} cannot confirm a continuation`);
    }
    entry.assistant.error = 'failed before native acceptance';
    const beforeFailure = acknowledgements.length;
    state.queue.push({ type: 'turn-complete' });
    await waitUntil('failed turn terminal', () => !host.isBusy(row.id));
    assert.equal(acknowledgements.length, beforeFailure, 'an already failed turn is not a successful receipt');

    await begin('error');
    const beforeError = acknowledgements.length;
    state.queue.push({ type: 'error', message: 'fixture rejected input' });
    await waitUntil('rejected turn settles', () => !host.isBusy(row.id));
    assert.equal(acknowledgements.length, beforeError, 'errors do not confirm delivery');

    await begin('remote-cancel');
    const beforeCancel = acknowledgements.length;
    state.queue.push({ type: 'turn-complete', cancelled: true });
    await waitUntil('remote cancellation settles', () => !host.isBusy(row.id));
    assert.equal(acknowledgements.length, beforeCancel, 'remote cancellation without a local abort is not successful completion');

    for (const result of ['failed', 'aborted', 'pending']) {
      await begin(`terminal-${result}`);
      const beforeTerminal = acknowledgements.length;
      state.queue.push({ type: 'execution', state: { id: `execution-${result}`, revision: 1, at: Date.now(), result, process: 'released' } });
      state.queue.push({ type: 'turn-complete' });
      await waitUntil(`${result} terminal settles`, () => !host.isBusy(row.id));
      assert.equal(acknowledgements.length, beforeTerminal, `${result} execution cannot prove successful completion`);
    }

    await begin('disconnect');
    const beforeDisconnect = acknowledgements.length;
    state.queue.closed = true;
    await waitUntil('disconnected turn settles', () => !host.isBusy(row.id));
    assert.equal(acknowledgements.length, beforeDisconnect, 'event stream end is not successful completion');
  } finally {
    await host.close(row.id); host.flushPersist(); removeDesktopFixture(tmp, 'gui-resume-receipt-');
  }
}

async function testGuiResumeWaitOldConnectionReceipt() {
  const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'gui-resume-old-'));
  const { host, ctx } = makeHost(tmp);
  const old = makeFakeDriver(), replacement = makeFakeDriver();
  const acknowledgements = [];
  ctx.resumeWait = { acknowledge: (owner, id) => acknowledgements.push([owner, id]) };
  const connect = old.driver.connect.bind(old.driver);
  old.driver.connect = input => old.state.connects ? replacement.driver.connect(input) : connect(input);
  host.registerDriver(old.driver);
  const row = session('resume-old'); openExecution(host, row);
  try {
    await host.send(row.id, 'first', undefined, { host: true, messageId: 'resume-old-input' });
    await waitUntil('old receipt connection', () => old.state.resolveConnect);
    old.state.resolveConnect();
    await waitUntil('old receipt dispatch', () => old.state.sends.length === 1);
    // Keep the retired source alive to exercise the actual event-pump identity gate.
    old.state.conn.abort = async () => { old.state.aborts += 1; };
    old.state.conn.close = async () => { old.state.closes += 1; };
    await host.abort(row.id);
    assert.deepEqual(acknowledgements, [], 'abort itself is not a native receipt');
    await host.send(row.id, 'replacement', undefined, { host: true, messageId: 'resume-new-input' });
    await waitUntil('replacement receipt connection', () => replacement.state.resolveConnect);
    replacement.state.resolveConnect();
    await waitUntil('replacement receipt dispatch', () => replacement.state.sends.length === 1);
    old.state.queue.push({ type: 'turn-started', userMessageId: 'resume-new-input' });
    old.state.queue.push({ type: 'text-delta', delta: 'late old connection output' });
    old.state.queue.push({ type: 'turn-complete' });
    await waitUntil('old source rejected by pump', () => old.state.queue.items.length < 3);
    assert.deepEqual(acknowledgements, [], 'even a matching input ID from a retired connection cannot confirm');
    replacement.state.queue.push({ type: 'turn-complete' });
    await waitUntil('replacement success receipt', () => acknowledgements.length === 1);
    assert.deepEqual(acknowledgements, [[row.id, 'resume-new-input']]);
  } finally {
    old.state.queue && (old.state.queue.closed = true);
    await host.close(row.id); host.flushPersist(); removeDesktopFixture(tmp, 'gui-resume-old-');
  }
}

async function testBackgroundSessionCloseBarrier() {
  for (const mode of ['live', 'cold', 'failure']) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-background-close-'));
    const { host, ctx } = makeHost(tmp);
    const row = session(`background-${mode}`); ctx.__sessionsDb.set(row.id, row);
    let finished, failed, retired = false, released = false;
    ctx.bgTasks = { killAllForSessionAndWait(id) {
      assert.equal(id, row.id);
      return new Promise((resolve, reject) => { finished = resolve; failed = reject; });
    } };
    if (mode !== 'cold') {
      openExecution(host, row);
      host.entries.get(row.id).connection = { close: async () => { retired = true; } };
    }
    const release = host.store.release.bind(host.store);
    host.store.release = async id => { released = true; return release(id); };
    let settled = false;
    const closing = host.close(row.id);
    const observed = closing.then(() => { settled = true; }, error => { settled = true; throw error; });
    const expected = mode === 'failure' ? assert.rejects(observed, /background owner failed/) : observed;
    await sleep(20);
    assert.equal(settled, false, `${mode}: close waits for background resources`);
    if (mode !== 'cold') assert.equal(retired, true, 'driver retirement starts before the background drain settles');
    if (mode === 'failure') failed(Error('background owner failed')); else finished();
    await expected;
    assert.equal(released, true, `${mode}: persistence release is always attempted`);
    if (mode !== 'cold') assert.equal(retired, true, `${mode}: driver retirement is always attempted`);
    await host.closeAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const tests = [
  ['workbench remote binding uses an existing GUI turn and queues desktop interjections', testWorkbenchRemoteExistingGuiTurn],
  ['messaging Session uses scoped literal remote authority', testMessagingSessionUsesLiteralRemoteAuthority],
  ['messaging result files distinguish fast receipt from replay and disclose unfinished files', testMessagingArtifactReceiptBoundary],
  ['GUI 续接回执：无能力声明的有效活动和无输出成功，拒绝伪回执', testGuiResumeWaitReceipts],
  ['GUI 续接回执：中止后的旧连接不能确认新输入', testGuiResumeWaitOldConnectionReceipt],
  ['后台资源关闭屏障（活视图/冷视图/失败继续清理）', testBackgroundSessionCloseBarrier],
  ['坏语义日志不阻断native-start和driver错误收口', testCorruptSemanticJournalDoesNotBreakDriverEvents],
  ['持久事实先于发布、拒绝追加不推送、旧计划卡失效持久恢复', testDurableEventsBeforePublication],
  ['退出等待所有连接，单个失败不阻断清理，拒绝迟到打开', testShutdownDrainsAllEntries],
  ['桌面回合：附件处理中停止后旧消息不得恢复操作', testDesktopAttachmentAcceptedBeforeStopCannotResume],
  ['桌面回合：停止前排队的消息不得恢复操作', testDesktopQueuedBeforeStopCannotResume],
  ['桌面回合：自动注入不得当作用户恢复指令', testDesktopInjectedMessagesAreNotUserInstructions],
  ['模型白名单：创建、切换、旧覆盖重连与连接期间设置变化', testHarnessModelAdmissionLifecycle],
  ['原生邮箱意图：插话不abort、不占宿主队列、可信身份与去重', testNativeMailboxIntent],
  ['邮箱宿主唤醒：忙时拒绝排队/插话、固定身份去重与恢复',testMailboxWakeAdmission],
  ['GUI 首信正文、匹配的原生回执与独立已读', testInitialAssignmentNativeReceipt],
  ['Worker 跨 Harness 交接：已结算额度失败、同任务与全文续页', () => testWorkerRouteNativeHandoff('settled')],
  ['Worker 跨 Harness 交接：提交结果未知的 429 停止切换', () => testWorkerRouteNativeHandoff('unknown')],
  ['Worker 跨 Harness 交接：未结算的工具阻止切换', () => testWorkerRouteNativeHandoff('open-tool')],
  ['Worker 跨 Harness 交接：回收期间用户停止后不启动替换', () => testWorkerRouteNativeHandoff('cancel')],
  ['Worker 跨 Harness 交接：原子保存失败保持旧引擎与标识', () => testWorkerRouteNativeHandoff('write-failure')],
  ['Worker 跨 Harness 交接：回收期间权限变化不带到替换引擎', () => testWorkerRouteNativeHandoff('mode-race')],
  ['Worker 跨 Harness 交接：回收期间原生设置变化使旧尝试失效', () => testWorkerRouteNativeHandoff('native-race')],
  ['Worker 跨 Harness 交接：Core 受限模式不自动改用外部权限', () => testWorkerRouteNativeHandoff('restricted-core')],
  ['Worker 跨 Harness 交接：Core 全访问仍不能证明外部目录权限等价', () => testWorkerRouteNativeHandoff('core-full-cross')],
  ['Worker 跨 Harness 交接：外部原生权限不会转移至另一个引擎', () => testWorkerRouteNativeHandoff('native-policy')],
  ['Worker 跨 Harness 交接：用户授权后 Codex 沿用同一任务和已核验权限', () => testWorkerRouteNativeHandoff('authorized')],
  ['Worker 跨 Harness 交接：已授权候选的原生版本变化使授权失效', () => testWorkerRouteNativeHandoff('authorized-stale')],
  ['Worker 跨 Harness 交接：进入 Codex 后其它候选仍须自身授权', () => testWorkerRouteNativeHandoff('authorized-next-unbound')],
  ['Worker 跨 Harness 交接：用户候选授权不能覆盖委派父权限', () => testWorkerRouteNativeHandoff('authorized-child')],
  ['Worker 跨 Harness 交接：首信无投递证据时保留排队输入', () => testWorkerRouteNativeHandoff('unconfirmed-assignment')],
  ['回合结果与执行资源独立，回收失败不解锁队列', testExecutionOwnership],
  ['条件历史：大消息省略、小元数据新鲜、全部推送与失败落盘先失效、过渡态全量', testConditionalHistoryVersion],
  ['条件历史：真实工具/排队编辑、同entry清空、无entry恢复与重开新代际', testConditionalHistoryEditsAndGenerations],
  ['恢复信封一次读取，v1/消毒/元数据保真且外改下次可见', testSingleReadHistorySnapshot],
  ['恢复快照缺省、坏字段、v2未知字段与损坏诊断兼容', testSnapshotDefaultsAndCompat],
  ['fork 不继承原会话文件回退权限', testForkDropsTurnSnapshots],
  ['fork 附件复制失败回收空壳新会话（F-01）', testForkAttachmentFailureRecyclesShell],
  ['GUI send IPC → 回合状态，10 分钟静默与明确完成', testBoardExecutionSignals],
  ['参数提交只返回已校验快照，提交后目录/会话变化不伪报失败', testModelParameterCommitBoundary],
  ...acpParameterProfileScopeCases.map(scenario => [`ACP 模型参数范围：${scenario.label}`, () => testAcpModelParameterProfileScope(scenario)]),
  ['旧思考 IPC 兼容通用映射与清除，不产生双重真源', testLegacyThinkingParameterMigration],
  ['目录失效与清理中消息在受理前拒绝，历史/队列/连接/使用时间不变', testUnavailableWorkspaceMessageRefusal],
  ['目录快照连接重建、运行期固定与全部根依赖释放', testWorkspaceContextLifecycle],
  ['Codex GUI 与后台工具使用隔离 cwd，分支改变时拒绝发消息', testCodexExecutesInWorktree],
  ['权限配置默认 auto + ask/acceptEdits 迁移', testDefaultModeAuto],
  ['权限配置 Core 投影会话重读已提交的标准档并推送冷态与活态', testCorePermissionProjection],
  ['权限配置原生批准、取消、普通提问、切换和恢复失败', testPermissionOptIn],
  ['权限配置计划批准及手动转自动的回灌', testAutomaticPlanApproval],
  ['权限配置 OMP 重启恢复 launch-only 原生选择', testOmpLaunchOnlyPermissionRestore],
  ['connecting 期 abort', testAbortDuringConnecting],
  ['旧 prepare 迟到结果不得终止重发后的新回合', testLatePrepareFailureDoesNotFinishReplacement],
  ['基线准备无限期挂起不阻塞引擎发送与收口', testHangingPreparationNeverBlocksEngine],
  ['connecting 期 close 回收', testCloseDuringConnecting],
  ['审批锚点 + error 收口终态化', testApprovalAnchorAndErrorSettle],
  ['队列派发与 queued 清除', testQueueDispatch],
  ['中断后发送保留队列并摘掉原条目', testAbortHoldQueueForSteerFallback],
  ['GuiSessionStore：损坏 JSON 降级为空', testStoreCorruptJson],
  ['busy 续发 steer vs queue', testSteerVsQueue],
  ['用户插话能力门控不提交 Harness native queue', testUserSteerCapabilityGate],
  ['steer 切开转写回合', testSteerSplitsTranscriptTurn],
  ['外部会话拒绝旧工作台权限且不写持久层', testExternalLegacyModeRejected],
  ['原生设置待确认值可分别撤回且校验 revision', testNativePendingSettings],
  ['setModel idle/运行中/快照拒绝', testSetModelThreeStates],
  ['Pi 服务商配置：同 ID 执行设置下轮生效，显示与无关设置不重连', () => testPiProviderConfigurationLifecycle()],
  ['Pi 服务商配置：connect 等待期变化回收旧连接且重试使用新配置', () => testPiProviderConfigurationLifecycle(true)],
  ['Pi 服务商配置：连接已就绪后技能准备期变化仍拦截发送', () => testPiProviderConfigurationLifecycle('skill')],
  ['网络错误自动续作（无进度重发）', testNetworkErrorRetriesThenContinues],
  ['网络续作重发用展开后的存档 payload', testResendSendsExpandedSkillPayload],
  ['steer await 期间回合收口 → 回落开新回合', testSteerFallsBackWhenTurnClosesDuringExpand],
  ['压缩事件→信封+推送（willRetry/失败/恢复）', testCompactionEnvelopeAndPush],
  ['网络错误有进度则续作提示', testNetworkErrorContinueAfterProgress],
  ['续作用尽上报 network_error', testNetworkErrorExhaustReportsOutcome],
  ['用户停止取消网络续作', testUserAbortDoesNotRetryNetworkError],
  ['非多模态模型带图拒绝且文案正确', testRejectImagesWhenModelLacksSupport],
  ['会话覆盖到非多模态后带图拒绝', testRejectImagesWhenOverrideLacksSupport],
  ['行内编辑保留随文图片并出队透传', testEditQueuedPreservesImages],
  ['插话注入失败回队并在回合结束送达（M-7）', testSteeringFailedRequeue],
  ['插话失败回队遇队列满：error 回执可见（F-02）', testSteeringFailedQueueFullErrorReceipt],
  ['手动重试复用用户消息、替换失败 assistant', testManualRetryReusesUserMessage],
  ['重新编辑终止消息移除该轮并返回原文本与图片', testRecallAbortedRemovesTurnAndReturnsDraft],
  ['turn-complete summary 盖 assistant.harness', testTurnCompleteSummaryStampsHarness],
  ['空转回合守卫：空输出收口必须标错误', testEmptyTurnGuard],
  ['宿主说明仅首次投递（失败、命令、重连、重启、清空、旧会话）', testHostIntroOnlyOnFirstNativeTurn],
  ['注入快照入信封（去重/换代/恢复）', testInjectionSnapshotEnvelope],
  ['旧会话兼容（无信封/坏信封/新字段保留）', testLegacySessionCompat]
];

let failed = 0;
const filter = process.env.MUSTER_GUI_LIFECYCLE_FILTER;
const selected = filter ? tests.filter(([name]) => name.includes(filter)) : tests;
if (!selected.length) throw new Error(`No GUI lifecycle test matches: ${filter}`);
for (const [name, fn] of selected) {
  try {
    await fn();
    console.log(`  ok ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.stack?.split('\n').slice(0, 6).join('\n    ')}`);
  }
}
if (failed > 0) {
  console.error(`gui-host-lifecycle: ${failed}/${tests.length} failed (electron stubbed ×${electronCalls})`);
  process.exit(1);
}
console.log(`gui-host-lifecycle: ok (${selected.length} 组, electron stubbed ×${electronCalls})`);
