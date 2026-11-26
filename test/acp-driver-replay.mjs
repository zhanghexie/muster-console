/**
 * ACP GUI driver 离线回放（T5.2 DoD）：假 agent 子进程 NDJSON。
 * 运行: node test/acp-driver-replay.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.tmp', 'acp-driver-replay');
fs.rmSync(tmp, { recursive: true, force: true });
const compile = createSharedCompiler(root, tmp);
const driverOut = compile('main/agentSession/drivers/acp/driver.ts');
const { AcpRuntimeDriver } = await import(pathToFileURL(driverOut).href);
const { NdjsonRpc, NdjsonRpcResponseError } = await import(
  pathToFileURL(compile('main/agentSession/drivers/acp/jsonRpc.ts')).href
);

const fakeAgent = path.join(root, 'test/helpers/acp-fake-agent.mjs');
const hostMcp = path.join(root, 'src/main/inboundMcp/stdioEntry.ts');

function spawnAgentFile(script) {
  const child = spawn(process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const rpc = new NdjsonRpc(child.stdin, child.stdout);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', () => {});
  return {
    rpc,
    kill: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  };
}

// P1-3 专用挂死 agent（内联，不进共享 helper——helpers/ 改动会让提交门禁升全量）：
// - slowinit：initialize 永不响应（connect 超时路径）
// - hangprompt：握手正常、session/prompt 收到但永不响应（close 排水路径）
const slowinitAgent = path.join(tmp, 'fake-slowinit.mjs');
fs.writeFileSync(slowinitAgent, 'process.stdin.resume();\n');
const hangpromptAgent = path.join(tmp, 'fake-hangprompt.mjs');
fs.writeFileSync(
  hangpromptAgent,
  [
    "import readline from 'node:readline';",
    "function send(o){ process.stdout.write(JSON.stringify(o) + '\\n'); }",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    '  let msg; try { msg = JSON.parse(line); } catch { return; }',
    "  if (msg.method === 'initialize') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });",
    "  } else if (msg.method === 'session/new' || msg.method === 'session/load') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-sess-1' } });",
    '  }',
    '  // session/prompt：收到但永不响应',
    '});',
    "rl.on('close', () => process.exit(0));",
    ''
  ].join('\n')
);

function spawnFake(scenario) {
  if (scenario === 'slowinit') return spawnAgentFile(slowinitAgent);
  if (scenario === 'hangprompt') return spawnAgentFile(hangpromptAgent);
  const child = spawn(process.execPath, [fakeAgent], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ACP_FAKE_SCENARIO: scenario },
    windowsHide: true
  });
  const rpc = new NdjsonRpc(child.stdin, child.stdout);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', () => {});
  return {
    rpc,
    kill: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  };
}

function makeCtx() {
  return {
    sessions: { get: () => ({ workspaceId: 'ws-1' }) },
    config: {
      get: () => ({}),
      // B2 守卫：ACP driver 不再读用户 MCP 配置（被调到即红）
      effectiveMcp: () => {
        throw new Error('B2: ACP GUI driver must not read user MCP config');
      }
    }
  };
}

function makeInput(overrides = {}) {
  return {
    sessionId: 'sess-1',
    cwd: tmp,
    acpAgent: 'opencode',
    systemPromptAppend: '【政策层】ACP 测试',
    mode: 'default',
    planExecuting: false,
    permissionMode: 'acceptEdits',
    modeController: {},
    hostTools: [],
    requestApproval: async () => ({ approved: true }),
    getTurnId: () => 'turn-1',
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    log: () => {},
    ...overrides
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, timeout = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时: ${label}`);
    await sleep(15);
  }
}

async function connectCollect(driver, input) {
  const conn = await driver.connect(input);
  const events = [];
  const pump = (async () => {
    for await (const ev of conn.events) events.push(ev);
  })();
  return { conn, events, pump };
}

let failed = 0;
const check = (name, fn) =>
  fn().then(
    () => console.log(`  ok  ${name}`),
    (e) => {
      failed += 1;
      console.error(`  FAIL ${name}: ${e.message}`);
    }
  );

console.log('\n—— ACP driver 假 agent 回放 ——');

await check('Grok 子代理用量不能覆盖主会话圆环', async () => {
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => spawnFake('grok-usage'),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
  });
  const { conn, events } = await connectCollect(driver, makeInput({ acpAgent: 'grok' }));
  await conn.send('go');
  await waitFor(() => events.some(e => e.type === 'turn-complete'), 'turn-complete');
  assert.deepEqual(conn.getContextUsage(), { tokens: 80, contextWindow: 1000 });
  await conn.close();
});

await check('text 五事件合同：thought+message → turn-complete + resume-token', async () => {
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => spawnFake('text'),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
  });
  const { conn, events } = await connectCollect(driver, makeInput());
  await waitFor(() => events.some((e) => e.type === 'resume-token'), 'resume-token');
  await conn.send('hi');
  await waitFor(() => events.some((e) => e.type === 'turn-complete'), 'turn-complete');
  assert.ok(events.some((e) => e.type === 'thinking-delta' && e.delta === '想一下'));
  assert.ok(events.some((e) => e.type === 'text-delta' && e.delta === '你好 ACP'));
  assert.equal(events.filter((e) => e.type === 'turn-complete').length, 1);
  await conn.close();
});

await check('tool_call / tool_call_update → tool-start / tool-result', async () => {
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => spawnFake('tools'),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
  });
  const { conn, events } = await connectCollect(driver, makeInput());
  await conn.send('go');
  await waitFor(() => events.some((e) => e.type === 'turn-complete'), 'turn');
  const start = events.find((e) => e.type === 'tool-start');
  const result = events.find((e) => e.type === 'tool-result');
  assert.equal(start?.toolName, 'read');
  assert.equal(result?.ok, true);
  assert.equal(result?.output, 'ok');
  await conn.close();
});

await check('AvailableCommands + CurrentMode', async () => {
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => spawnFake('commands'),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
  });
  const { conn, events } = await connectCollect(driver, makeInput());
  await waitFor(() => events.some((e) => e.type === 'available-commands'), 'commands');
  await waitFor(() => events.some((e) => e.type === 'current-mode'), 'mode');
  const cmds = events.find((e) => e.type === 'available-commands');
  assert.ok(cmds.commands.some((c) => c.name === 'compact'));
  assert.equal(events.find((e) => e.type === 'current-mode')?.modeId, 'code');
  await conn.close();
});

await check('RequestPermission → 未知工具审批卡（default shell 保持自动执行）', async () => {
  let saw = null;
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => spawnFake('perm-unknown'),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
    approvalTimeoutMs: 3000
  });
  const { conn, events } = await connectCollect(
    driver,
    makeInput({
      requestApproval: async (req) => {
        saw = req;
        return { approved: false, reason: '拒绝危险命令' };
      }
    })
  );
  await conn.send('rm');
  await waitFor(() => events.some((e) => e.type === 'turn-complete'), 'perm turn');
  assert.ok(saw, '应弹出审批卡');
  assert.equal(saw.toolName, 'unknown_tool');
  await conn.close();
});

await check('session/new 注入 mcpServers：只有宿主 muster shim（B2 不再透传用户 MCP）', async () => {
  let capturedNew = null;
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: (cmd) => {
      const t = spawnFake('text');
      const orig = t.rpc.request.bind(t.rpc);
      t.rpc.request = (method, params, ...rest) => {
        if (method === 'session/new') capturedNew = params;
        return orig(method, params, ...rest);
      };
      return t;
    },
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
  });
  const hostTools = [
    {
      id: 'sessions.setStatus',
      label: '状态',
      description: '上报',
      parameters: { type: 'object' },
      permissionClass: 'status',
      execute: async () => 'ok'
    }
  ];
  const { conn } = await connectCollect(driver, makeInput({ hostTools }));
  await waitFor(() => capturedNew != null, 'session/new');
  const names = (capturedNew.mcpServers ?? []).map((s) => s.name);
  assert.deepEqual(names, ['muster'], 'session/new.mcpServers 只装宿主 shim，无用户 server');
  const host = capturedNew.mcpServers.find((s) => s.name === 'muster');
  assert.ok(host.env.some((e) => e.name === 'MUSTER_HOST_TOOLS_TOKEN'));
  await conn.close();
});

await check('authMethods 非空 → 照常连接（广告≠未登录，N-2）', async () => {
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => spawnFake('auth'),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
  });
  const { conn, events } = await connectCollect(driver, makeInput());
  await conn.send('hi');
  await waitFor(() => events.some((e) => e.type === 'turn-complete'), 'turn-complete');
  assert.ok(events.some((e) => e.type === 'text-delta' && e.delta === '你好 ACP'), 'auth 场景走完整回合');
  await conn.close();
});

await check('Antigravity 未登录时在聊天入口提示原生 CLI 的登录命令', async () => {
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => {
      const transport = spawnFake('auth');
      const request = transport.rpc.request.bind(transport.rpc);
      transport.rpc.request = (method, ...args) => method === 'session/new'
        ? Promise.reject(new NdjsonRpcResponseError(-32000, 'Authentication required'))
        : request(method, ...args);
      return transport;
    },
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
  });
  await assert.rejects(driver.connect(makeInput({ acpAgent: 'antigravity' })), /agy acp --login/);
  await assert.rejects(driver.connect(makeInput()), /Authentication required/);
});

await check('initialize 挂死 → connect 按超时拒绝（P1-3）', async () => {
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => spawnFake('slowinit'),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
    rpcTimeoutMs: 250,
  });
  const t0 = Date.now();
  await assert.rejects(() => driver.connect(makeInput()), /initialize 超时/);
  assert.ok(Date.now() - t0 < 4000, '不得挂到默认 30s');
});

await check('prompt 挂死 → close() 排水超时后强制清理（P1-3）', async () => {
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => spawnFake('hangprompt'),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
    closeDrainTimeoutMs: 200,
  });
  const { conn } = await connectCollect(driver, makeInput());
  await conn.send('永无响应');
  const t0 = Date.now();
  await conn.close(); // 回归：agent 不响应 session/prompt 时 close 不得永久挂起
  const dt = Date.now() - t0;
  assert.ok(dt < 4000, `close 应快速返回（实际 ${dt}ms）`);
});

await check('N-1：PATH 命中 .cmd shim → cmd.exe 包装后再 spawn', async () => {
  if (process.platform !== 'win32') return; // npm .cmd shim 是 Windows 特有路径
  const agentsOut = compile('main/agentSession/drivers/acp/agents.ts');
  const { resolveAcpLaunch } = await import(pathToFileURL(agentsOut).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cmd-'));
  fs.writeFileSync(path.join(dir, 'opencode.cmd'), '@echo off\r\n');
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const launch = resolveAcpLaunch('opencode');
    assert.equal(launch.command, 'cmd.exe', '.cmd shim 直接 spawn 会 EINVAL，必须经 cmd.exe');
    assert.ok(launch.args.includes('/c'), '/c 执行');
    const line = String(launch.args[launch.args.length - 1]);
    // PATHEXT 命中的扩展名可能是大写（.CMD），断言大小写不敏感
    assert.ok(/opencode\.cmd/i.test(line) && line.includes(' acp'), '命令行含 shim 路径与预设参数');
  } finally {
    process.env.PATH = oldPath;
  }
});

await check('N-6：网关建立后 spawn 抛错 → connect 拒绝且不留网关/临时目录', async () => {
  const hostTools = [
    {
      id: 'sessions.setStatus',
      label: '状态',
      description: '上报',
      parameters: { type: 'object' },
      permissionClass: 'status',
      execute: async () => 'ok'
    }
  ];
  const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('acp-host-mcp-'));
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => {
      throw new Error('spawn boom');
    },
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp
  });
  await assert.rejects(() => driver.connect(makeInput({ hostTools })), /spawn boom/);
  const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('acp-host-mcp-'));
  assert.deepEqual(after, before, 'N-6：清理范围覆盖网关创建段（无 acp-host-mcp-* 残留）');
});

await check('无 loadSession + resumeToken → 拒绝恢复，不冒充空会话', async () => {
  let loadCalled = false;
  let newCalled = null;
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => {
      const t = spawnFake('noload');
      const orig = t.rpc.request.bind(t.rpc);
      t.rpc.request = (method, params) => {
        if (method === 'session/load') loadCalled = true;
        if (method === 'session/new') newCalled = params;
        return orig(method, params);
      };
      return t;
    },
    resolveLaunch: () => ({ command: 'fake', args: [] }),
    hostMcpScript: hostMcp,
  });
  await assert.rejects(() => driver.connect(makeInput({ resumeToken: 'stale-session-from-last-process' })), /未声明会话恢复能力/);
  assert.equal(loadCalled, false, '未声明 loadSession 不得 session/load');
  assert.equal(newCalled, null, '不可静默创建空会话冒充原生恢复');
});

await check('agent 进程死亡（stdout EOF）→ 事件流收口 + 资源清理，不悬挂', async () => {
  const { PassThrough } = await import('node:stream');
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const rpc = new NdjsonRpc(agentIn, agentOut);
  const transport = { rpc, kill: () => {} };
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => transport,
    resolveLaunch: () => ({ command: 'fake', args: [] }),
  });
  // 手动应答握手，随后模拟 agent 崩溃（stdout end → EOF）
  let buf = '';
  agentIn.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id == null) continue;
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: 1, agentCapabilities: {} }
          : { sessionId: 'sess-die' };
      agentOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
  });
  const { conn, events } = await connectCollect(driver, makeInput());
  await waitFor(() => events.some((e) => e.type === 'resume-token'), '会话建立');
  let pumpDone = false;
  // 回归：agent 死后事件流必须结束（Host 据此拆连接、下一条消息重建），而非永久悬挂
  void (async () => {
    for await (const ev of conn.events) {
      void ev;
    }
    pumpDone = true;
  })();
  agentOut.end();
  await waitFor(() => pumpDone, '事件流收口');
  await conn.close(); // 死亡后 close 幂等，不得抛错
});

await check('B2：无论 agent 是否声明 HTTP MCP 能力，session/new 只装宿主 shim（无用户 HTTP server）', async () => {  const { PassThrough } = await import('node:stream');
  for (const supportsHttp of [true, false]) {
    const agentIn = new PassThrough();
    const agentOut = new PassThrough();
    const rpc = new NdjsonRpc(agentIn, agentOut);
    let sessionParams;
    let buf = '';
    agentIn.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id == null) continue;
        if (msg.method === 'session/new') sessionParams = msg.params;
        const result = msg.method === 'initialize'
          ? { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: supportsHttp } } }
          : { sessionId: 'http-caps-session' };
        agentOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      }
    });
    const warnings = [];
    const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, { spawnAgent: () => ({ rpc, kill: () => {} }), resolveLaunch: () => ({ command: 'fake', args: [] }) });
    const conn = await driver.connect(makeInput({ log: (level, message) => { if (level === 'warn') warnings.push(message); } }));
    // B2：initialize 的 mcpCapabilities 协商随用户 MCP 注入一起退役——不装用户 server 也就没有「未声明 HTTP」跳过
    assert.deepEqual(sessionParams.mcpServers, []);
    assert.equal(warnings.some(message => message.includes('未声明 HTTP')), false, '不再有用户 MCP 协商 warn');
    await conn.close();
  }
});

await check('Worker 路由只从终态 ACP RPC 的结构化数据识别额度', async () => {
  const message = 'quota exceeded';
  const scenarios = [
    { name: 'structured quota', error: { code: -32000, message,
      data: { status: 429, error: { code: 'insufficient_quota' } } }, reason: 'quota' },
    { name: 'bare rate limit', error: { code: -32000, message, data: { status: 429 } }, reason: 'rate-limit' },
    { name: 'message only', error: { code: -32000, message } },
    { name: 'transport closes before response' }
  ];
  for (const scenario of scenarios) {
    const agentIn = new PassThrough();
    const agentOut = new PassThrough();
    const rpc = new NdjsonRpc(agentIn, agentOut);
    const lines = createInterface({ input: agentIn });
    lines.on('line', line => {
      const request = JSON.parse(line);
      const respond = payload => agentOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...payload }) + '\n');
      if (request.method === 'initialize') respond({ result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (request.method === 'session/new') respond({ result: { sessionId: 'routing-fixture' } });
      else if (request.method === 'session/prompt') {
        if (scenario.error) respond({ error: scenario.error });
        else agentOut.destroy(new Error(message));
      }
    });
    const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
      spawnAgent: () => ({ rpc, kill: () => {} }),
      resolveLaunch: () => ({ command: 'fake', args: [] })
    });
    const { conn, events, pump } = await connectCollect(driver, makeInput());
    try {
      await conn.send('offline routing fixture');
      await waitFor(() => events.some(event => event.type === 'error'), scenario.name);
      const failure = events.find(event => event.type === 'error');
      assert.match(failure.message, /quota exceeded/, scenario.name);
      if (scenario.reason) {
        assert.equal(failure.workerFailure?.reason, scenario.reason, scenario.name);
        assert.equal(failure.workerFailure?.boundary, 'settled', scenario.name);
      } else {
        assert.equal(failure.workerFailure, undefined, scenario.name);
      }
      assert.equal(events.some(event => event.type === 'turn-complete'), false, scenario.name);
    } finally {
      lines.close();
      await conn.close();
      await pump;
    }
  }
});

await check('F-01：首条宿主说明只在引擎接收前失败时回填', async () => {
  const { PassThrough } = await import('node:stream');
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const rpc = new NdjsonRpc(agentIn, agentOut);
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    spawnAgent: () => ({ rpc, kill: () => {} }),
    resolveLaunch: () => ({ command: 'fake', args: [] }),
  });
  const prompts = [];
  let promptCount = 0;
  let buf = '';
  agentIn.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id == null) continue;
      if (msg.method === 'initialize') {
        agentOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
      } else if (msg.method === 'session/new') {
        agentOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'prefix-sess' } }) + '\n');
      } else if (msg.method === 'session/prompt') {
        promptCount += 1;
        prompts.push(msg.params);
        if (promptCount === 1) {
          // 首发：引擎拒绝（如 30s 超时/权限不足/引擎错误）
          agentOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'engine rejected' } }) + '\n');
        } else if (promptCount === 2) {
          agentOut.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'prefix-sess', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'accepted' } }
          } }) + '\n');
          agentOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'engine failed after starting' } }) + '\n');
        } else {
          agentOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        }
      }
    }
  });
  const { conn, events } = await connectCollect(driver, makeInput({ firstPromptPrefix: '【政策层】前缀必达', systemPromptAppend: 'Mode persona fixture' }));
  await waitFor(() => events.some((e) => e.type === 'resume-token'), '会话建立');
  const authority = { forkIdentity: { userMessageId: 'first-user', assistantMessageId: 'first-assistant' } };
  await conn.send('first', undefined, undefined, authority);
  await waitFor(() => events.some((e) => e.type === 'error'), '首发失败收口');
  // 网络续作 resend：Host 用 lastSentPayload 重发——此时前缀必须仍随回合注入
  await conn.send('first', undefined, undefined, authority);
  await waitFor(() => prompts.length >= 2, '重发到达 agent');
  assert.equal(promptCount, 2);
  const firstInput = 'first\n\n<muster_host_context source="automatic">\n【政策层】前缀必达\n\nMode persona fixture\n</muster_host_context>';
  assert.equal(prompts[0].prompt[0].text, firstInput);
  assert.equal(prompts[1].prompt[0].text, firstInput, '重发时恢复同一份带边界的宿主说明');
  await waitFor(() => events.some((e) => e.type === 'turn-started' && e.userMessageId === 'first-user'), '重发已被引擎接收');
  await waitFor(() => events.filter((e) => e.type === 'error').length === 2, '接收后失败的回合收口');
  await conn.send('second');
  await waitFor(() => prompts.length === 3, '下一条消息到达 agent');
  assert.equal(prompts[2].prompt[0].text, 'second', '引擎接收后即使回合失败也不重复前缀');
  await conn.close();
});

await check('F-02：入站行长超限 failAll + 无换行残缓冲超限 failAll', async () => {
  const { PassThrough } = await import('node:stream');
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const rpc = new NdjsonRpc(agentIn, agentOut);
  const closed = [];
  rpc.on('close', (err) => closed.push(err));
  // 分块输入恰好达到 8 MiB 时仍可等待换行，再多一个字节则拒绝。
  const half = 'x'.repeat(4 * 1024 * 1024);
  agentOut.write(half);
  agentOut.write(half);
  assert.equal(closed.length, 0);
  agentOut.write('x');
  await waitFor(() => closed.length === 1, '残缓冲超限触发 close');
  assert.match(closed[0].message, /入站缓冲超过 8388608B/, '错误信息指向入站缓冲超限');
  agentOut.write('\n');
  assert.equal(closed.length, 1);
  // pending 全部拒绝（failAll 语义）
  await assert.rejects(() => rpc.request('x'), /已关闭/);
});

await check('A second ACP engine receives a fragmented notification above 1 MiB and still delivers the reply', async () => {
  const { PassThrough } = await import('node:stream');
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const sessionId = 'gemini-fixture';
  const write = message => agentOut.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const update = update => ({ method: 'session/update', params: { sessionId, update } });
  const catalog = JSON.stringify({ jsonrpc: '2.0', ...update({ sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'help', description: 'Help' }], _meta: { availableSkillDetails: [{ name: 'fixture', body: '技'.repeat(400_000) }] } }) });
  assert.ok(Buffer.byteLength(catalog) > 1024 * 1024);
  const driver = new AcpRuntimeDriver(makeCtx(), { userDataDir: tmp }, {
    resolveLaunch: () => ({ command: 'fake', args: ['--acp'] }),
    spawnAgent: () => ({ rpc: new NdjsonRpc(agentIn, agentOut), kill: () => {} }),
  });
  agentIn.on('data', data => {
    const message = JSON.parse(String(data));
    if (message.method === 'initialize') write({ id: message.id, result: { protocolVersion: 1 } });
    if (message.method === 'session/new') write({ id: message.id, result: { sessionId } });
    if (message.method === 'session/prompt') {
      agentOut.write(catalog.slice(0, -20));
      agentOut.write(catalog.slice(-20) + '\n');
      write(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture reply' } }));
      write({ id: message.id, result: { stopReason: 'end_turn' } });
    }
  });
  const { conn, events } = await connectCollect(driver, makeInput({ acpAgent: 'gemini' }));
  try {
    await conn.send('hello');
    await waitFor(() => events.some(event => ['error', 'turn-complete'].includes(event.type)), 'ACP turn terminal event');
    assert.ok(events.some(event => event.type === 'text-delta' && event.delta === 'Fixture reply'));
    assert.equal(events.some(event => event.type === 'error'), false);
    assert.ok(events.some(event => event.type === 'available-commands' && event.commands[0]?.name === 'help'));
  } finally { await conn.close(); }
});

await check('F-02：入站单行超限（带换行）failAll；出站背压有界', async () => {
  const { PassThrough } = await import('node:stream');
  // 入站：完整一行（带 \n）超过 8 MiB → 协议错终止
  {
    const agentIn = new PassThrough();
    const agentOut = new PassThrough();
    const rpc = new NdjsonRpc(agentIn, agentOut);
    const closed = [];
    rpc.on('close', (err) => closed.push(err));
    agentOut.write('x'.repeat(8 * 1024 * 1024 + 1) + '\n');
    await waitFor(() => closed.length === 1, '单行超限触发 close');
    assert.match(closed[0].message, /单行超过 8388608B/, '错误信息指向单行超限');
  }
  {
    const agentIn = new PassThrough();
    const rpc = new NdjsonRpc(agentIn, new PassThrough());
    const closed = [];
    let bytesWritten = 0;
    agentIn.on('data', chunk => { bytesWritten += chunk.length; });
    rpc.on('close', error => closed.push(error));
    rpc.notify('fixture', { text: 'x'.repeat(8 * 1024 * 1024) });
    assert.equal(closed.length, 1);
    assert.match(closed[0].message, /出站背压超限/);
    assert.equal(bytesWritten, 0);
  }
  // 出站：写入端持续返回 false（never-drain 假管道）时，缓冲超过 128 帧即 failAll
  // 而不是无界堆积
  {
    const neverDrain = new PassThrough();
    neverDrain.write = () => false; // 恒背压
    const agentOut2 = new PassThrough();
    const rpc2 = new NdjsonRpc(neverDrain, agentOut2);
    const closed2 = [];
    rpc2.on('close', (err) => closed2.push(err));
    let rejected = false;
    for (let i = 0; i < 200 && !rejected; i++) {
      try {
        rpc2.notify('n', { i });
      } catch {
        rejected = true;
      }
    }
    // notify 内部 write 抛错已收口为 close；请求侧 promise 也应拒绝
    await waitFor(() => closed2.length === 1, '出站背压超限触发 close');
    assert.match(closed2[0].message, /背压超限/, '错误信息指出站背压超限');
    assert.equal(rejected, false, 'write 抛错被内部收口（不向调用方同步 throw）');
  }
});

await check('F-02：出站有界缓冲经 drain 回放，帧不丢', async () => {
  const { PassThrough } = await import('node:stream');
  const fakeStdin = new PassThrough();
  let blockedNow = true;
  const landed = [];
  // 语义对齐真 Writable：write 恒接收进流缓冲（帧已落管），返回 false 表示背压
  fakeStdin.write = (chunk) => {
    landed.push(String(chunk));
    return !blockedNow;
  };
  const agentOut = new PassThrough();
  const rpc = new NdjsonRpc(fakeStdin, agentOut);
  // 恒背压阶段写 3 帧：首帧直写落管，其余进 pending 缓冲，不丢不炸
  for (let i = 0; i < 3; i++) rpc.notify('frame', { i });
  assert.equal(landed.length, 1, '背压阶段只有首帧直写');
  // 解除背压 + drain → pending 按序回放
  blockedNow = false;
  fakeStdin.emit('drain');
  assert.equal(landed.length, 3, 'drain 后回放全部待写帧');
  assert.ok(landed[0].includes('"frame"'), '首帧内容保序');
  assert.ok(landed[2].includes('"i":2'), '末帧内容保序');
  // 解除背压后直写不积压
  rpc.notify('direct', {});
  assert.equal(landed.length, 4, '非背压直写');
  assert.ok(landed[3].includes('"direct"'));
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n[fail] acp-driver-replay ${failed} 项`);
  process.exit(1);
}
console.log('[ok] acp-driver-replay');
