/** Real tasks host -> delegate -> session builder, with LLM/brief/task-store resource boundaries stubbed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-role-delegation-'));
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const originalLoad = Module._load;
let tracked = 0, taskStoreFails = false;
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file
}).outputText, file);
Module._load = function(request, parent) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  if (parent?.filename === path.join(root, 'src/main/tasks/delegate.ts')) {
    if (request === '../messages/assignment') return { resumeLegacyGuiAssignment: () => undefined, sendSessionMail: async (_ctx,args) => ({stored:true,messageId:'fixture-mail',text:args.text}) };
    if (request === '../capabilities/hosts/chat') return { buildBriefWithNamedSkills: async (_ctx, _id, text) => ({ brief: text, vocab: [] }), waitTerminalReady: async () => {} };
    if (request === '../metaAgent/sessionAgentTask') return { createClaimedAgentTaskForSession: async (_ctx, session, input) => {
      tracked++; if (taskStoreFails) throw new Error('fixture task store unavailable');
      return { ok: true, task: { id: 'task', title: input.title, status: 'in_progress', assignee: session.id, note: input.note } };
    } };
  }
  return originalLoad.apply(this, arguments);
};
try {
  const { createSessionWithTask } = require(path.join(root, 'src/main/capabilities/hosts/creation.ts'));
  const { delegateTask } = require(path.join(root, 'src/main/tasks/delegate.ts'));
  const { runAsAgentSession } = require(path.join(root, 'src/main/agent/agentScope.ts'));
  const { buildAgentTerminalSession } = require(path.join(root, 'src/main/sessions/createTerminal.ts'));
  const parent = { id: 'parent', name: '父', workspaceId: 'w', type: 'terminal', runtime: 'pi', lifecycle: 'idle' };
  const rows = new Map([[parent.id, parent]]), created = [];
  const cfg = { activeWorkspaceId: 'w', defaultRuntime: 'pi', workspaces: [{ id: 'w', path: tmp }] };
  const ctx = { config: { get: () => cfg }, resolveBubbleWorkspaceId: () => 'w',
    sessions: { get: id => rows.get(id), list: () => [...rows.values()], listByWorkspace: () => [...rows.values()], isChatRuntime: () => true,
      injectStrategy: async () => 'initial-prompt', ensureStatusToken() {}, clearDonePhase() {}, setLiveStatus() {},
      createTerminal: async opts => {
        created.push(opts);
        const session = buildAgentTerminalSession({ id: `c-${created.length}`, now: 1, statusToken: 'token', inWs: 0, ...opts });
        rows.set(session.id, session); return session;
      }
    }, agentSessions: { send: async () => ({ ok: true }), isOpen: () => true }
  };
  const invoke = args => runAsAgentSession('parent', () => createSessionWithTask(ctx, { asSubagent: true, isolation: 'shared', select: false, ...args }));
  // F-04：显式 characterId 只剩内部可信路径（creationKey 重放/队列重入直调 delegateTask），白名单校验不变
  let result = await runAsAgentSession('parent', () => delegateTask(ctx, {
    task: '优化 UI 布局', characterId: 'pixel', name: '按钮布局', parentSessionId: 'parent', isolate: false, select: false, notifyOrchestrator: false }));
  assert.equal(result.status, 'started'); assert.equal(result.session.subagentCharacterId, 'pixel');
  assert.equal(result.session.name, '像素 · 按钮布局'); assert.equal(result.session.parentSessionId, 'parent');
  assert.equal(created[0].subagentCharacterId, 'pixel');
  assert.equal(tracked, 0, '默认创建普通会话，不触碰共享任务表');
  assert.equal(result.agentTask, undefined);
  const grandchild = { ...parent, id: 'grandchild', parentSessionId: 'deep-child' };
  rows.set('deep-child', { ...parent, id: 'deep-child', parentSessionId: parent.id }); rows.set(grandchild.id, grandchild);
  result = await runAsAgentSession(grandchild.id, () => createSessionWithTask(ctx, {
    asSubagent: true, task: '第四层仍是普通会话', isolation: 'shared', select: false }));
  assert.equal(result.session.parentSessionId, grandchild.id, '不再拒绝孙代理派子代理');
  rows.clear(); rows.set(parent.id, parent);
  result = await invoke({ task: '审计安全权限漏洞' });
  assert.equal(result.session.subagentCharacterId, 'rivet'); assert.ok(result.session.name.startsWith('铆钉 · '), 'no explicit role: host round robin, never task keywords');
  // F-04：模型面（sessions.create 处理链）硬猜 characterId 指定角色被拒收
  // （createSessionWithTask 同步抛出，须用 async 箭头把同步异常转成 rejection）
  await assert.rejects(async () => invoke({ task: 'x', characterId: 'pixel' }), /不接受 characterId/);
  // F-03：creationKey 复用已建会话的重试不空转轮选游标（旧代子会话无角色快照场景）
  rows.set('legacy-retry', { ...parent, id: 'legacy-retry', parentSessionId: 'parent', cwd: tmp, meta: { creationKey: 'retry-key' } });
  const reused = await delegateTask(ctx, { task: '恢复旧任务', creationKey: 'retry-key', parentSessionId: 'parent', isolate: false, select: false, notifyOrchestrator: false });
  assert.equal(reused.session.id, 'legacy-retry');
  assert.equal(reused.session.name, '父', '复用分支不改会话名');
  assert.equal(reused.session.subagentCharacterId, undefined, '复用分支不写回新角色');
  result = await invoke({ task: '游标探针' });
  assert.equal(result.session.subagentCharacterId, 'quantum', 'F-03：creationKey 重试不推进轮选游标');
  const before = created.length;
  await assert.rejects(() => runAsAgentSession('parent', () => delegateTask(ctx, { task: 'x', characterId: 'bogus', parentSessionId: 'parent', isolate: false })), /未知子代理角色/);
  await assert.rejects(() => delegateTask(ctx, { task: 'x', characterId: 'pixel', isolate: false }), /仅用于子代理/);
  assert.equal(created.length, before, '非法角色必须在建立资源前拒绝');
  console.log('subagent-role-delegation: internal explicit role, model-args characterId rejected, host round robin, retry keeps cursor, fail-before-create passed');
} finally { Module._load = originalLoad; fs.rmSync(tmp, { recursive: true, force: true }); }
