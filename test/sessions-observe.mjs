/** Common observation: honest completion, trusted scope, read-only paging, PTY boundary. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep compiled ESM under the checkout so runtime imports resolve its actual
// dependencies (including playwright-core); only Electron is deliberately stubbed.
const tempRoot = path.join(root, '.tmp');
fs.mkdirSync(tempRoot, {recursive:true});
const tmp = fs.mkdtempSync(path.join(tempRoot, 'sessions-observe-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const load = async p => import(pathToFileURL(compile(p)).href);
  // This integration import graph uses both WS default and named ESM exports;
  // the pure shared compiler's CJS default-only shim cannot provide the latter.
  const require=createRequire(import.meta.url);
  const wsDir=path.join(tmp,'node_modules','ws');
  fs.writeFileSync(path.join(wsDir,'package.json'),JSON.stringify({name:'ws',type:'module',main:'index.mjs'}));
  fs.writeFileSync(path.join(wsDir,'index.mjs'),`import ws from ${JSON.stringify(pathToFileURL(require.resolve('ws')).href)};
    export default ws;export const WebSocket=ws.WebSocket,WebSocketServer=ws.WebSocketServer;`);

  // Main-process fixtures can import electron before the scheduler-specific
  // assertions below, so seed the native-module shim before the first load.
  const electronDir = path.join(tmp, 'node_modules/electron'); fs.mkdirSync(electronDir, { recursive: true });
  fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electronDir, 'index.mjs'), `
    export const app = {getPath:()=>${JSON.stringify(tmp)}};
    const unavailable = new Proxy({}, {get(_target,key){throw new Error('Observation fixture must not use Electron '+String(key));}});
    // Complete runtime named-import set from src/main Electron imports. Every
    // capability remains fail-closed if observation unexpectedly invokes it.
    export const BrowserWindow=unavailable,Menu=unavailable,Notification=unavailable,Tray=unavailable,
      clipboard=unavailable,crashReporter=unavailable,desktopCapturer=unavailable,dialog=unavailable,ipcMain=unavailable,
      nativeImage=unavailable,nativeTheme=unavailable,net=unavailable,powerMonitor=unavailable,powerSaveBlocker=unavailable,
      protocol=unavailable,safeStorage=unavailable,screen=unavailable,session=unavailable,shell=unavailable,webContents=unavailable;
  `);
  const { observeReply, observeSchedulerReply, sessionObservation, OBSERVE_REPLY_CHARS } = await load('shared/sessionObservation.ts');
  const msg = (id, role, text, extra = {}) => ({ id, role, ts: 20, parts: [{ kind: 'text', text }], ...extra });
  const messages = [msg('done', 'assistant', '完成的回复', { finishedAt: 30 }),
    msg('u', 'user', '新追问'), msg('stream', 'assistant', '尚未完成')];
  const original = JSON.stringify(messages);
  assert.equal(observeReply(messages, 'stream').messageId, 'done', '用户追问或流式回复不能覆盖上轮完成回复');
  assert.equal(observeReply(messages, 'stream').status, 'completed');
  assert.equal(observeReply(messages, 'stream').finishedAt, 30);
  assert.equal(observeReply([msg('legacy', 'assistant', '旧历史')]).status, 'unknown', '无收口证据不能猜成完成');
  assert.equal(observeReply([msg('stream', 'assistant', 'partial')], 'stream'), null);
  assert.equal(observeReply([msg('e', 'assistant', '', { finishedAt: 40, error: 'auth denied' })]).status, 'error');
  assert.equal(observeReply([msg('a', 'assistant', 'partial', { finishedAt: 40, aborted: true })]).status, 'aborted');
  const large = observeReply([msg('large', 'assistant', 'x'.repeat(10_000), { finishedAt: 40 })]);
  assert.equal(large.text.length, OBSERVE_REPLY_CHARS); assert.equal(large.totalChars, 10_000); assert.equal(large.truncated, true);
  const escaped = observeReply([msg('escape', 'assistant', '\u0000'.repeat(6000), { finishedAt: 40, error: '\u0001'.repeat(1000) })]);
  assert.ok(JSON.stringify(escaped).length < 8000, '控制字符与转义膨胀仍受 JSON 返回预算约束');
  assert.equal(escaped.truncated, true);
  assert.equal(observeReply([msg('private', 'assistant', '', { finishedAt: 40,
    parts: [{ kind: 'thinking', text: 'private reasoning' }, { kind: 'tool', tool: { output: 'secret' } }] })]).text, '');
  const chunks = [{ kind: 'text', text: 'Investig' }, { kind: 'text', text: 'ating' }];
  const separated = [...chunks, { kind: 'tool', tool: { output: 'private tool output' } },
    { kind: 'thinking', text: 'private reasoning' }, { kind: 'text', text: 'Fixed' }, { kind: 'text', text: ' it.' }];
  const observation = observeReply([msg('blocks', 'assistant', '', { finishedAt: 40, parts: separated })]);
  assert.equal(observation.text, 'Investigating\n\nFixed it.', 'tool/thinking boundaries survive without splitting stream chunks');
  assert.equal(observation.totalChars, observation.text.length);
  assert.equal(observeReply([msg('chunks', 'assistant', '', { finishedAt: 40, parts: chunks })]).text, 'Investigating');
  assert.equal(observeReply([msg('paragraph', 'assistant', '', { finishedAt: 40,
    parts: [{ kind: 'text', text: 'Before\n' }, { kind: 'tool', tool: {} }, { kind: 'text', text: '\nAfter' }] })]).text,
  'Before\n\nAfter', 'existing paragraph separators are preserved');
  assert.equal(observeSchedulerReply([{ id: 'scheduler-blocks', role: 'assistant', createdAt: 20, finishedAt: 40,
    content: 'flattened legacy fallback', parts: separated.map(part => part.kind === 'tool'
      ? { kind: 'tool', toolCall: { output: 'private tool output' } } : part) }]).text, 'Investigating\n\nFixed it.',
  'scheduler projection retains block boundaries before removing non-text content');
  assert.equal(JSON.stringify(messages), original, '投影不可修改消息');

  const { observeSessions, observeHost } = await load('main/sessions/observe.ts');
  assert.throws(() => observeSessions({}, {mode:'detail'}), /requires sessionId/);
  assert.throws(() => observeSessions({}, {mode:'directory',sessionId:'x'}), /does not accept/);
  const { observe } = await load('main/agentSession/host/observation.ts');
  const { runAsAgentSession } = await load('main/agent/agentScope.ts');
  const { GuiSessionStore } = await load('main/agentSession/persist.ts');
  const { sessionsHost } = await load('main/capabilities/hosts/sessions.ts');
  const { getToolDef } = await load('main/capabilities/catalog.ts');
  const { listHostToolIds, hostToolPermissionClass, hostToolBinding } = await load('shared/hostTools/meta.ts');
  assert.equal(sessionsHost['sessions.observe'], observeHost);
  await assert.rejects(observeHost({}, {includeHistory:true}),/sessionId/,'历史读取必须点名会话');
  assert.ok(getToolDef('sessions.observe'));
  for (const p of ['gui-full', 'pty-allowlist', 'acp-subset']) assert.ok(listHostToolIds(p).includes('sessions.observe'));
  assert.equal(hostToolPermissionClass('sessions.observe'), 'read');
  assert.equal(hostToolBinding('sessions.observe'), undefined, '可观察他人，不能被 self 绑定改写目标');
  const meta = (id, extra = {}) => ({ id, name: id, type: 'terminal', runtime: 'pi', workspaceId: 'w',
    createdAt: 10, lifecycle: 'idle', ...extra });
  const rows = [meta('parent'), meta('child', { parentSessionId: 'parent' }), meta('terminal', { runtime: 'cli' }),
    meta('other', { workspaceId: 'other-ws' }), meta('archived', { archived: true }), meta('shell', { launchKind: 'shell' })];
  let historyReads = 0, terminalReads = 0;
  const store = new GuiSessionStore(tmp); store.save('child', messages); store.flushSync();
  const host = { entries: new Map(), store };
  const ctx = { config: { get: () => ({}) }, resolveBubbleWorkspaceId: () => 'other-ws',
    sessions: { get: id => rows.find(s => s.id === id), list: () => rows,
      isChatRuntime: r => r === 'pi', select: () => assert.fail('观察不得切换焦点') },
    agentSessions: { isBusy: id => id === 'child', observe: id => { historyReads++; return observe(host, id); } },
    pty: { getBufferTail: () => { terminalReads++; return 'raw output'.repeat(600); } },
    git: new Proxy({}, { get() { assert.fail('观察不得扫描 Git'); } }),
    awareness: { getShare: id => id === 'child' ? { text: '检查按钮', updatedAt: 50 } : undefined }
  };
  const directory = runAsAgentSession('parent', () => observeSessions(ctx, { __actorSessionId: 'other' }));
  assert.equal(directory.workspaceId, 'w', '缺省区跟受信调用方，不能跟当前 UI 或模型伪造身份');
  assert.deepEqual(directory.sessions.map(s => s.sessionId).sort(), ['child', 'parent', 'terminal']);
  assert.equal(directory.sessions.find(s => s.sessionId === 'child').summary.source, 'share');
  assert.equal(historyReads, 0, '目录不读取全部会话历史'); assert.equal(terminalReads, 0);
  assert.equal(observeSessions(ctx, { workspaceId: 'w', includeArchived: true }).total, 4);
  assert.equal(observeSessions(ctx, { workspaceId: 'w', includeShell: true }).total, 4);
  rows.push(meta('hidden', { hidden: true }));
  assert.equal(observeSessions(ctx, { workspaceId: 'w', includeArchived: true, includeShell: true }).total, 5, '隐藏临时会话不进入目录');
  const filtered = { ...meta('abcdef00-archive', { archived: true, lastUsedAt: 10 }), name: 'Alpha archive',
    externalSessionId: 'external-archive', cwd: '/repo/alpha', worktreePath: '/trees/alpha' };
  const filterRows = [...rows, filtered];
  const filterCtx = { ...ctx, sessions: { ...ctx.sessions, list: () => filterRows, get: id => filterRows.find(s => s.id === id) } };
  assert.deepEqual(observeSessions(filterCtx, { workspaceId: 'w', archivedOnly: true, lastUsedBefore: 11, nameContains: 'ALPHA' }).sessions.map(s => s.sessionId), [filtered.id]);
  assert.equal(observeSessions(filterCtx, { workspaceId: 'w', includeArchived: true, shortId: 'abcdef00' }).sessions[0].sessionId, filtered.id);
  assert.equal(observeSessions(filterCtx, { workspaceId: 'w', includeArchived: true, worktreePath: '/trees/alpha' }).sessions[0].cwd, '/repo/alpha');
  assert.equal(observeSessions(filterCtx, { externalSessionId: 'external-archive' }).sessionId, filtered.id);
  assert.equal(observeSessions(filterCtx, { sessionId: 'abcdef00' }).sessionId, filtered.id);
  assert.equal(observeSessions(filterCtx, { workspaceId: '*', nameContains: 'Alpha' }).total, 0, '跨区仍遵守归档过滤');
  assert.equal(observeSessions(filterCtx, { workspaceId: '*', includeArchived: true, nameContains: 'Alpha' }).total, 1);
  filterRows.push({ ...filtered, id: 'abcdef00-other' });
  assert.throws(() => observeSessions(filterCtx, { sessionId: 'abcdef00' }), /不唯一/);
  const page = observeSessions(ctx, { workspaceId: 'w', limit: 1 });
  assert.equal(page.count, 1); assert.equal(page.nextOffset, 1);
  const directoryParent = (await observeHost(ctx, { workspaceId: 'w' })).sessions.find(s => s.sessionId === 'parent');
  for (const key of ['cwd', 'worktreePath', 'worktreeBranch', 'externalSessionId', 'launchError', 'summary']) {
    assert.equal(Object.hasOwn(directoryParent, key), false, `directory must omit empty ${key}`);
  }
  const unknown = (await observeHost({ ...ctx, agentSessions: undefined }, { workspaceId: 'w' })).sessions.find(s => s.sessionId === 'parent');
  assert.equal(unknown.busy, null, 'unknown execution state remains explicit');
  assert.equal((await observeHost(ctx, { sessionId: 'parent' })).launchError, null, 'detail keeps its full shape');
  assert.notEqual(observeSessions(ctx, { workspaceId: 'w', limit: 1, offset: page.nextOffset }).sessions[0].sessionId, page.sessions[0].sessionId);
  assert.throws(() => observeSessions(ctx, { sessionId: 'absent' }), /不存在/);
  assert.throws(() => observeSessions(ctx, { sessionId: 'child', workspaceId: 'other-ws' }), /不属于/);
  const active = { messages, assistant: messages.at(-1), busy: true };
  host.entries.set('child', active);
  const detail = observeSessions(ctx, { sessionId: 'child' });
  assert.equal(detail.busy, true); assert.equal(detail.lastReply.messageId, 'done');
  assert.equal(detail.summary.text, '检查按钮'); assert.equal(detail.transcript, 'structured');
  assert.equal(detail.updatedAt, 50); assert.equal(host.entries.get('child'), active);
  host.entries.clear();
  assert.equal(observeSessions(ctx, { sessionId: 'child' }).lastReply.finishedAt, 30, '重启未打开会话仍按持久化收口标记读取');
  assert.equal(host.entries.size, 0, '读取不得 open/connect 目标');
  const terminal = observeSessions(ctx, { sessionId: 'terminal' });
  assert.equal(terminal.transcript, 'terminal'); assert.equal(terminal.lastReply, null);
  assert.equal(terminal.terminalTail.truncated, true); assert.equal(terminal.terminalTail.text.length, 4000);
  ctx.pty.getBufferTail = () => undefined;
  assert.equal(observeSessions(ctx, { sessionId: 'terminal' }).transcript, 'unavailable');
  const base = meta('base', { lastUsedAt: 9999, liveStatus: { label: '验证中', ts: 45 } });
  assert.equal(sessionObservation(base).updatedAt, 45, 'UI 阅读时间不能伪装工作进度');
  assert.equal(sessionObservation(base).summary.source, 'note');
  rows.push(...Array.from({ length: 35 }, (_, i) => meta(`big-${i}`, { liveStatus: { label: 'x'.repeat(500), ts: i } })));
  const bounded = observeSessions(ctx, { workspaceId: 'w', limit: 20 });
  assert.ok(JSON.stringify(bounded).length < 10_000); assert.ok(bounded.nextOffset < bounded.total);

  // The scheduler is an ordinary observation peer even though its history has a separate store.
  const { Store } = await load('main/store.ts');
  const { observeScheduler } = await load('main/agent/orchestrator/observation.ts');
  const schedulerStore = new Store();
  const schedulerMessages = [{ id: 'sched-done', role: 'assistant', content: '调度最新回复', createdAt: 20, finishedAt: 30 },
    { id: 'sched-user', role: 'user', content: '追问', createdAt: 35 },
    { id: 'sched-stream', role: 'assistant', content: '正在生成', createdAt: 40 }];
  const legacyPath = path.join(tmp, 'chat-history.json');
  fs.writeFileSync(legacyPath, JSON.stringify({ display: schedulerMessages, api: [] }));
  const { SchedulerSessionAdapter } = await load('main/runtimeKernel/schedulerSession.ts');
  const schedulerLog = new SchedulerSessionAdapter(tmp, 'w', {display:schedulerMessages,api:[]});
  await schedulerLog.flush('seed-observation');
  const schedulerHost = { ctx: { store: schedulerStore }, buckets: new Map() };
  let schedulerReads = 0;
  const realLoad = schedulerStore.loadChat.bind(schedulerStore);
  schedulerStore.loadChat = () => { schedulerReads++; throw new Error('observation must not read complete scheduler history'); };
  observeScheduler(schedulerHost, 'w', false); assert.equal(schedulerReads, 0, '目录不读调度历史');
  const legacyBefore = fs.readFileSync(legacyPath, 'utf8');
  const coldScheduler = observeScheduler(schedulerHost, 'w', true);
  assert.equal(coldScheduler.lastReply.messageId, 'sched-done');
  assert.equal(schedulerReads, 0, '观察只读范围页，不调用完整历史'); assert.equal(schedulerHost.buckets.size, 0);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyBefore, '观察不迁移或删除遗留历史');
  assert.equal(fs.existsSync(path.join(tmp, 'chat-history-w.json')), false);
  schedulerHost.buckets.set('w', { display: schedulerMessages, busy: true, streamingAssistant: schedulerMessages.at(-1) });
  assert.equal(observeScheduler(schedulerHost, 'w', true).lastReply.messageId, 'sched-done');
  ctx.workspaces = { list: () => [{ id: 'w' }, { id: 'other-ws' }] };
  ctx.schedulerStatus = { get: () => ({ note: '协调中', phase: 'idle', ts: 45 }) };
  ctx.orchestrator = { observe: (ws, detail) => observeScheduler(schedulerHost, ws, detail) };
  const fullDirectory = observeSessions(ctx, { workspaceId: 'w' });
  const schedulerRow = observeSessions(ctx, { workspaceId: 'w', offset: fullDirectory.total - 1 }).sessions[0];
  assert.equal(schedulerRow.sessionId, 'orchestrator:w'); assert.equal(schedulerRow.summary.text, '协调中');
  const schedulerDetail = runAsAgentSession('parent', () => observeSessions(ctx, { sessionId: 'scheduler' }));
  assert.equal(schedulerDetail.sessionId, 'orchestrator:w'); assert.equal(schedulerDetail.busy, true);
  assert.equal(schedulerDetail.lastReply.messageId, 'sched-done');
  assert.equal(observeSessions(ctx, { sessionId: 'orchestrator:w' }).lastReply.status, 'completed');
  ctx.awareness.getShare = id => id === 'orchestrator:w' ? { text: '调度共享摘要', updatedAt: 100 } : undefined;
  assert.equal(observeSessions(ctx, { sessionId: 'orchestrator:w' }).updatedAt, 100, '调度快照必须保留共享摘要的新鲜度');
  assert.throws(() => observeSessions(ctx, { sessionId: 'orchestrator:w', workspaceId: 'other-ws' }), /不属于/);
  assert.throws(() => observeSessions(ctx, { sessionId: 'orchestrator:absent' }), /不存在/);
  // scheduler-observe F-01：调度合成目标 includeHistory 显式拦截——旧实现放行后
  // readSessionHistory 抛「会话不存在: orchestrator:w」，与上一步刚成功的快照自相矛盾。
  await assert.rejects(observeHost(ctx, { sessionId: 'orchestrator:w', includeHistory: true }), /调度会话不支持 includeHistory/, 'orchestrator 目标给专门文案');
  await assert.rejects(observeHost(ctx, { sessionId: 'scheduler', includeHistory: true }), /调度会话不支持 includeHistory/, 'scheduler 目标同拦截');
  assert.deepEqual(realLoad('w').display.map(row => [row.id, row.role, row.content]),
    schedulerMessages.map(row => [row.id, row.role, row.content])); schedulerStore.flushSync();
  assert.equal(fs.readFileSync(legacyPath,'utf8'),legacyBefore,'正常打开也不迁移旧JSON');
  assert.equal(fs.existsSync(path.join(tmp, 'chat-history-w.json')), false);
  console.log('sessions-observe: common host projection, lifecycle semantics, scope, paging, persistence and terminal boundary passed');
} finally {
  assert.equal(path.dirname(path.resolve(tmp)),path.resolve(tempRoot));
  assert.ok(path.basename(tmp).startsWith('sessions-observe-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
