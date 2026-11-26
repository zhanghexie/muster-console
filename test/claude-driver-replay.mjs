/**
 * Claude GUI driver 离线回放自测（T2.1 DoD）：
 * - 假 SDK handle 注入（claudeSdk.ts 可注入缝）回放 SDK 消息流 → GuiDriverStreamEvent 映射；
 * - connect 期 options 断言（env 清洗 / resume / native permissionMode + canUseTool /
 *   systemPrompt preset / AskUserQuestion 禁用 / 宿主工具 MCP 注册与整 server 放行）；
 * - 回合生命周期：send 前缀 / redirect 真 steer / abort=interrupt / 崩溃自愈收口；
 * - 宿主工具 MCP 通道权限门控（与 Cursor customTools 同一决策表：status auto、
 *   shell prompt→审批卡、ask 档 deny）。
 * 真机链路由 test/claude-sdk-smoke.mjs（EXCLUDE）覆盖。
 * 运行: node test/claude-driver-replay.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 编译产物放仓内 .tmp：hostTools 的 zod/v4 动态 import 要能解析到仓库 node_modules
const tmp = path.join(root, '.tmp', 'claude-driver-replay');
fs.rmSync(tmp, { recursive: true, force: true });
const compile = createSharedCompiler(root, tmp);

const driverOut = compile('main/agentSession/drivers/claude/driver.ts');
const { pathToFileURL } = await import('node:url');
const { ClaudeRuntimeDriver } = await import(pathToFileURL(driverOut).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, timeout = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时: ${label}`);
    await sleep(10);
  }
}

// ---------- 假 SDK ----------
class FakeHandle {
  constructor() {
    this.msgs = [];
    this.waiters = [];
    this.ended = false;
    this.err = null;
    this.interruptCalls = 0;
    this.closeCalls = 0;
  }
  emit(msg) {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.msgs.push(msg);
  }
  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  fail(err) {
    this.err = err;
    for (const w of this.waiters.splice(0)) w(Promise.reject(err));
  }
  async interrupt() {
    this.interruptCalls += 1;
  }
  close() {
    this.closeCalls += 1;
    this.end();
  }
  [Symbol.asyncIterator]() {
    const next = () => {
      if (this.msgs.length) return Promise.resolve({ value: this.msgs.shift(), done: false });
      if (this.err) return Promise.reject(this.err);
      if (this.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => this.waiters.push(resolve));
    };
    return { next };
  }
}

/** 假 SDK 模块：query 注入缝 + tool/createSdkMcpServer 记录注册面 */
function makeFakeSdk() {
  const state = { captured: [], feedConsumed: [], handle: null, tools: [], server: null };
  const queryFn = (params) => {
    state.captured.push(params);
    state.feedConsumed = [];
    // 后台消费流式 prompt：回放 feed 内容用
    void (async () => {
      try {
        for await (const m of params.prompt) state.feedConsumed.push(m);
      } catch {
        /* feed 中止 */
      }
    })();
    const h = new FakeHandle();
    state.handle = h;
    return h;
  };
  const mod = {
    query: queryFn,
    tool: (name, description, shape, handler) => {
      const def = { name, description, shape, handler };
      state.tools.push(def);
      return def;
    },
    createSdkMcpServer: (opts) => {
      state.server = { type: 'sdk', name: opts.name, alwaysLoad: opts.alwaysLoad };
      return state.server;
    }
  };
  return { state, mod };
}

function makeInput(overrides = {}) {
  return {
    sessionId: 'sess-1',
    nativePermissions: true,
    cwd: tmp,
    firstPromptPrefix: '【宿主说明】你是测试 Worker',
    systemPromptAppend: 'Mode persona fixture',
    mode: 'default',
    planExecuting: false,
    permissionMode: 'acceptEdits',
    modeController: {},
    hostTools: [],
    requestApproval: async () => ({ approved: true }),
    requestUserQuestion: async () => ({ kind: 'aborted' }),
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    log: () => {},
    ...overrides
  };
}

function makeContext(config = {}) {
  return {
    config: {
      effectiveMcp: () => ({ enabled: false, servers: [] }),
      ...config
    }
  };
}

