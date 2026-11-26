/**
 * Codex GUI driver 离线回放。
 * - 假 SDK Thread 回放 JSONL 事件并检查 GuiDriverStreamEvent。
 * - 检查启动环境、原生权限设置及忽略旧 GUI 权限档的兼容路径。
 * - 覆盖线程恢复、取消、政策层前缀和本地图片。
 * 运行: node test/codex-driver-replay.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.tmp', 'codex-driver-replay');
fs.rmSync(tmp, { recursive: true, force: true });
const compile = createSharedCompiler(root, tmp);

const driverOut = compile('main/agentSession/drivers/codex/driver.ts');
const workerDir = path.join(path.dirname(driverOut), 'worker');
fs.mkdirSync(workerDir, {recursive:true});
for (const name of ['native-worker.mjs', 'appServerOutput.mjs', 'windows-job.ps1']) fs.copyFileSync(path.join(root, 'src/main/agentSession/drivers/codex/worker', name), path.join(workerDir, name));
const { pathToFileURL } = await import('node:url');
const { CodexRuntimeDriver } = await import(pathToFileURL(driverOut).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, timeout = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时: ${label}`);
    await sleep(10);
  }
}

class EventFeed {
  constructor() {
    this.q = [];
    this.waiters = [];
    this.ended = false;
    this.err = null;
  }
  emit(ev) {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.q.push(ev);
  }
  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  fail(err) {
    this.err = err;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ error: err });
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.q.length) {
        yield this.q.shift();
        continue;
      }
      if (this.err) throw this.err;
      if (this.ended) return;
      const step = await new Promise((resolve) => this.waiters.push(resolve));
      if (step.error) throw step.error;
      if (step.done) return;
      yield step.value;
    }
  }
}

function makeFakeSdk() {
  const state = { created: [], started: [], resumed: [], runs: [], feed: null, lastThread: null };
  class FakeThread {
    constructor(id, options) {
      this._id = id;
      this._options = options;
    }
    get id() {
      return this._id;
    }
    async runStreamed(input, turnOptions) {
      const feed = new EventFeed();
      state.feed = feed;
      state.runs.push({ input, turnOptions, threadId: this._id, options: this._options });
      return { events: feed };
    }
  }
  class FakeCodex {
    constructor(options) {
      state.created.push(options);
    }
    startThread(options) {
      state.started.push(options);
      const t = new FakeThread(null, options);
      state.lastThread = t;
      return t;
    }
    resumeThread(id, options) {
      state.resumed.push({ id, options });
      const t = new FakeThread(id, options);
      state.lastThread = t;
      return t;
    }
  }
  return { Codex: FakeCodex, state };
}

function makeInput(overrides = {}) {
  return {
    sessionId: 'sess-1',
    cwd: tmp,
    firstPromptPrefix: '【政策层】你是测试 Worker',
    systemPromptAppend: '',
    mode: 'default',
    planExecuting: false,
    permissionMode: 'acceptEdits',
    modeController: {},
    hostTools: [],
    requestApproval: async () => ({ approved: true }),
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    log: () => {},
    ...overrides
  };
}

async function connectAndCollect(driver, input) {
  const conn = await driver.connect(input);
  const events = [];
  const pump = (async () => {
    for await (const ev of conn.events) events.push(ev);
  })();
  return { conn, events, pump };
}

process.env.MUSTER_TEST_KEEP = 'kept';
process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'must-drop';

/** 最小 AppContext：B2 起 driver 不再读用户 MCP——effectiveMcp 被调到即失败（守卫） */
function makeCtx() {
  return {
    sessions: { get: () => ({ workspaceId: 'ws-1' }) },
    config: {
      effectiveMcp: () => {
        throw new Error('B2: Codex GUI driver must not read user MCP config');
      }
    }
  };
}

