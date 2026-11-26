/** Real session factory: a fork retains its source configuration without refreshing catalogs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const originalLoad = Module._load;
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => root, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const { createAgentTerminalSession } = require('../src/main/sessions/createTerminal.ts');
const { resolveSessionTarget } = require('../src/main/sessions/targets.ts');
const { forkSession } = require('../src/main/agentSession/host/sessionOps.ts');
const { SessionsService } = require('../src/main/sessions.ts');
const { registerCanvasLinkIpc } = require('../src/main/canvasLink.ts');
const { invokeIpcChannel } = require('../src/main/ipc/handle.ts');
const { applyLocaleSetting } = require('../src/shared/i18n/index.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fork-config-'));
try {
  const cfg = { workspace: root, activeWorkspaceId: 'ws', defaultRuntime: 'pi', workspaces: [{ id: 'ws', path: root }] };
  const source = { id: 'source', type: 'terminal', launchKind: 'agent', name: 'DeepSeek', runtime: 'acp', workspaceId: 'ws', cwd: root,
    piModeId: 'deepseek', guiMode: 'ask', modelOverride: { providerId: 'acp', modelId: 'deepseek-model' }, modelParameters: { reasoning: 'high' } };
  const rows = [source];
  let modelChecks = 0, parameterChecks = 0;
  const context = { config: { get: () => cfg }, runtimes: { get: () => ({ enabled: true }) }, sessions: rows,
    isChatRuntime: runtime => ['acp', 'pi', 'codex-gui'].includes(runtime), notify: { push() {} }, usageStats: null,
    agentSessionsRef: {
      validateLaunchModel: async () => { modelChecks++; throw new Error('尚未读取模型目录，请手动刷新'); },
      validateLaunchParameters: async () => { parameterChecks++; throw new Error('尚未读取模型目录，请手动刷新'); },
      probeRuntime: async () => ({ status: 'available', problems: [] })
    }, applySelectDisplay() {}, persist() {}, broadcast() {}, get: id => rows.find(row => row.id === id),
    async launchTerminal() {} };
  const target = await resolveSessionTarget(cfg, { workspaceId: 'ws', cwd: root }, source);
  const opts = { runtime: 'acp', sourceSessionId: source.id, inheritSourceGuiConfig: true, force: true, activate: false };
  const fork = await createAgentTerminalSession(context, opts, target);
  assert.equal(fork.piModeId, 'deepseek');
  assert.equal(fork.guiMode, undefined, 'a legacy ACP GUI mode is not native permission configuration');
  assert.deepEqual(fork.modelOverride, source.modelOverride);
  assert.deepEqual(fork.modelParameters, source.modelParameters);
  assert.equal(modelChecks, 0, 'inherited settings do not start or demand a fresh model catalog');
  assert.equal(parameterChecks, 0);
  // The real GUI host fork path must actually prepare the copied history and
  // transcript before the real session factory publishes the new row.
  const pending = new Map(), snapshots = new Map();
  const sourceMessage = { id: 'm', role: 'user', parts: [{ kind: 'text', text: '原会话任务' }], ts: 1 };
  const entry = { sessionId: source.id, runtimeId: 'acp', cwd: root, workspaceId: 'ws', messages: [sourceMessage], busy: false };
  const host = { openedSessionIds: new Set([source.id]), entries: new Map([[source.id, entry]]), drivers: new Map([['acp', { supportsNativeFork: false, supportsSeed: false }]]),
    ctx: { sessions: { get: id => rows.find(row => row.id === id),
      createTerminal: options => createAgentTerminalSession(context, { ...options, force: true }, target) } },
    store: { beginForkPreparation() {}, finishForkPreparation() {}, createForkContext: (id,seeds) => { const values=[...seeds]; return {count:values.length,values}; }, loadRangeSnapshot: (id,before,limit) => ({messages:snapshots.get(id).slice(before-limit,before)}), savePendingFork: (id, value) => pending.set(id, structuredClone(value)),
      saveHostIntroDelivery() {}, saveForkPrefix: async (id, value) => snapshots.set(id, structuredClone([...value])), clearPendingFork: id => pending.delete(id), delete: () => {} } };
  const forkResult = await forkSession(host, source.id);
  assert.equal(forkResult.ok, true, forkResult.error);
  const hostChild = rows.find(row => row.id === forkResult.sessionId);
  assert.equal(hostChild.piModeId, 'deepseek');
  assert.deepEqual(hostChild.modelOverride, source.modelOverride);
  assert.equal(snapshots.get(hostChild.id)[0].parts[0].text, '原会话任务');
  assert.equal(pending.get(hostChild.id).transcript.values[0].text, '原会话任务');
  assert.equal(modelChecks, 0, 'the host fork does not require a model catalog');
  const denied = { ok: false, error: '会话正在接收消息，请稍后再分叉' };
  const creationFailure = new Error('交接文档目录不是受管目录');
  let canvasMessageCount = 1;
  registerCanvasLinkIpc({ sessions: { get: id => rows.find(row => row.id === id), createTerminal: async () => { throw creationFailure; } }, runtimes: { get: () => ({ surface: 'chat' }) },
    agentSessions: { open() {}, messageCount: () => canvasMessageCount, forkSession: async () => denied } });
  applyLocaleSetting('en');
  try {
    await assert.rejects(invokeIpcChannel('sessions:canvasFork', [source.id]), /The session is receiving a message\. Wait before forking\./);
    assert.equal(denied.error, '会话正在接收消息，请稍后再分叉');
    denied.error = '分叉期间源会话已变化，请重试（已创建原生会话 native-1）';
    await assert.rejects(invokeIpcChannel('sessions:canvasFork', [source.id]), /The source session changed during the fork\. Try again\. \(Native session native-1 was created\)/);
    assert.equal(denied.error, '分叉期间源会话已变化，请重试（已创建原生会话 native-1）');
    canvasMessageCount = 0;
    await assert.rejects(invokeIpcChannel('sessions:canvasFork', [source.id]), /The handover document directory is not a managed directory\./);
    assert.equal(creationFailure.message, '交接文档目录不是受管目录');
  } finally { applyLocaleSetting('zh-CN'); }
  for (const [runtime, preset, model] of [
    ['acp', 'kimi', { providerId: 'acp', modelId: 'kimi-model' }],
    ['acp', 'opencode', { providerId: 'acp', modelId: 'opencode-model' }],
    ['pi', 'creator', { providerId: 'provider', modelId: 'model' }],
    ['codex-gui', undefined, { providerId: 'codex-gui', modelId: 'model' }]
  ]) {
    const other = { ...source, id: `source-${runtime}-${preset ?? 'default'}`, runtime, piModeId: preset,
      guiMode: undefined, modelOverride: model, modelParameters: undefined };
    rows.push(other);
    const copy = await createAgentTerminalSession(context, { runtime, sourceSessionId: other.id,
      inheritSourceGuiConfig: true, force: true }, target);
    assert.equal(copy.piModeId, preset);
    assert.deepEqual(copy.modelOverride, model);
    rows.splice(rows.indexOf(copy), 1); rows.splice(rows.indexOf(other), 1);
  }
  assert.equal(modelChecks, 0, 'the same inheritance rule covers different GUI harnesses');
  // Resuming after a restart has the same absent per-cwd model catalog as a
  // fork. Exercise the real resume orchestration and the real session factory.
  source.interruptSnapshot = { interruptedAt: 1, lastActivityAt: 1, uncommitted: [], worktreeClean: true };
  const resume = {
    ...context,
    createTerminal: options => createAgentTerminalSession(context, { ...options, force: true }, target)
  };
  const resumed = await SessionsService.prototype.resumeInterrupted.call(resume, source.id);
  assert.deepEqual(resumed.session.modelOverride, source.modelOverride);
  assert.deepEqual(resumed.session.modelParameters, source.modelParameters);
  assert.equal(resumed.session.piModeId, source.piModeId);
  assert.equal(resumed.session.guiMode, undefined, 'external harness never inherits a legacy host permission mode');
  assert.equal(modelChecks, 0, 'resuming inherited settings does not require a model catalog');
  assert.equal(parameterChecks, 0);
  await assert.rejects(createAgentTerminalSession(context, { ...opts, sourceSessionId: 'missing' }, target), /source/i);
  await assert.rejects(createAgentTerminalSession(context, { ...opts, runtime: 'pi' }, target), /source|runtime/i);
  await assert.rejects(createAgentTerminalSession(context, { ...opts, inheritMeta: { piModeId: 'kimi' } }, target), /source/i);
  context.agentSessionsRef.assertLaunchModelAllowed = () => { source.modelOverride = { providerId: 'acp', modelId: 'changed' }; };
  const count = rows.length;
  await assert.rejects(createAgentTerminalSession(context, opts, target), /变化|changed/i);
  assert.equal(rows.length, count, 'source configuration changed during async preflight: publish nothing');
  // A stored source override disabled before a fork is rejected without catalog discovery.
  context.agentSessionsRef.assertLaunchModelAllowed = (_runtime, model) => {
    if (model?.modelId === 'changed') throw new Error('disabled model');
  };
  const beforeBlockedFork = rows.length;
  await assert.rejects(createAgentTerminalSession(context, opts, target), /disabled model/);
  assert.equal(rows.length, beforeBlockedFork, 'disabled inherited override must not publish a fork');

  // Selection can change during asynchronous setup: validate again before publication.
  let checks = 0;
  const freshContext = { ...context, agentSessionsRef: {
    ...context.agentSessionsRef,
    assertLaunchModelAllowed() {},
    validateLaunchModel: async () => { if (++checks === 2) throw new Error('disabled during creation'); },
    validateLaunchParameters: async () => undefined
  } };
  const beforeRacingCreate = rows.length;
  await assert.rejects(createAgentTerminalSession(freshContext, { runtime: 'codex-gui', force: true }, target), /disabled during creation/);
  assert.equal(checks, 2);
  assert.equal(rows.length, beforeRacingCreate, 'changed selection must not publish a session');
  console.log('canvas-fork-source-config: exact source identity and inherited launch settings passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
