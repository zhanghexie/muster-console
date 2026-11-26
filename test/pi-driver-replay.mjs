/**
 * Pi GUI driver 离线回放自测（pi-trajectory-plan v3 B1' 验收）：
 * - 假 SDK 注入（piSdk.__setPiSdkForTests 缝）回放引擎事件流 → GuiDriverStreamEvent；
 * - turn-complete 携带 summary：usage 归一 / TTFT / 回合墙钟 / model；
 * - 纯工具调用响应的 TTFT 补盲（toolcall_start 流事件打点）；
 * - retry：session.agent.onResponse 计数（钩子被 driver 挂上）；
 * - steering 独立事件（redirect 时随队列发出）；
 * - 工具执行时长（tool_execution_start → end 的 durationMs）。
 * 运行: node test/pi-driver-replay.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-replay-workspace-'));
process.once('exit', () => fs.rmSync(fixtureWorkspace, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('module');

// .ts 即时转译（CJS）：driver 的 import 闭包全在仓内 + node 内建
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

// 主进程模块可能运行时 import electron：stub 掉
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), isReady: () => true },
      ipcMain: { handle: () => {}, on: () => {} }
    };
  }
  return origLoad.apply(this, arguments);
};

const { PiWorkerEngine } = require(path.join(
  root,
  'src/main/agentSession/drivers/pi/workerEngine.ts'
));
const { PiRuntimeDriver } = require(path.join(root, 'src/main/agentSession/drivers/pi/driver.ts'));
const { __setPiSdkForTests } = require(path.join(
  root,
  'src/main/agentSession/drivers/pi/piSdk.ts'
));
const { ModeController } = require(path.join(root, 'src/main/agent/providers/modeExtension.ts'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假 SDK ----------
function makeFakePi() {
  const state = {
    promptCalls: [],
    steerCalls: [],
    followUpCalls: [],
    subscribeCb: null,
    createSessionOpts: null,
    loaderOpts: null
  };
  const fakeModel = {
    id: 'm1',
    name: 'M1',
    api: 'openai',
    provider: 'p1',
    input: ['text'],
    reasoning: false
  };
  const modelRuntime = {
    getModel: () => fakeModel,
    checkAuth: async () => true
  };
  const fakeSession = {
    sessionId: 'pi-session-1',
    isStreaming: false,
    agent: { onResponse: null },
    // Harness 透明·引擎真身捕获源（§7：生效系统提示词 + 工具目录）
    systemPrompt: '引擎系统提示词真身',
    getAllTools() {
      return [
        {
          name: 'read',
          label: 'Read',
          source: 'native',
          description: '读文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        },
        { name: 'bgtasks.shell', description: '后台跑命令' }
      ];
    },
    subscribe(cb) {
      state.subscribeCb = cb;
      return () => {
        state.subscribeCb = null;
      };
    },
    async prompt(text, opts) {
      state.promptCalls.push(text);
    },
    async steer(text) {
      state.steerCalls.push(text);
      return 'queued';
    },
    async followUp(text) { state.followUpCalls.push(text); },
    async abort() {},
    async compact() {
      return { ok: true };
    },
    getContextUsage() {
      return null;
    },
    dispose() {}
  };
  const fakePi = {
    ModelRuntime: { create: async () => modelRuntime },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(opts) {
        state.loaderOpts = opts;
      }
      async reload() {}
      getMusterExplicitSkills() { return state.loaderOpts.musterExplicitSkills === true; }
      musterSkillDiscoveryVersion = 2;
      setMusterSkillPaths(paths) { state.loaderOpts.additionalSkillPaths = paths; }
    },
    SessionManager: {
      create: () => ({ appendMessage() {}, getLeafId: () => null }),
      open: () => ({ appendMessage() {}, getLeafId: () => null })
    },
    createAgentSession: async (opts) => {
      state.createSessionOpts = opts;
      return { session: fakeSession };
    }
  };
  return { fakePi, state, fakeSession };
}

function makeDriverCtx() {
  return {
    config: {
      get: () => ({
        llm: {
          providers: [
            { id: 'p1', name: 'P1', apiKey: 'k-test', baseUrl: 'http://localhost:1', models: [{ id: 'm1', name: 'M1' }], enabled: true }
          ],
          activeProviderId: 'p1',
          activeModelId: 'm1'
        }
      })
    },
    bgTasks: null
  };
}

async function makeConnection(fakePi, ctx = makeDriverCtx()) {
  const driver = new PiWorkerEngine({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-driver-replay-')),
    resolved: { provider: { id: 'p1' }, model: { id: 'm1' } },
    shellEnv: { settings: {}, bashAvailable: true },
    memorySnapshot: () => undefined,
    refreshSkills: async () => {},
    verifySkills: async () => {}
  });
  return driver.connect({
    sessionId: 's-replay',
    cwd: fixtureWorkspace,
    systemPromptAppend: '政策层追加段',
    mode: 'auto',
    planExecuting: false,
    permissionMode: 'acceptEdits',
    modeController: new ModeController('default'),
    hostTools: [],
    requestApproval: async () => ({ approved: true }),
    getPolicyState: () => ({ mode: 'auto', planExecuting: false }),
    log: () => {}
  });
}

function collect(conn, evts) {
  void (async () => {
    for await (const ev of conn.events) evts.push(ev);
  })();
}
const flush = () => sleep(20);

// ---------- 1. turn-complete 携带 summary（usage/TTFT/墙钟/model） ----------
{
  const { fakePi, state } = makeFakePi();
  __setPiSdkForTests(fakePi);
  const conn = await makeConnection(fakePi);
  const evts = [];
  collect(conn, evts);
  await conn.send('你好');
  await flush();
  assert.equal(state.promptCalls.length, 1, '引擎收到 prompt');
  const emit = state.subscribeCb;
  assert.ok(emit, 'driver 已订阅引擎事件');
  emit({ type: 'turn_start' });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '在' } });
  emit({
    type: 'turn_end',
    message: { role: 'assistant', model: 'glm-5', usage: { input: 100, output: 20, reasoning: 7 } }
  });
  emit({ type: 'agent_settled' });
  await flush();
  const done = evts.find((e) => e.type === 'turn-complete');
  assert.ok(done, 'turn-complete 已发出');
  assert.ok(done.summary, 'turn-complete 携带 summary');
  assert.equal(done.summary.model, 'glm-5');
  assert.equal(done.summary.usage.inputTokens, 100);
  assert.equal(done.summary.usage.outputTokens, 20);
  assert.equal(done.summary.usage.reasoningTokens, 7);
  assert.equal(typeof done.summary.durationMs, 'number');
  assert.ok(done.summary.durationMs >= 0);
  assert.equal(done.summary.calls.length, 1);
  assert.equal(typeof done.summary.calls[0].ttftMs, 'number');
  assert.ok(done.summary.calls[0].ttftMs >= 0, 'text_delta 打点出 TTFT');
  assert.equal(done.summary.calls[0].retry, undefined, '单次响应无 retry');
  await conn.close();
}

// ---------- 2. 纯工具调用响应：toolcall_start 打点出 TTFT（补盲回归） ----------
{
  const { fakePi, state } = makeFakePi();
  __setPiSdkForTests(fakePi);
  const conn = await makeConnection(fakePi);
  const evts = [];
  collect(conn, evts);
  await conn.send('调个工具');
  await flush();
  const emit = state.subscribeCb;
  emit({ type: 'turn_start' });
  // 无 text/thinking 增量：只有 toolcall 流事件
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } });
  emit({ type: 'message_end', message: { role: 'assistant' } });
  emit({
    type: 'turn_end',
    message: { role: 'assistant', model: 'glm-5', usage: { input: 9, output: 9 } }
  });
  emit({ type: 'agent_settled' });
  await flush();
  const done = evts.find((e) => e.type === 'turn-complete');
  assert.ok(done?.summary, 'turn-complete 携带 summary');
  assert.equal(
    typeof done.summary.calls[0].ttftMs,
    'number',
    '纯工具调用响应也有 TTFT（toolcall 打点补盲）'
  );
  await conn.close();
}

// ---------- 3. retry：driver 给 session.agent.onResponse 挂计数 ----------
{
  const { fakePi, state, fakeSession } = makeFakePi();
  __setPiSdkForTests(fakePi);
  const conn = await makeConnection(fakePi);
  const evts = [];
  collect(conn, evts);
  await conn.send('再试一次');
  await flush();
  const emit = state.subscribeCb;
  emit({ type: 'turn_start' });
  assert.equal(typeof fakeSession.agent.onResponse, 'function', 'onResponse 钩子被 driver 挂上');
  fakeSession.agent.onResponse({});
  fakeSession.agent.onResponse({}); // 同 payload 两次响应 = 1 次重试
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
  emit({
    type: 'turn_end',
    message: { role: 'assistant', model: 'glm-5', usage: { input: 1, output: 1 } }
  });
  emit({ type: 'agent_settled' });
  await flush();
  const done = evts.find((e) => e.type === 'turn-complete');
  assert.equal(done.summary.calls[0].retry, 1, 'onResponse 计数 = 响应数 - 1');
  await conn.close();
}

// ---------- 4. Built-in Pi accepts user steering through the native SDK path ----------
{
  const { fakePi, state, fakeSession } = makeFakePi();
  __setPiSdkForTests(fakePi);
  const conn = await makeConnection(fakePi);
  await conn.send('first');
  fakeSession.isStreaming = true;
  assert.equal(conn.redirect('user correction'), false, 'synchronous redirect cannot confirm IPC delivery');
  const steer = await conn.receiveMessage({ intent: 'interrupt', messageId: 'steer-1', text: 'user correction' });
  assert.deepEqual(steer, { status: 'accepted', method: 'steered' }, 'Pi user interrupt uses SDK steer');
  assert.deepEqual(state.steerCalls, ['user correction']);
  const normal = await conn.receiveMessage({ intent: 'normal', messageId: 'mail-1', text: 'follow-up' });
  assert.equal(normal.status, 'unsupported', 'ordinary mailbox messages still use the host queue');
  const deferred = await conn.receiveMessage({ intent: 'normal', messageId: 'mail-2', text: 'later', idleOnly: true });
  assert.equal(deferred.status, 'deferred');
  assert.deepEqual(state.followUpCalls, []);
  fakeSession.isStreaming = false;
  await conn.close();
}

// ---------- 4c. onResponse 链式保留（M-1）----------
{
  const { fakePi, fakeSession } = makeFakePi();
  __setPiSdkForTests(fakePi);
  let origCalls = 0;
  fakeSession.agent.onResponse = () => {
    origCalls += 1;
  };
  const conn = await makeConnection(fakePi);
  assert.equal(typeof fakeSession.agent.onResponse, 'function', '钩子被 driver 接管');
  fakeSession.agent.onResponse({});
  assert.equal(origCalls, 1, 'M-1：SDK 原有 onResponse（after_provider_response 发射器）仍被调用');
  await conn.close();
}

// ---------- 4d. askQuestion 按通道裁剪（M-3）----------
{
  const { buildPiCustomTools } = require(path.join(
    root,
    'src/main/agentSession/drivers/pi/customTools.ts'
  ));
  const noChannel = buildPiCustomTools([], { sessionId: 's', cwd: fixtureWorkspace });
  assert.equal(
    noChannel.some((t) => t.name === 'askQuestion'),
    false,
    'M-3：无 requestUserQuestion 通道（后台子代理）不得注册必失败的 askQuestion'
  );
  const withChannel = buildPiCustomTools([], { sessionId: 's', cwd: fixtureWorkspace }, async () => ({
    kind: 'answered',
    answers: []
  }));
  assert.equal(withChannel.some((t) => t.name === 'askQuestion'), false, '有通道也不得注册旧问卷别名');
  console.log('ok: 问卷使用公开快照，无旧别名');
}

// ---------- 5. 工具执行时长：tool_execution_start → end 的 durationMs ----------
{
  const { fakePi, state } = makeFakePi();
  __setPiSdkForTests(fakePi);
  const conn = await makeConnection(fakePi);
  const evts = [];
  collect(conn, evts);
  await conn.send('跑个命令');
  await flush();
  const emit = state.subscribeCb;
  emit({ type: 'turn_start' });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好' } });
  emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'bash' }] }
  });
  emit({
    type: 'turn_end',
    message: { role: 'assistant', model: 'glm-5', usage: { input: 3, output: 3 } }
  });
  emit({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' } });
  await sleep(30);
  emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', isError: false, result: 'ok' });
  emit({ type: 'agent_settled' });
  await flush();
  const tr = evts.find((e) => e.type === 'tool-result' && e.toolCallId === 'tc-1');
  assert.ok(tr, 'tool-result 事件存在');
  assert.equal(typeof tr.durationMs, 'number', '工具卡时长随 tool-result 携带');
  assert.ok(tr.durationMs >= 20, '时长按真实起止打点（≥ 30ms 等待窗）');
  await conn.close();
}

// ---------- 6. 压缩生命周期事件（B3' 独立事件源，替代账本 compaction 行） ----------
{
  const { fakePi, state } = makeFakePi();
  __setPiSdkForTests(fakePi);
  const conn = await makeConnection(fakePi);
  const evts = [];
  collect(conn, evts);
  await conn.send('跑一会儿');
  await flush();
  const emit = state.subscribeCb;
  emit({ type: 'compaction_start' });
  emit({ type: 'compaction_end', willRetry: true });
  emit({ type: 'compaction_end' });
  await flush();
  const comps = evts.filter((e) => e.type === 'compaction');
  assert.equal(comps.length, 3, 'start/willRetry-end/end 三条事件');
  assert.equal(comps[0].phase, 'start');
  assert.equal(comps[1].willRetry, true, '自动重试中：end 带 willRetry');
  assert.equal(comps[2].willRetry, undefined);
  await conn.close();
}

// ---------- 7. 引擎真身捕获：systemPrompt + getAllTools → conn.engineCapture ----------
{
  const { fakePi } = makeFakePi();
  __setPiSdkForTests(fakePi);
  const conn = await makeConnection(fakePi);
  const cap = conn.engineCapture;
  assert.ok(cap, 'engineCapture 随连接提供');
  assert.equal(cap.enginePrompt.text, '引擎系统提示词真身');
  assert.equal(cap.enginePrompt.chars, 9);
  assert.match(cap.enginePrompt.hash, /^[0-9a-f]{8}$/, 'FNV-1a 指纹');
  assert.equal(cap.tools.length, 2, '工具目录归一');
  assert.equal(cap.tools[0].name, 'read');
  assert.equal(cap.tools[0].source, 'native');
  assert.deepEqual(cap.tools[0].params, ['path: string*'], 'TypeBox schema 归一为参数摘要');
  assert.equal(cap.tools[1].name, 'bgtasks.shell');
  assert.equal(cap.tools[1].params, undefined, '无 parameters → 无参数摘要');
  assert.equal(cap.tools[1].source, undefined);
  await conn.close();
}

// ---------- 8. 宿主模型校验拒绝缺失/禁用配置，reload 可修复空 Key ----------
{
  const { fakePi } = makeFakePi();
  __setPiSdkForTests(fakePi);
  for (const mutate of [
    (cfg) => { cfg.llm.providers[0].apiKey = ''; },
    (cfg) => { cfg.llm.providers[0].enabled = false; },
    (cfg) => { cfg.llm.providers[0].models = []; },
    (cfg) => { cfg.llm.providers[0].baseUrl = ''; }
  ]) {
    const cfg = makeDriverCtx().config.get();
    mutate(cfg);
    const ctx = { config: { get: () => cfg, reloadFromDisk: () => cfg }, bgTasks: null };
    const driver = new PiRuntimeDriver(ctx, { userDataDir: os.tmpdir() });
    await assert.rejects(driver.validateModelOverride({ model: { providerId: 'p1', modelId: 'm1' } }), /API Key|已禁用|Base URL|不可用/);
  }
  const cfg = makeDriverCtx().config.get();
  const stale = structuredClone(cfg);
  stale.llm.providers[0].apiKey = '';
  let reloads = 0;
  const ctx = { config: { get: () => stale, reloadFromDisk: () => { reloads++; return cfg; } }, bgTasks: null };
  const driver = new PiRuntimeDriver(ctx, { userDataDir: os.tmpdir() });
  await driver.validateModelOverride({ model: { providerId: 'p1', modelId: 'm1' } });
  assert.equal(reloads, 1, '宿主配置解析器重载磁盘 Key');
}

// ---------- 9. provider 错误与无错误详情的失败均不能发成功 turn-complete；重试成功清旧错 ----------
for (const errorMessage of ['OpenAI API error (402): Insufficient Balance', undefined]) {
  const { fakePi, state } = makeFakePi();
  __setPiSdkForTests(fakePi);
  const conn = await makeConnection(fakePi);
  const evts = [];
  collect(conn, evts);
  await conn.send('hello');
  state.subscribeCb({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage }] });
  state.subscribeCb({ type: 'agent_settled' });
  await flush();
  const failed = evts.find((e) => e.type === 'error');
  assert.ok(failed?.message, '错误无详情也必须反馈');
  if (errorMessage) assert.equal(failed.message, errorMessage, '保留服务商原始诊断');
  assert.equal(evts.some((e) => e.type === 'turn-complete'), false);
  await conn.send('retry');
  state.subscribeCb({ type: 'agent_end', willRetry: true, messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '429' }] });
  state.subscribeCb({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } });
  state.subscribeCb({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });
  state.subscribeCb({ type: 'agent_settled' });
  await flush();
  assert.equal(evts.filter((e) => e.type === 'error').length, 1);
  assert.equal(evts.filter((e) => e.type === 'turn-complete').length, 1);
  await conn.close();
}

__setPiSdkForTests(null);
console.log('ok   pi-driver-replay');