/** 连接 + 收集事件流 */
async function connectAndCollect(driver, input) {
  const conn = await driver.connect(input);
  const events = [];
  const pump = (async () => {
    for await (const ev of conn.events) events.push(ev);
  })();
  return { conn, events, pump };
}

// ---------- env 哨兵（提前注入，验证剥离） ----------
const SENTINELS = {
  CLAUDE_CODE_CHILD_SESSION: '1',
  ANTHROPIC_API_KEY: 'sk-test-must-be-scrubbed',
  MUSTER_TEST_KEEP: 'kept'
};
for (const [k, v] of Object.entries(SENTINELS)) process.env[k] = v;

let failed = 0;
const section = (name) => console.log(`\n—— ${name} ——`);
const check = (name, fn) => {
  return fn().then(
    () => console.log(`  ✓ ${name}`),
    (e) => {
      failed += 1;
      console.error(`  ✗ ${name}: ${e.stack}`);
    }
  );
}

try {
  const fake = makeFakeSdk();
  const executable = path.join(tmp, 'user bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const driver = new ClaudeRuntimeDriver(makeContext(), { userDataDir: tmp }, {
    queryFn: fake.mod.query,
    loadSdk: async () => fake.mod,
    resolveExecutable: async () => ({ ok: true, executable, packaged: false })
  });

  // ============ A. connect options ============
  await check('multi-root options：额外可写目录进 SDK，隔离源仓不进', async () => {
    const extra = path.join(tmp, 'second-root');
    const base = { cwd: tmp, writableDirectories: [{ path: tmp }, { path: extra }] };
    const first = await connectAndCollect(driver, makeInput({ workspaceContext: base }));
    await waitFor(() => fake.state.captured.length > 0, 'multi-root query');
    assert.deepEqual(fake.state.captured.at(-1).options.additionalDirectories, [extra]);
    await first.conn.close();
    const isolated = await connectAndCollect(driver, makeInput({ workspaceContext: { ...base, writableDirectories: [{ path: tmp }] } }));
    await waitFor(() => fake.state.captured.length === 2, 'isolated query');
    assert.deepEqual(fake.state.captured.at(-1).options.additionalDirectories, []);
    await isolated.conn.close(); fake.state.captured.length = 0;
  });
  await check('connect options：env 清洗/剥离/保留 + resume + preset + partial + 权限档映射', async () => {
    const { conn } = await connectAndCollect(driver, makeInput({ resumeToken: 'resume-token-1' }));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const opts = fake.state.captured[0].options;
    assert.equal(opts.pathToClaudeCodeExecutable, executable, 'the SDK receives the discovered local CLI');
    assert.equal(opts.resume, 'resume-token-1', 'resume 透传');
    assert.equal(opts.env.CLAUDE_CODE_CHILD_SESSION, undefined, 'CLAUDE_CODE_CHILD_SESSION 必须剥离（wmux 实证坑）');
    assert.equal(opts.env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY 必须剥离（订阅鉴权前提）');
    assert.equal(opts.env.MUSTER_TEST_KEEP, 'kept', '无关 env 保留');
    const expectedDir = process.env.CLAUDE_CONFIG_DIR?.trim()
      ? process.env.CLAUDE_CONFIG_DIR.trim()
      : path.join(os.homedir(), '.claude');
    assert.equal(opts.env.CLAUDE_CONFIG_DIR, expectedDir, '缺省共享用户 claude 配置目录');
    assert.deepEqual(opts.systemPrompt, { type: 'preset', preset: 'claude_code' }, '引擎基底走 claude_code preset');
    assert.equal(opts.includePartialMessages, true, '流式增量开启');
    assert.equal(opts.strictMcpConfig, true, '不继承原生CLI MCP，避免绕过GUI绑定');
    assert.equal(opts.permissionMode, undefined, 'SDK uses its native defaults when no mode was chosen');
    assert.equal(typeof opts.canUseTool, 'function', '挂上 canUseTool');
    assert.equal(typeof opts.hooks?.PreToolUse?.[0]?.hooks?.[0], 'function', '安装文件审阅的写前钩子');
    assert.equal(typeof opts.hooks?.PostToolUse?.[0]?.hooks?.[0], 'function', '安装文件审阅的写后钩子');
    assert.ok(opts.disallowedTools.includes('AskUserQuestion'), '原生问卷工具禁用');
    assert.ok(typeof (fake.state.captured[0].prompt[Symbol.asyncIterator]) === 'function', '流式 prompt（AsyncIterable）');
    await conn.close();
  });

  await check('B2：options.mcpServers 只装宿主内联项；用户 MCP（含 GUI 绑定项）不注入', async () => {
    // 守卫：若 driver 违约读用户 MCP（应已删分支），本用例转红
    const guardContext = {
      config: {
        effectiveMcp: (_workspaceId, targetId) => {
          throw new Error(`B2: Claude GUI driver must not read user MCP (target=${targetId})`);
        }
      }
    };
    for (const withHostTools of [false, true]) {
      const local = makeFakeSdk();
      const d = new ClaudeRuntimeDriver(guardContext, { userDataDir: tmp }, {
        queryFn: local.mod.query,
        loadSdk: async () => local.mod,
        resolveExecutable: async () => ({ ok: true, packaged: false })
      });
      const { conn } = await connectAndCollect(
        d,
        withHostTools
          ? makeInput({
              hostTools: [
                {
                  id: 'sessions.setStatus',
                  label: '状态',
                  description: '上报',
                  parameters: { type: 'object' },
                  permissionClass: 'status',
                  execute: async () => 'ok'
                }
              ]
            })
          : makeInput({ requestUserQuestion: undefined })
      );
      const options = local.state.captured.at(-1).options;
      assert.equal(options.strictMcpConfig, true, 'strictMcpConfig 保留：不继承原生 CLI MCP');
      if (withHostTools) {
        assert.deepEqual(Object.keys(options.mcpServers ?? {}), ['muster'], '只装宿主 muster server');
        assert.equal(options.allowedTools, undefined, 'native permission rules apply to the host MCP server');
      } else {
        assert.equal(options.mcpServers, undefined, '无宿主工具通道时不挂 mcpServers，也不注入用户 MCP');
        assert.equal(options.allowedTools, undefined);
      }
      await conn.close();
    }
  });

  await check('Claude automatic permissions opt into native bypass and preserve manual restore', async () => {
    const journal = [];
    const auto = await connectAndCollect(driver, makeInput({ automaticPermissions: true,
      async onNativePermissionRestore(selections) { journal.push(selections); } }));
    const autoOptions = fake.state.captured.at(-1).options;
    if (process.getuid?.() === 0) {
      assert.equal(autoOptions.permissionMode, undefined);
      assert.equal(autoOptions.allowDangerouslySkipPermissions, undefined);
      assert.deepEqual(journal, []);
    } else {
      assert.equal(autoOptions.permissionMode, 'bypassPermissions');
      assert.equal(autoOptions.allowDangerouslySkipPermissions, true);
      assert.deepEqual(journal, [[{ id: 'permissionMode', value: 'default' }]]);
    }
    await auto.conn.close();
    const selection = [{ id: 'permissionMode', value: 'plan' }];
    const restored = await connectAndCollect(driver, makeInput({
      getNativePermissionRestore: () => selection,
      nativeConfig: { identity: { runtimeId: 'claude', sourceKey: 'fixture' }, selections: selection },
      async onNativePermissionRestore(selections) { journal.push(selections); }
    }));
    assert.equal(fake.state.captured.at(-1).options.permissionMode, 'plan');
    assert.equal(fake.state.captured.at(-1).options.allowDangerouslySkipPermissions, undefined);
    fake.state.handle.emit({ type: 'system', subtype: 'init', permissionMode: 'plan' });
    await waitFor(() => journal.length > 0 && journal.at(-1) === undefined, 'confirm native permission restore');
    await restored.conn.close();
  });

  await check('Claude sends a native launch mode and waits for native state on live updates', async () => {
    fake.state.captured.length = 0;
    const { conn } = await connectAndCollect(driver, makeInput({ nativeConfig: {
      identity: { runtimeId: 'claude', sourceKey: 'fixture' }, selections: [{ id: 'permissionMode', value: 'dontAsk' }]
    } }));
    const handle = fake.state.handle;
    const opts = fake.state.captured.at(-1).options;
    assert.equal(opts.permissionMode, 'dontAsk');
    assert.equal(opts.allowDangerouslySkipPermissions, undefined);
    assert.equal(conn.getNativeConfig().options[0].currentValue, undefined);
    handle.emit({ type: 'system', subtype: 'init', permissionMode: 'dontAsk' });
    await waitFor(() => conn.getNativeConfig().options[0].currentValue === 'dontAsk', 'native init');
    const requested = [];
    handle.setPermissionMode = async mode => requested.push(mode);
    await conn.setNativeConfig('permissionMode', 'auto');
    assert.deepEqual(requested, ['auto']);
    assert.equal(conn.getNativeConfig().options[0].currentValue, 'dontAsk');
    handle.emit({ type: 'system', subtype: 'status', permissionMode: 'auto' });
    await waitFor(() => conn.getNativeConfig().options[0].currentValue === 'auto', 'native status');
    await assert.rejects(() => conn.setNativeConfig('permissionMode', 'bypassPermissions'), /startup|launch/i);
    await conn.close();
  });

  await check('打包版找不到用户 claude 安装 → connect 报引导错误', async () => {
    const d = new ClaudeRuntimeDriver(makeContext(), { userDataDir: tmp }, {
      queryFn: fake.mod.query,
      loadSdk: async () => fake.mod,
      resolveExecutable: async () => ({ ok: false, packaged: true })
    });
    await assert.rejects(() => d.connect(makeInput()), /Claude（GUI）/);
  });

  await check('隔离配置：CLAUDE_CONFIG_DIR 指向 userData/agents/claude-gui', async () => {
    const d = new ClaudeRuntimeDriver(
      makeContext({ get: () => ({ claude: { isolateConfig: true } }) }),
      { userDataDir: tmp },
      {
        queryFn: fake.mod.query,
        loadSdk: async () => fake.mod,
        resolveExecutable: async () => ({ ok: true, packaged: false })
      }
    );
    const c = await d.connect(makeInput());
    await waitFor(() => fake.state.captured.length >= 1, 'query 被调用');
    const o = fake.state.captured[fake.state.captured.length - 1].options;
    assert.equal(o.env.CLAUDE_CONFIG_DIR, path.join(tmp, 'agents', 'claude-gui'));
    assert.equal(fs.existsSync(o.env.CLAUDE_CONFIG_DIR), true, '隔离目录已创建');
    await c.close();
  });

  // ============ B. 消息流回放 ============
  await check('回放：init/delta/tool_use/tool_result/result → 事件序列与 resume-token', async () => {
    fake.state.captured.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const h = fake.state.handle;
    await conn.send('你好');
    // 首条用户消息之后附带宿主说明
    await waitFor(() => feedOf(fake).length === 1, 'feed 收到首条消息');
    const first = feedOf(fake)[0];
    assert.equal(first.message.content, '你好\n\n<muster_host_context source="automatic">\n【宿主说明】你是测试 Worker\n\nMode persona fixture\n</muster_host_context>');
    h.emit({ type: 'system', subtype: 'init', session_id: 'sess-a', model: 'claude-sonnet-5', tools: ['Read', 'Bash'] });
    h.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '回答' } } });
    h.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } } });
    h.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '想一想' } } });
    h.emit({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '想一想' },
      { type: 'text', text: '回答正文' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }
    ] }, parent_tool_use_id: null });
    h.emit({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '文件内容…' }
    ] }, parent_tool_use_id: null });
    h.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-a', result: 'ok',
      usage: {}, modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, thinkingTokens: 3 } },
      permission_denials: [], errors: [] });
    await waitFor(() => events.some((e) => e.type === 'turn-complete'), '回合收口');
    const kinds = events.map((e) => e.type);
    // 轨迹收窄为 Pi 专属：claude 不再产出任何 trace 事件
    assert.deepEqual(
      kinds,
      ['resume-token', 'text-delta', 'text-delta', 'thinking-delta', 'tool-start', 'tool-result', 'turn-complete'],
      `事件序列（实际: ${kinds.join(',')}）`
    );
    // 定稿 assistant 的 text/thinking 已流式送达：不得重复发 delta（序列里只有 2 条 text-delta）
    assert.equal(events.filter((e) => e.type === 'text-delta').length, 2);
    const ts = events.find((e) => e.type === 'tool-start');
    assert.equal(ts.toolCallId, 'toolu_1');
    assert.equal(ts.toolName, 'Read');
    assert.deepEqual(ts.input, { file_path: 'a.ts' });
    const tr = events.find((e) => e.type === 'tool-result');
    assert.equal(tr.toolCallId, 'toolu_1');
    assert.equal(tr.toolName, 'Read', 'tool_result 回查 tool-start 记的名字');
    assert.equal(tr.ok, true);
    assert.equal(tr.output, '文件内容…');
    await conn.close();
  });

  await check('回放：错误 tool_result / 子代理帧不摊主聊天 / 未知帧安静丢弃', async () => {
    fake.state.captured.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const h = fake.state.handle;
    await conn.send('继续');
    h.emit({ type: 'system', subtype: 'init', session_id: 'sess-b', tools: [] });
    h.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a"' } } });
    h.emit({ type: 'assistant', parent_tool_use_id: 'parent-1', message: { role: 'assistant', content: [{ type: 'text', text: '子代理输出' }] } });
    h.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test' } }] }, parent_tool_use_id: null });
    h.emit({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }
    ] }, parent_tool_use_id: null });
    h.emit({ type: 'stream_event', event: { type: 'message_start', message: {} } });
    h.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-b', result: '', usage: {}, modelUsage: {}, permission_denials: [], errors: [] });
    await waitFor(() => events.some((e) => e.type === 'turn-complete'), '回合收口');
    const nonTrace = events.filter((e) => e.type !== 'resume-token');
    assert.deepEqual(
      nonTrace.map((e) => e.type),
      ['tool-start', 'tool-result', 'turn-complete'],
      'input_json_delta/message_start/子代理帧都不产生事件'
    );
    assert.equal(nonTrace.find((e) => e.type === 'tool-result').ok, false, 'is_error → ok:false');
    assert.equal(nonTrace.find((e) => e.type === 'tool-result').output, 'line1\nline2');
    await conn.close();
  });

  // ============ C. 回合生命周期 ============
  await check('原生队列：result 逐条消费、普通信不打断、优先信 interrupt 后等收口，不假报 steer', async () => {
    fake.state.captured.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const h = fake.state.handle;
    await conn.send('第一条');
    await waitFor(() => feedOf(fake).length === 1, '首条入 feed');
    assert.equal(conn.redirect('插一句'), false, '输入队列不冒充 steer');
    assert.deepEqual(await conn.receiveMessage({ intent: 'normal', messageId: 'normal', text: '后续信' }), { status: 'accepted', method: 'queued' });
    assert.equal(feedOf(fake).length, 1);
    assert.equal(h.interruptCalls, 0, '普通信不打断');
    assert.deepEqual(await conn.receiveMessage({ intent: 'interrupt', messageId: 'priority', text: '优先信' }), { status: 'accepted', method: 'queued' });
    assert.equal(h.interruptCalls, 1);
    assert.equal(feedOf(fake).length, 1, 'interrupt 请求不等于停止确认');
    h.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: '', usage: {}, modelUsage: {}, permission_denials: [], errors: [] });
    await waitFor(() => feedOf(fake).length === 2, '优先信在 result 后入 feed');
    assert.deepEqual(feedOf(fake)[1].message, { role: 'user', content: '优先信' });
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 0, '队列未排空不能结束 Host busy');
    h.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 's' });
    await waitFor(() => feedOf(fake).length === 3, '后续信继续');
    assert.equal(feedOf(fake)[2].message.content, '后续信');
    assert.deepEqual(events.filter(e => e.type === 'native-message-start').map(e => e.messageId), ['priority', 'normal']);
    h.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 's' });
    await sleep(50);
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 1);
    assert.equal(conn.redirect('再插'), false, '回合外 redirect 拒绝（Host 改入队）');
    await conn.close();
  });

  await check('abort：interrupt 被调；中止后的错误 result 静默收口（不弹错误）', async () => {
    fake.state.captured.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const h = fake.state.handle;
    await conn.send('跑个长任务');
    await conn.abort();
    assert.equal(h.interruptCalls, 1, 'interrupt 恰好一次');
    h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], errors: ['interrupted by user'], session_id: 's' });
    await waitFor(() => events.some((e) => e.type === 'turn-complete' || e.type === 'error'), '收口');
    assert.equal(events.filter((e) => e.type === 'error').length, 0, '中止不算错误');
    assert.ok(events.some((e) => e.type === 'turn-complete'), 'turn-complete 收口');
    await conn.close();
  });

  await check('未中止的错误 result → error 事件（max turns 文案）', async () => {
    fake.state.captured.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const h = fake.state.handle;
    await conn.send('干活');
    h.emit({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 50, stop_reason: null, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], errors: ['max turns reached'], session_id: 's' });
    await waitFor(() => events.some((e) => e.type === 'error'), 'error 事件');
    assert.match(events.find((e) => e.type === 'error').message, /最大回合数/);
    await conn.close();
  });

  await check('子进程崩溃（事件流抛错）：回合中收口错误带自愈指引、无 turn-complete 后续', async () => {
    fake.state.captured.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const h = fake.state.handle;
    await conn.send('长回合');
    h.fail(new Error('claude.exe exited (code 1)'));
    await waitFor(() => events.some((e) => e.type === 'error'), '崩溃收口');
    assert.match(events.find((e) => e.type === 'error').message, /自动重连恢复/);
    await sleep(50);
    assert.equal(events.filter((e) => e.type === 'turn-complete').length, 0, '崩溃路径是 error 不是 turn-complete');
    await assert.rejects(() => conn.send('再来'), /连接已中断/, '死后 send 拒绝');
    // P1-7：崩溃路径不能因已置 closed 而跳过底层回收（SDK 子进程句柄无人释放）
    assert.equal(h.closeCalls, 1, '流异常后 handle.close 必须被调用');
  });

  await check('M-6：降级路径（无流式增量）重复文本块各自补发', async () => {
    fake.state.captured.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const h = fake.state.handle;
    await conn.send('重复结论');
    const block = { type: 'text', text: '同样的结论' };
    h.emit({ type: 'assistant', message: { role: 'assistant', content: [block] }, parent_tool_use_id: null });
    h.emit({ type: 'assistant', message: { role: 'assistant', content: [{ ...block }] }, parent_tool_use_id: null });
    await waitFor(
      () => events.filter((e) => e.type === 'text-delta' && e.delta === '同样的结论').length === 2,
      '两个相同文本块都补发（旧 includes 去重会吞第二个）'
    );
    h.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: {} });
    await waitFor(() => events.some((e) => e.type === 'turn-complete'), '收口');
    await conn.close();
  });

  await check('M-6：resume 回放（isReplay）的 tool_result 不映射', async () => {
    fake.state.captured.length = 0;
    const { conn, events } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const h = fake.state.handle;
    await conn.send('干活');
    h.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: 'a.ts' } }] }, parent_tool_use_id: null });
    await waitFor(() => events.some((e) => e.type === 'tool-start'), 'tool-start');
    // 历史回放的 tool_result（isReplay=true）：不得映射成本回合 tool-result
    h.emit({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: '历史内容' }] }, parent_tool_use_id: null });
    await sleep(50);
    assert.equal(events.some((e) => e.type === 'tool-result'), false, 'M-6：回放 tool_result 不冒充本回合收口');
    // 同形消息无 isReplay（真实回填）：正常映射
    h.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: '真实结果' }] }, parent_tool_use_id: null });
    await waitFor(() => events.some((e) => e.type === 'tool-result'), '真实 tool_result 映射');
    h.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: {} });
    await waitFor(() => events.some((e) => e.type === 'turn-complete'), '收口');
    await conn.close();
  });

  await check('图片消息：content 为 text+image 块', async () => {
    fake.state.captured.length = 0;
    const { conn } = await connectAndCollect(driver, makeInput({}));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    await conn.send('看图', [{ data: 'aGk=', mimeType: 'image/png' }]);
    await waitFor(() => feedOf(fake).length === 1, 'feed 收到消息');
    const content = feedOf(fake)[0].message.content;
    assert.ok(Array.isArray(content), '带图消息 content 是块数组');
    assert.equal(content[0].type, 'text');
    assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } });
    await conn.close();
  });

  // ============ D. 宿主工具 MCP 注册与门控 ============
  await check('宿主工具经 createSdkMcpServer 注册：下划线名 + alwaysLoad + 整 server 放行 + 目录前缀语义', async () => {
    fake.state.captured.length = 0;
    fake.state.tools.length = 0;
    const hostTools = [
      { id: 'sessions.setStatus', label: '状态', description: '上报状态', argsHint: 'phase/note', parameters: { type: 'object', properties: { phase: { type: 'string', enum: ['needs_you', 'done'] }, note: { type: 'string' } } }, permissionClass: 'status', execute: async () => 'ok-status' },
      { id: 'sessions.rename', label: '更名', description: '更名', parameters: { type: 'object', properties: { name: { type: 'string' } } }, permissionClass: 'status', execute: async () => 'ok-rename' },
      { id: 'sessions.requestIntegrate', label: '合入', description: '通知调度合入', parameters: { type: 'object', properties: {} }, permissionClass: 'status', execute: async () => 'ok-integrate' },
      { id: 'ui.notify', label: '通知', description: '通知', parameters: { type: 'object', properties: { text: { type: 'string' } } }, permissionClass: 'status', execute: async () => 'ok-notify' },
      { id: 'bgtasks.shell', label: '后台命令', description: '跑后台命令', parameters: { type: 'object', properties: { command: { type: 'string' } } }, permissionClass: 'shell', execute: async () => 'shell-done' },
      { id: 'bgtasks.wait', label: '定时', description: '定时唤醒', parameters: { type: 'object', properties: { delaySec: { type: 'number' } } }, permissionClass: 'status', execute: async () => 'ok-wait' }
    ];
    const { conn } = await connectAndCollect(driver, makeInput({ hostTools }));
    await waitFor(() => fake.state.captured.length === 1, 'query 被调用');
    const opts = fake.state.captured[0].options;
    assert.ok(opts.mcpServers?.muster, 'mcpServers.muster 注册');
    assert.equal(opts.allowedTools, undefined, 'the SDK applies its native permission rules');
    assert.equal(
      fake.state.tools.map((t) => t.name).join(','),
      'sessions_setStatus,sessions_rename,sessions_requestIntegrate,ui_notify,bgtasks_shell,bgtasks_wait',
      '点号→下划线（状态四件套 + bgtasks）'
    );
    assert.equal(fake.state.server.alwaysLoad, true, '小工具常驻提示词');
    await conn.close();
  });

  await check('Claude registers only the projected question tool when a host question channel is available', async () => {
    fake.state.captured.length = 0;
    fake.state.tools.length = 0;
    const { conn } = await connectAndCollect(driver, makeInput({
      hostTools: [{ id: 'host.ask', label: 'Ask', description: 'Ask the user',
        parameters: { type: 'object', properties: {} }, permissionClass: 'status',
        execute: async () => JSON.stringify({ answers: [{ id: 'arch', selected: ['A'] }] }) }],
      requestUserQuestion: async () => assert.fail('Claude must call the projected tool')
    }));
    try {
      assert.ok(fake.state.captured[0].options.mcpServers?.muster);
      assert.deepEqual(fake.state.tools.map(tool => tool.name), ['host_ask']);
      await conn.send('Which design should we use?');
      const result = await fake.state.tools[0].handler({ kind: 'choice' });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(result.content[0].text), { answers: [{ id: 'arch', selected: ['A'] }] });
    } finally { await conn.close(); }
  });

  await check('Claude native MCP calls keep turn identity without inheriting host permission modes', async () => {
    fake.state.tools.length = 0;
    let executions = 0;
    const hostTools = [{ id: 'bgtasks.shell', label: 'Shell', description: 'Execute', parameters: {
      type: 'object', properties: { command: { type: 'string' } }
    }, permissionClass: 'shell', execute: async () => { executions++; return 'shell-done'; } }];
    const { conn } = await connectAndCollect(driver, makeInput({ hostTools, mode: 'ask',
      requestApproval: async () => { throw new Error('Unexpected host-mode approval'); } }));
    const shell = fake.state.tools.find(tool => tool.name === 'bgtasks_shell');
    assert.ok(shell);
    assert.equal((await shell.handler({ command: 'npm test' })).isError, true);
    await conn.send('Validate the originating turn');
    assert.equal((await shell.handler({ command: 'npm test' })).content[0].text, 'shell-done');
    assert.equal(executions, 1);
    await conn.close();
    assert.equal((await shell.handler({ command: 'npm test' })).isError, true);
  });
} finally {
  for (const k of Object.keys(SENTINELS)) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;

/** 取最近一次 query 的 feed 已推送消息 */
function feedOf(fake) {
  return fake.state.feedConsumed;
}