let failed = 0;
const check = (name, fn) =>
  fn().then(
    () => console.log(`  ✓ ${name}`),
    (e) => {
      failed += 1;
      console.error(`  ✗ ${name}: ${e.message}`);
    }
  );

try {
  await check('创建前拒绝不在 Codex 模型目录的显式模型', async () => {
    const d = new CodexRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
      listModels: async () => ({ ok: true, source: 'app-server', items: [{ id: 'fixture-gpt', displayName: 'Fixture' }] })
    });
    await assert.rejects(d.validateModelOverride({ cwd: tmp, model: { providerId: 'codex-gui', modelId: 'claude' } }), /不在当前可用目录/);
    await d.validateModelOverride({ cwd: tmp, model: { providerId: 'codex-gui', modelId: 'fixture-gpt' } });
  });
  const fake = makeFakeSdk();
  const driver = new CodexRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    createClient: (opts) => new fake.Codex(opts),
    resolveExecutable: async () => ({ ok: true, executable: undefined, packaged: false }),
    // .ts 候选路径已删除（P0-1），测试显式指定脚本
    hostMcpScript: path.join(root, 'src/main/inboundMcp/stdioEntry.ts')
  });

  await check('桌面全局证据不可用时不静默回退到局部确认', async () => {
    const ctx = makeCtx();
    ctx.desktopEngineDelivery = () => null;
    const d = new CodexRuntimeDriver(ctx, { userDataDir: tmp }, {
      createClient: opts => new fake.Codex(opts),
      resolveExecutable: async () => ({ ok: true, executable: undefined, packaged: false }),
      hostMcpScript: path.join(root, 'src/main/inboundMcp/stdioEntry.ts')
    });
    await assert.rejects(d.connect(makeInput({})), /global delivery dependencies are invalid/i);
  });

  await check('Codex applies the native launch choice once and follows subsequent engine state', async () => {
    const app = makeFakeSdk();
    const calls = [];
    const d = new CodexRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
      createAppServerClient: opts => { calls.push(opts); return new app.Codex({}); },
      resolveExecutable: async () => ({ ok: true, executable: process.execPath, packaged: false }),
      hostMcpScript: path.join(root, 'src/main/inboundMcp/stdioEntry.ts')
    });
    const nativeConfig = { identity: { runtimeId: 'codex-gui', sourceKey: 'fixture' },
      selections: [{ id: 'collaborationMode', value: 'plan' }] };
    const { conn, events } = await connectAndCollect(d, makeInput({ nativeConfig }));
    const observe = (options, value) => options.onNativeConfig({ status: 'ready', options: [
      { id: 'collaborationMode', name: 'Collaboration Mode', type: 'select', changePolicy: 'idle',
        currentValue: value, choices: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] }
    ] });
    const first = conn.send('hello');
    await waitFor(() => app.state.runs.length === 1, 'app run');
    assert.deepEqual(calls[0].nativeSelections, nativeConfig.selections);
    assert.equal(calls[0].permissionMode, undefined);
    observe(calls[0], 'plan');
    observe(calls[0], 'default');
    app.state.feed.emit({ type: 'thread.started', thread_id: 'thread-native' });
    app.state.feed.emit({ type: 'app.context-usage', usage: { tokens: 123, contextWindow: 1000 } });
    app.state.feed.emit({ type: 'turn.completed' });
    app.state.feed.end();
    await first;
    assert.equal(conn.getNativeConfig().options[0].currentValue, 'default');
    assert.deepEqual(conn.getContextUsage(), { tokens: 123, contextWindow: 1000 });
    assert.ok(events.some(e => e.type === 'context-usage' && e.usage?.tokens === 123));
    const second = conn.send('continue');
    await waitFor(() => app.state.runs.length === 2, 'next app run');
    assert.deepEqual(calls[1].nativeSelections, []);
    app.state.feed.emit({ type: 'turn.completed' });
    app.state.feed.end();
    await second;
    await conn.close();
  });

  await check('connect：env 清洗 originator + 推理配置；尚未 spawn exec', async () => {
    fake.state.created.length = 0;
    const { conn } = await connectAndCollect(driver, makeInput({}));
    assert.equal(fake.state.created.length, 1);
    const env = fake.state.created[0].env;
    assert.equal(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined, 'originator 由 SDK 注入');
    assert.equal(env.MUSTER_TEST_KEEP, 'kept');
    assert.equal(env.PYTHONUTF8, process.env.PYTHONUTF8 || '1');
    assert.equal(env.PYTHONIOENCODING, process.env.PYTHONIOENCODING || 'utf-8');
    assert.equal(fake.state.created[0].config.show_raw_agent_reasoning, true);
    assert.deepEqual(fake.state.created[0].config.mcp_servers.muster.enabled_tools, ['host_requestApproval'], '无问卷通道时仅公开审批桥');
    assert.equal(fake.state.started.length, 0, 'connect 不 startThread（首条 send 才开）');
    await conn.close();
  });
  await check('会话模型覆盖：start/resume 的 SDK model 参数；清除后不覆盖 CLI 默认', async () => {
    assert.equal(driver.modelOverridePolicy, 'reconnect');
    for (const input of [
      { modelOverride: { providerId: 'codex-gui', modelId: 'chosen' } },
      { resumeToken: 'same-thread', modelOverride: { providerId: 'codex-gui', modelId: 'next-model' } },
      { resumeToken: 'same-thread' }
    ]) {
      const { conn } = await connectAndCollect(driver, makeInput(input));
      const before = fake.state.runs.length;
      const sending = conn.send('model test');
      await waitFor(() => fake.state.runs.length > before, 'model test run');
      assert.equal(fake.state.runs.at(-1).options.model, input.modelOverride?.modelId);
      if (input.resumeToken) assert.equal(fake.state.resumed.at(-1).id, 'same-thread');
      fake.state.feed.end(); await sending; await conn.close();
    }
  });
  await check('Native app-server settings leave additional sandbox directories to Codex', async () => {
    const cwd = tmp; const extra = path.join(tmp, 'second-root');
    const context = { cwd, writableDirectories: [{ path: cwd }, { path: extra }] };
    const ordinary = await connectAndCollect(driver, makeInput({ workspaceContext: context }));
    const firstSend = ordinary.conn.send('directory test');
    await waitFor(() => fake.state.runs.length > 0, 'directory test run');
    assert.equal(fake.state.runs.at(-1).options.additionalDirectories, undefined);
    fake.state.feed.end(); await firstSend;
    await ordinary.conn.close();
    const isolated = await connectAndCollect(driver, makeInput({ resumeToken: 'scope-resume', workspaceContext: { ...context, writableDirectories: [{ path: cwd }] } }));
    const before = fake.state.runs.length;
    const isolatedSend = isolated.conn.send('isolated directory test');
    await waitFor(() => fake.state.runs.length > before, 'isolated directory test run');
    assert.equal(fake.state.runs.at(-1).options.additionalDirectories, undefined);
    assert.equal(fake.state.resumed.at(-1).id, 'scope-resume');
    fake.state.feed.end(); await isolatedSend;
    await isolated.conn.close();
  });

  await check('askQuestion：requestUserQuestion 时 mcp_servers.muster 注册存在', async () => {
    fake.state.created.length = 0;
    const { conn } = await connectAndCollect(
      driver,
      makeInput({
        requestUserQuestion: async () => ({ kind: 'aborted' }),
        hostTools: [
          {
            id: 'host.sessions.update',
            label: '状态',
            description: '上报',
            parameters: { type: 'object' },
            permissionClass: 'status',
            execute: async () => 'ok'
          },
          { id: 'host.ask', label: 'Ask', description: 'Ask user', parameters: { type: 'object' }, permissionClass: 'read' }
        ]
      })
    );
    assert.equal(fake.state.created.length, 1);
    const mcp = fake.state.created[0].config.mcp_servers?.muster;
    assert.ok(mcp, 'mcp_servers.muster 已注册');
    // B1b：全量宿主工具 + 问卷 + 自愿审批（与政策层目录同源）
    assert.ok(
      mcp.enabled_tools.includes('host_ask') && mcp.enabled_tools.includes('host_requestApproval'),
      'enabled_tools 含问卷与自愿审批'
    );
    assert.ok(mcp.enabled_tools.includes('host_sessions_update'), '宿主工具随问卷一起注册');
    assert.ok(mcp.env?.MUSTER_HOST_TOOLS_CATALOG, 'catalog 路径注入');
    await conn.close();
  });

  // B2（capability-delivery-mcp-relay-plan）：用户配置的第三方 MCP 不再注入引擎——
  // 引擎侧工具清单只有宿主 muster server；第三方工具经宿主中转（mcp.search/call）。
  await check('B2：用户 MCP（含 GUI 绑定项）不再进 config.mcp_servers', async () => {
    const ctx = makeCtx();
    // 叠回一个会返回用户配置的 effectiveMcp：若 driver 违约读取（应已删分支），本用例转红
    ctx.config.effectiveMcp = () => ({
      enabled: true,
      servers: [
        { name: 'user-fs', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'fake'] },
        { name: 'user-web', enabled: true, transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer isolated-token' } },
        { name: 'selected-gui', enabled: true, transport: 'stdio', command: 'node', targetIds: ['codex-gui'] },
        { name: 'broken-web', enabled: true, transport: 'http', url: '' },
        { name: 'muster', enabled: true, transport: 'stdio', command: 'node' }
      ]
    });
    for (const withQuestionnaire of [false, true]) {
      const d = new CodexRuntimeDriver(ctx, { userDataDir: tmp }, {
        createClient: (opts) => new fake.Codex(opts),
        resolveExecutable: async () => ({ ok: true, executable: undefined, packaged: false }),
        hostMcpScript: path.join(root, 'src/main/inboundMcp/stdioEntry.ts')
      });
      fake.state.created.length = 0;
      const warns = [];
      const { conn } = await connectAndCollect(
        d,
        makeInput({
          ...(withQuestionnaire ? { requestUserQuestion: async () => ({ kind: 'aborted' }) } : {}),
          log: (level, msg) => {
            if (level === 'warn') warns.push(String(msg));
          }
        })
      );
      const servers = fake.state.created[0].config.mcp_servers ?? {};
      assert.deepEqual(Object.keys(servers), ['muster'], '只有宿主 muster server');
      assert.deepEqual(servers.muster.enabled_tools, ['host_requestApproval'], '没有宿主问卷工具时只暴露审批桥');
      assert.equal(JSON.stringify(servers).includes('user-fs'), false, 'stdio 用户 server 不注入');
      assert.equal(JSON.stringify(servers).includes('user-web'), false, 'HTTP 用户 server 不注入');
      assert.equal(JSON.stringify(servers).includes('selected-gui'), false, '按 codex-gui target 过滤的绑定项也不注入');
      assert.equal(JSON.stringify(servers).includes('enabled":false'), false, '不再写 enabled:false 托管屏蔽项');
      assert.equal(warns.some((w) => /user-|selected-gui|broken-web/.test(w)), false, '不再有用户 MCP 的接入/跳过 warn');
      await conn.close();
    }
  });

  await check('打包版找不到用户 codex → 引导错误', async () => {
    const d = new CodexRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
      createClient: (opts) => new fake.Codex(opts),
      resolveExecutable: async () => ({ ok: false, packaged: true })
    });
    await assert.rejects(() => d.connect(makeInput()), /Codex 安装/);
  });

  await check('回归：askMcp 建好后续初始化抛错 → 网关必须关闭（不泄漏常驻 server）', async () => {
    const script = path.join(tmp, 'dummy-host-mcp.mjs');
    fs.writeFileSync(script, '// dummy host mcp entry\n', 'utf8');
    const tcpServers = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length;
    // 基线前先静置：前序用例网关的 server.close() 是异步释放，等它落地再取基线
    await new Promise((r) => setTimeout(r, 50));
    const before = tcpServers();
    const d = new CodexRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
      createClient: () => {
        throw new Error('boom-create');
      },
      resolveExecutable: async () => ({ ok: true, packaged: false }),
      hostMcpScript: script
    });
    await assert.rejects(
      () =>
        d.connect(
          makeInput({
            requestUserQuestion: async () => ({ kind: 'aborted' })
          })
        ),
      /boom-create/
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      tcpServers(),
      before,
      'connect 失败后不得残留新的监听 server（修复前 askMcp 网关无人关闭，常驻泄漏）'
    );
  });

  await check('Legacy GUI values do not select Codex sandbox or approval policy', async () => {
    for (const [mode, planExecuting] of [
      ['default', false],
      ['ask', false],
      ['plan', false],
      ['plan', true],
      ['auto', false]
    ]) {
      fake.state.started.length = 0;
      fake.state.resumed.length = 0;
      fake.state.runs.length = 0;
      const d = new CodexRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
        createClient: (opts) => new fake.Codex(opts),
        resolveExecutable: async () => ({ ok: true, packaged: false }),
        hostMcpScript: path.join(root, 'src/main/inboundMcp/stdioEntry.ts')
      });
      const { conn } = await connectAndCollect(
        d,
        makeInput({
          mode,
          planExecuting,
          getPolicyState: () => ({ mode, planExecuting })
        })
      );
      const sendP = conn.send('hi');
      await waitFor(() => fake.state.runs.length === 1, 'runStreamed');
      fake.state.feed.end();
      await sendP;
      const opts = fake.state.started[0];
      assert.equal(opts.sandboxMode, undefined);
      assert.equal(opts.approvalPolicy, undefined);
      assert.equal(opts.workingDirectory, tmp);
      await conn.close();
    }
  });

  await check('回放：thread.started/delta/command/turn.completed → 事件与 resume-token', async () => {
    fake.state.runs.length = 0;
    fake.state.started.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    const sendP = conn.send('你好');
    await waitFor(() => fake.state.runs.length === 1, 'run');
    assert.equal(fake.state.runs[0].input, '你好\n\n<muster_host_context source="automatic">\n【政策层】你是测试 Worker\n</muster_host_context>');
    const h = fake.state.feed;
    h.emit({ type: 'thread.started', thread_id: 'thr-a' });
    h.emit({
      type: 'item.updated',
      item: { id: 'm1', type: 'agent_message', text: '回答' }
    });
    h.emit({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: '回答正文' }
    });
    h.emit({
      type: 'item.updated',
      item: { id: 'r1', type: 'reasoning', text: '想一想' }
    });
    h.emit({
      type: 'item.started',
      item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' }
    });
    h.emit({
      type: 'item.completed',
      item: {
        id: 'c1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'ok',
        exit_code: 0,
        status: 'completed'
      }
    });
    h.emit({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 2,
        cache_write_input_tokens: 1,
        reasoning_output_tokens: 3
      }
    });
    h.end();
    await sendP;
    await waitFor(() => events.some((e) => e.type === 'turn-complete'), '收口');
    // 轨迹收窄为 Pi 专属：codex 不再产出任何 trace 事件
    const kinds = events.map((e) => e.type);
    assert.deepEqual(kinds, [
      'resume-token',
      'text-delta',
      'text-delta',
      'thinking-delta',
      'tool-start',
      'tool-result',
      'turn-complete'
    ]);
    assert.equal(events.find((e) => e.type === 'resume-token').token, 'thr-a');
    const ts = events.find((e) => e.type === 'tool-start');
    assert.equal(ts.toolName, 'command_execution');
    assert.deepEqual(ts.input, { command: 'npm test' });
    const tr = events.find((e) => e.type === 'tool-result');
    assert.equal(tr.ok, true);
    assert.equal(tr.output, 'ok');
    await conn.close();
  });

  await check('resumeToken → resumeThread；redirect 恒 false', async () => {
    fake.state.resumed.length = 0;
    fake.state.runs.length = 0;
    const { conn } = await connectAndCollect(driver, makeInput({ resumeToken: 'thr-old' }));
    assert.equal(conn.redirect('插一句'), false);
    const sendP = conn.send('继续');
    await waitFor(() => fake.state.runs.length === 1, 'run');
    assert.equal(fake.state.resumed[0].id, 'thr-old');
    fake.state.feed.emit({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } });
    fake.state.feed.end();
    await sendP;
    await conn.close();
  });

  await check('resume 线程失效 → 丢弃旧 id，下一条消息新建线程自愈', async () => {
    fake.state.resumed.length = 0;
    fake.state.started.length = 0;
    fake.state.runs.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({ resumeToken: 'thr-gone' }));
    const sendP1 = conn.send('第一句');
    await waitFor(() => fake.state.runs.length === 1, 'run#1');
    fake.state.feed.fail(new Error('session not found'));
    await sendP1;
    await waitFor(() => events.some((e) => e.type === 'error'), 'error 事件');
    // 回归：resume 失败后旧 threadId 必须被清掉，否则每条消息都重复失败
    const sendP2 = conn.send('第二句');
    await waitFor(() => fake.state.runs.length === 2, 'run#2');
    assert.equal(fake.state.started.length, 1, '第二次发送走 startThread（自愈）');
    assert.equal(fake.state.resumed.length, 1, '不再反复 resume 已失效线程');
    fake.state.feed.emit({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } });
    fake.state.feed.end();
    await sendP2;
    await conn.close();
  });

  await check('回归：网络类错误（ENOTFOUND/No such host/404）不得清空 threadId', async () => {
    for (const msg of [
      'getaddrinfo ENOTFOUND api.openai.com',
      'No such host is known.',
      'request failed with status 404 Not Found'
    ]) {
      fake.state.resumed.length = 0;
      fake.state.started.length = 0;
      fake.state.runs.length = 0;
      const { conn } = await connectAndCollect(driver, makeInput({ resumeToken: 'thr-net' }));
      const sendP = conn.send('联网任务');
      await waitFor(() => fake.state.runs.length === 1, 'run');
      fake.state.feed.fail(new Error(msg));
      await sendP;
      const sendP2 = conn.send('重试');
      await waitFor(() => fake.state.runs.length === 2, 'run#2');
      assert.equal(fake.state.resumed.length, 2, `网络错误保留线程继续 resume: ${msg}`);
      assert.equal(fake.state.started.length, 0, `网络错误不得新建线程: ${msg}`);
      fake.state.feed.emit({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } });
      fake.state.feed.end();
      await sendP2;
      await conn.close();
    }
  });

  await check('abort：AbortSignal aborted；错误流静默收口', async () => {
    fake.state.runs.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    const sendP = conn.send('长任务');
    await waitFor(() => fake.state.runs.length === 1, 'run');
    const signal = fake.state.runs[0].turnOptions.signal;
    const aborting = conn.abort();
    assert.equal(signal.aborted, true);
    fake.state.feed.fail(new Error('Codex Exec exited with signal SIGTERM'));
    await aborting;
    await sendP;
    await waitFor(() => events.some((e) => e.type === 'turn-complete' || e.type === 'error'), '收口');
    assert.equal(events.filter((e) => e.type === 'error').length, 0);
    await conn.close();
  });

  await check('turn.failed → error 事件', async () => {
    fake.state.runs.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    const sendP = conn.send('干活');
    await waitFor(() => fake.state.runs.length === 1, 'run');
    fake.state.feed.emit({ type: 'turn.failed', error: { message: 'quota exceeded' } });
    fake.state.feed.end();
    await sendP;
    await waitFor(() => events.some((e) => e.type === 'error'), 'error');
    assert.match(events.find((e) => e.type === 'error').message, /quota exceeded/);
    await conn.close();
  });

  await check('图片：text + local_image 路径', async () => {
    fake.state.runs.length = 0;
    const { conn } = await connectAndCollect(driver, makeInput({}));
    const sendP = conn.send('看图', [{ data: Buffer.from('hi').toString('base64'), mimeType: 'image/png' }]);
    await waitFor(() => fake.state.runs.length === 1, 'run');
    const input = fake.state.runs[0].input;
    assert.ok(Array.isArray(input));
    assert.equal(input[0].type, 'text');
    assert.equal(input[1].type, 'local_image');
    assert.equal(fs.existsSync(input[1].path), true, '回合中临时文件存在');
    fake.state.feed.emit({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } });
    fake.state.feed.end();
    await sendP;
    await conn.close();
  });

  await check('P1-2：resumeThread 同步抛错 → send reject、临时图清理、连接可复用', async () => {
    const fake2 = makeFakeSdk();
    const origResume = fake2.Codex.prototype.resumeThread;
    let failNextResume = true;
    fake2.Codex.prototype.resumeThread = function (id, options) {
      if (failNextResume) {
        failNextResume = false;
        throw new Error('boom: bad thread options');
      }
      return origResume.call(this, id, options);
    };
    const driver2 = new CodexRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
      createClient: (opts) => new fake2.Codex(opts),
      resolveExecutable: async () => ({ ok: true, executable: undefined, packaged: false }),
      hostMcpScript: path.join(root, 'src/main/inboundMcp/stdioEntry.ts')
    });
    const { conn, events } = await connectAndCollect(driver2, makeInput({ resumeToken: 'th-1' }));
    const imgDirsBefore = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('muster-codex-img-'));
    await assert.rejects(
      () => conn.send('看图', [{ data: Buffer.from('hi').toString('base64'), mimeType: 'image/png' }]),
      /boom/,
      '构造失败应上抛（Host 收口回合）'
    );
    const imgDirsAfter = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('muster-codex-img-'));
    assert.deepEqual(imgDirsAfter, imgDirsBefore, '临时图目录已清理（P1-2 不再泄漏）');
    // 连接可复用：turnActive 已复位，第二次 send 不命中「本回合尚未结束」
    const sendP = conn.send('再来');
    await waitFor(() => fake2.state.runs.length === 1, 'second run');
    fake2.state.feed.emit({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } });
    fake2.state.feed.end();
    await sendP;
    await waitFor(() => events.some((e) => e.type === 'turn-complete'), '收口');
    await conn.close();
  });

  await check('失败命令 tool-result ok:false', async () => {
    fake.state.runs.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    const sendP = conn.send('x');
    await waitFor(() => fake.state.runs.length === 1, 'run');
    fake.state.feed.emit({
      type: 'item.completed',
      item: {
        id: 'c2',
        type: 'command_execution',
        command: 'false',
        aggregated_output: 'boom',
        exit_code: 1,
        status: 'failed'
      }
    });
    fake.state.feed.emit({
      type: 'turn.completed',
      usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 }
    });
    fake.state.feed.end();
    await sendP;
    await waitFor(() => events.some((e) => e.type === 'tool-result'), 'tool-result');
    assert.equal(events.find((e) => e.type === 'tool-result').ok, false);
    await conn.close();
  });
} finally {
  delete process.env.MUSTER_TEST_KEEP;
  delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`codex-driver-replay: ${failed} 项失败`);
  process.exit(1);
}
console.log('codex-driver-replay: 全部通过');
