/**
 * 2026-09-28 MCP 接入审查修复的回归用例：
 * 1) Windows 下 .cmd 包装命令解析（原先只特判 npx，pnpm/yarn/bunx 全启动失败）；
 * 2) 结果格式化：取 content 文本块而非整包 JSON.stringify、isError 透传、超长截断；
 * 3) 代理层：调度与 GUI 同源执行体、arguments 对象/双重转义兼容、连接失败不静默、
 *    长结果按 executor 12k 序列化信封预截（保住 ok:true + 截断标注，不改写成失败）；
 * 4) stderr 有人消费（SDK 把 stderr:'pipe' 接到 PassThrough，无人读会写满管道卡死子进程）；
 * 5) syncPiMcpFromApp：保留用户手写 server、删掉自己上次写的、调用点必须传隔离目录。
 * 运行: node test/mcp-hub.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-'));
const compile = createSharedCompiler(root, tmp);

const hubSrc = fs.readFileSync(path.join(root, 'src/main/agent/mcpHub.ts'), 'utf8');

// mcpHub 用 @modelcontextprotocol/sdk 的深层子路径导入；转译产物在临时目录里解析
// 不到真包，种一棵最小桩包（本用例只测纯函数与装配约束，不起真连接）
{
  const pkgDir = path.join(tmp, 'node_modules', '@modelcontextprotocol', 'sdk');
  fs.mkdirSync(path.join(pkgDir, 'client'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@modelcontextprotocol/sdk', type: 'module', exports: { './*': './*' } })
  );
  const stub = (names) =>
    names.map((n) => `export class ${n} { constructor(...a){ this.args = a; } }`).join('\n');
  fs.writeFileSync(
    path.join(pkgDir, 'client', 'index.js'),
    `${stub(['Client'])}\n`
  );
  fs.writeFileSync(
    path.join(pkgDir, 'client', 'stdio.js'),
    `${stub(['StdioClientTransport'])}\nexport function getDefaultEnvironment(){ return {}; }\n`
  );
  fs.writeFileSync(
    path.join(pkgDir, 'client', 'streamableHttp.js'),
    `${stub(['StreamableHTTPClientTransport'])}\n`
  );
  fs.writeFileSync(path.join(pkgDir, 'client', 'sse.js'), `${stub(['SSEClientTransport'])}\n`);
}

const hub = await import(pathToFileURL(compile('main/agent/mcpHub.ts')).href);
const {
  resolveStdioCommand,
  formatMcpToolResult,
  MCP_CONNECT_ERROR,
  MCP_CONNECT_TIMEOUT_MS,
  McpHub
} = hub;


// ── 1) Windows .cmd 包装命令 ──
{
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    for (const cmd of ['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'deno']) {
      assert.equal(resolveStdioCommand(cmd), `${cmd}.cmd`, `${cmd} 在 win32 需补 .cmd`);
    }
    assert.equal(resolveStdioCommand('node'), 'node', 'node 是真 exe，不补 .cmd');
    assert.equal(resolveStdioCommand('npx.cmd'), 'npx.cmd', '已带后缀不重复补');
    assert.equal(
      resolveStdioCommand('C:/tools/npx'),
      'C:/tools/npx',
      '带路径分隔符的当显式路径，不猜后缀'
    );
    assert.equal(resolveStdioCommand('  npx  '), 'npx.cmd', '首尾空白裁掉');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
  const originalPlatform2 = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    assert.equal(resolveStdioCommand('npx'), 'npx', '非 win32 不动命令名');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform2, configurable: true });
  }
  console.log('ok   stdio 命令解析（win32 .cmd 包装 / 显式路径 / 非 win32）');
}

// ── 2) 结果格式化：文本块、isError、截断 ──
{
  const textOnly = formatMcpToolResult({
    content: [
      { type: 'text', text: '第一段\n带换行' },
      { type: 'text', text: '第二段' }
    ]
  });
  assert.equal(textOnly.isError, false);
  assert.equal(textOnly.text, '第一段\n带换行\n第二段', '取文本块原文，不做 JSON 转义');
  assert.equal(textOnly.text.includes('\\n'), false, '换行不得被转义成字面 \\n');

  const err = formatMcpToolResult({ isError: true, content: [{ type: 'text', text: '炸了' }] });
  assert.equal(err.isError, true, 'isError 透传');
  assert.ok(err.text.includes('MCP 工具报错'), '错误结果显式标注（模型要能分辨调用失败）');
  assert.ok(err.text.includes('炸了'));

  const image = formatMcpToolResult({
    content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]
  });
  assert.ok(image.text.includes('[image image/png]'), '非文本块给占位，不灌 base64');

  const structuredValue = { a: 1, nested: { zero: 0, disabled: false, empty: null, text: '中文\n"quoted"' } };
  const structured = formatMcpToolResult({ structuredContent: structuredValue });
  assert.equal(structured.text, JSON.stringify(structuredValue), '仅 structuredContent 时由宿主生成紧凑 JSON');
  assert.deepEqual(JSON.parse(structured.text), structuredValue, '紧凑化不改变结构或字符串中的空白');
  const serverText = '{\n  "server": "keeps its formatting"\n}';
  assert.equal(formatMcpToolResult({ content: [{ type: 'text', text: serverText }], structuredContent: structuredValue }).text,
    serverText, '服务端文本优先且不重排');
  const resource = { type: 'resource', resource: { uri: 'file:///x', text: '  content  ' } };
  assert.equal(formatMcpToolResult({ content: [resource] }).text, `[resource] ${JSON.stringify(resource, null, 2)}`,
    '资源块仍采用现有格式');
  const structuredError = formatMcpToolResult({ isError: true, structuredContent: structuredValue });
  assert.equal(structuredError.isError, true);
  assert.ok(structuredError.text.endsWith(JSON.stringify(structuredValue)), '结构化错误保留标志和全部内容');

  const select = (result, resultPaths) => formatMcpToolResult(result, { resultPaths });
  const legacy = select({ content: [{ type: 'text', text: JSON.stringify([{ title: 'one', other: 'x'.repeat(30_000) }]) }] }, ['/0/title', '/01', '/length']);
  assert.deepEqual(JSON.parse(legacy.text), { values: { '/0/title': 'one' }, missing: ['/01', '/length'] });
  const oversized = select({ structuredContent: { huge: '"'.repeat(12_000), name: null, 'a/b~c': false } }, ['/huge', '/name', '/a~1b~0c', '/constructor']);
  assert.deepEqual(JSON.parse(oversized.text), {
    values: { '/name': null, '/a~1b~0c': false }, missing: ['/constructor'], omitted: ['/huge']
  });
  const escapedPaths = Array.from({ length: 12 }, (_, index) => `/${'\u0000'.repeat(125)}${index}`);
  const escaped = select({ structuredContent: {} }, escapedPaths);
  assert.deepEqual(JSON.parse(escaped.text).missing, escapedPaths);
  assert.ok(JSON.stringify({ ok: true, result: escaped.text }).length <= 11_500);
  const textFallback = select({ content: [{ type: 'text', text: 'plain response' }] }, ['/title']);
  assert.match(textFallback.text, /showing the original result\]\nplain response$/);
  assert.equal(textFallback.isError, false);
  assert.deepEqual(select({ isError: true, content: [{ type: 'text', text: '炸了' }] }, ['/title']), err);

  const big = formatMcpToolResult(
    { content: [{ type: 'text', text: 'x'.repeat(500) }] },
    { maxChars: 100 }
  );
  assert.ok(big.text.length < 300, '超长结果截断');
  assert.ok(big.text.includes('截断'), '截断要告知模型');

  const empty = formatMcpToolResult({ content: [] });
  assert.equal(typeof empty.text, 'string');
  console.log('ok   结果格式化（文本块/isError/占位/截断）');
}

// The real hub must check usage again after an asynchronous connection is ready.
{
  const guarded = new McpHub({ enabled: true, servers: [{ name: 'guarded', enabled: true, transport: 'stdio', command: 'node' }] });
  let sent = 0;
  guarded.ensure = async () => ({ client: { callTool: async () => { sent++; return { content: [] }; } } });
  await assert.rejects(guarded.callTool('guarded', 'run', {}, () => { throw new Error('disabled during connect'); }), /disabled during connect/);
  assert.equal(sent, 0);
}

// ── 3) 超时与常量口径 ──
{
  assert.ok(
    MCP_CONNECT_TIMEOUT_MS < 60_000,
    '连接超时必须短于 SDK 默认 60s，否则一台挂住的 server 能把建连拖一分钟'
  );
  assert.equal(MCP_CONNECT_ERROR, '(connect-error)');
  console.log('ok   连接超时短于 SDK 默认 / 占位常量');
}

// ── 4) enabledServers：总开关与逐台开关 ──
{
  const cfg = {
    enabled: true,
    servers: [
      { name: 'a', enabled: true, transport: 'stdio', command: 'node' },
      { name: 'b', enabled: false, transport: 'stdio', command: 'node' },
      { name: '  ', enabled: true, transport: 'stdio', command: 'node' }
    ]
  };
  assert.deepEqual(
    new McpHub(cfg).enabledServers().map((s) => s.name),
    ['a']
  );
  assert.deepEqual(new McpHub({ ...cfg, enabled: false }).enabledServers(), [], '总开关关=空');
  console.log('ok   enabledServers 过滤');
}

// ── 5) 源码约束：stderr 必须有人消费 / 断线摘除 / 失败冷却 ──
{
  assert.ok(
    /transport\.stderr\?\.on\('data'/.test(hubSrc),
    "stderr:'pipe' 必须有人读：SDK 接的是 PassThrough，无人消费时管道写满会卡死子进程"
  );
  assert.ok(/client\.onclose\s*=/.test(hubSrc), '断线要摘除失效连接，否则整会话 MCP 调用全失败');
  assert.ok(/failures\.set/.test(hubSrc), '连接失败要记冷却，避免每次 list 都重拉坏 server');
  assert.ok(
    /Promise\.all\(\s*servers\.map/.test(hubSrc),
    'listAllTools 必须并行连接（串行=多台 server 逐个等超时）'
  );
  assert.ok(/SSEClientTransport/.test(hubSrc), '老式 SSE server 需要回落');
  console.log('ok   源码约束（stderr 消费 / onclose 摘除 / 失败冷却 / 并行 / SSE 回落）');
}

// Runtime failure paths (also consumed by GUI warning logs) never expose secrets.
{
  const server = { name: 'secret-test', enabled: true, transport: 'http', url: 'https://example.invalid/mcp', env: { TOKEN: 'env-sensitive-value' }, headers: { Authorization: 'Bearer header-sensitive-value' } };
  const instance = new McpHub({ enabled: true, servers: [server] });
  instance.connect = async () => { throw new Error('env-sensitive-value Bearer header-sensitive-value https://example.invalid/mcp?token=url-secret'); };
  instance.noteStderr(server.name, 'env-sensitive-value Bearer header-sensitive-value');
  const listed = await instance.listAllTools();
  assert.equal(listed[0].name, MCP_CONNECT_ERROR);
  for (const secret of ['env-sensitive-value', 'header-sensitive-value', 'url-secret']) assert.equal(listed[0].description.includes(secret), false);
  assert.equal(instance.stderrTail(server.name).includes('header-sensitive-value'), false);
  const repeated = await instance.listAllTools();
  assert.equal(repeated[0].description.includes('env-sensitive-value'), false, '失败缓存也保存脱敏信息');
  instance.lives.set(server.name, { config: server, tools: [], client: { callTool: async () => { throw new Error('env-sensitive-value'); }, close: async () => {} } });
  await assert.rejects(() => instance.callTool(server.name, 'fixture', {}), error => !error.message.includes('env-sensitive-value'));
  instance.lives.set(server.name, { config: server, tools: [], client: { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'Bearer header-sensitive-value rejected' }] }), close: async () => {} } });
  assert.equal((await instance.callTool(server.name, 'fixture', {})).includes('header-sensitive-value'), false, '工具isError内容也要脱敏');
  await instance.close();
  console.log('ok   runtime MCP connect/call/stderr/cooldown 脱敏');
}

// ── 6) B1 中转执行体（runMcpSearch / runMcpCall）：替身 hub，不起真连接 ──
{
  const proxy = await import(pathToFileURL(compile('main/agent/mcpProxy.ts')).href);
  const { runMcpSearch, runMcpCall, parseMcpRelayCallArgs } = proxy;

  /** 结构同构替身（McpRelayHub 契约）；opts 控制各方法行为 */
  function fakeRelayHub(opts = {}) {
    const calls = [];
    return {
      calls,
      enabledServers: () => (opts.servers ?? [{ name: 'Feishu' }, { name: 'Play' }]),
      listAllTools: async () =>
        opts.tools ?? [
          { server: 'Feishu', name: 'get_story', description: 'query story', inputSchema: { type: 'object' } },
          { server: 'Play', name: MCP_CONNECT_ERROR, description: 'spawn ENOENT' }
        ],
      describeTool: async (server, tool) => {
        calls.push(['describe', server, tool]);
        if (opts.describeThrows) throw new Error(opts.describeThrows);
        if (opts.describeMiss) return null;
        return { server, name: tool, description: 'd', inputSchema: { type: 'object' } };
      },
      callTool: async (server, tool, args) => {
        calls.push(['call', server, tool, args]);
        if (opts.callThrows) throw new Error(opts.callThrows);
        return opts.callReturns ?? 'CALL_OK';
      }
    };
  }

  // search：空配置返回空清单不报错
  const empty = await runMcpSearch(fakeRelayHub({ servers: [] }), {});
  assert.deepEqual(empty.tools, []);
  assert.match(empty.hint, /No MCP servers are configured/);
  assert.equal(empty.connectErrors, undefined, '无 server 时不误报连接错误');

  // search：连接失败旁路呈现（不静默也不当工具列）
  const searched = await runMcpSearch(fakeRelayHub(), {});
  assert.deepEqual(searched.connectErrors, [{ server: 'Play', error: 'spawn ENOENT' }]);
  assert.equal(searched.tools.every(t => t.name !== MCP_CONNECT_ERROR), true);
  assert.ok(searched.servers.includes('Feishu'));

  // search：schema 续页沿 tools.search 约定（纯层已细测，这里锁执行体透传）
  const paged = await runMcpSearch(fakeRelayHub(), { query: 'story', includeSchema: true });
  assert.deepEqual(paged.tools[0].inputSchema, { type: 'object' });

  // call：正常链路 describe 校验后 call，参数对象直传
  const h = fakeRelayHub();
  assert.equal(await runMcpCall(h, { server: 'Feishu', tool: 'get_story', args: { id: 7 } }), 'CALL_OK');
  assert.deepEqual(h.calls, [['describe', 'Feishu', 'get_story'], ['call', 'Feishu', 'get_story', { id: 7 }]]);

  // call：host 侧错误全为可纠正英文
  const cases = [
    [{ tool: 'get_story' }, /requires both "server" and "tool"/, {}],
    [{ server: 'Nope', tool: 'x' }, /Unknown MCP server "Nope"\. Configured servers: Feishu, Play/, {}],
    [{ server: 'Feishu', tool: 'missing' }, /has no tool "missing".*mcp\.search/, { describeMiss: true }],
    [{ server: 'Feishu', tool: 'get_story', args: '[1,2]' }, /must be a JSON object/, {}],
    [{ server: 'Feishu', tool: 'get_story', args: '{bad' }, /not valid JSON/, {}]
  ];
  for (const [params, re, hubOpts] of cases) {
    await assert.rejects(() => runMcpCall(fakeRelayHub(hubOpts), params), re, JSON.stringify(params));
  }
  // 未配置 server 时 call 报配置指引（不是裸异常）
  await assert.rejects(
    () => runMcpCall(fakeRelayHub({ servers: [] }), { server: 'Feishu', tool: 'x' }),
    /No MCP servers are configured/
  );
  // 连接失败：describe 抛错转成可读英文（含 server 名与设置指引）
  await assert.rejects(
    () => runMcpCall(fakeRelayHub({ describeThrows: 'connect ECONNREFUSED' }), { server: 'Feishu', tool: 'get_story' }),
    /connection failed: connect ECONNREFUSED/
  );
  // 工具侧执行异常原样上抛（executor 转 ok:false 文本）
  await assert.rejects(
    () => runMcpCall(fakeRelayHub({ callThrows: 'boom' }), { server: 'Feishu', tool: 'get_story' }),
    /boom/
  );

  // args 容错：对象 / JSON 字符串 / 双重转义 / legacy arguments_json / 缺省空对象
  assert.deepEqual(parseMcpRelayCallArgs({ args: { a: 1 } }), { a: 1 });
  assert.deepEqual(parseMcpRelayCallArgs({ args: '{"a":1}' }), { a: 1 });
  assert.deepEqual(parseMcpRelayCallArgs({ args: JSON.stringify(JSON.stringify({ a: 1 })) }), { a: 1 });
  assert.deepEqual(parseMcpRelayCallArgs({ arguments_json: '{"a":1}' }), { a: 1 });
  assert.deepEqual(parseMcpRelayCallArgs({}), {});
  assert.deepEqual(parseMcpRelayCallArgs({ arguments: { a: 1 } }), { a: 1 });
  assert.throws(() => parseMcpRelayCallArgs({ args: '[1]' }), /JSON object/);

  // 长结果回归（P2 Bug A）：mcpHub 的 20k 截断大于 executor serializeResult 的 12k
  // 序列化上限（capabilities/executor.ts RESULT_MAX_CHARS=12_000，超限把成功改写成
  // ok:false 并丢正文）。runMcpCall 必须按最终信封预截。executor 的口径是
  // JSON.stringify({ok:true,result}) ≤ 12000，此处按同构口径断言最终信封仍成功。
  for (const [label, size] of [['超 12k 未到 hub 上限（12000<结果<20000）', 15_000], ['超 hub 20k 上限（结果>20000）', 25_000]]) {
    const hubText = formatMcpToolResult({ content: [{ type: 'text', text: 'x'.repeat(size) }] }).text;
    const relayed = await runMcpCall(fakeRelayHub({ callReturns: hubText }), { server: 'Feishu', tool: 'get_story' });
    const envelope = JSON.stringify({ ok: true, result: relayed });
    assert.ok(envelope.length <= 12_000, `${label}: 序列化信封 ${envelope.length} 字符超过 executor 12k 上限，成功结果会被改写为失败`);
    assert.equal(JSON.parse(envelope).ok, true, `${label}: 必须保住 ok:true 成功语义`);
    assert.match(relayed, /\[mcp\.call: result truncated to \d+ of \d+ chars/, `${label}: 截断必须带标注`);
    assert.ok(relayed.length < hubText.length, `${label}: 结果确实被收缩`);
  }
  // JSON 转义膨胀：8000 个引号裸长 8k（低于预算），转义后翻倍超信封——必须按最终长度收缩
  {
    const quoted = formatMcpToolResult({ content: [{ type: 'text', text: '"'.repeat(8_000) }] }).text;
    const relayed = await runMcpCall(fakeRelayHub({ callReturns: quoted }), { server: 'Feishu', tool: 'get_story' });
    const envelope = JSON.stringify({ ok: true, result: relayed });
    assert.ok(envelope.length <= 12_000, '引号转义膨胀也要装进信封');
    assert.equal(JSON.parse(envelope).ok, true);
    assert.match(relayed, /\[mcp\.call: result truncated to \d+ of \d+ chars/);
  }
  // 预算内结果原样透传（不添标注、不动正文）
  assert.equal(await runMcpCall(fakeRelayHub({ callReturns: 'short body' }), { server: 'Feishu', tool: 'get_story' }), 'short body');
  // 真实中转两层预算：仅宿主缩进会导致截断时，紧凑 JSON 的全部数据应可达模型。
  {
    const envelopeSize = value => JSON.stringify({ ok: true, result: value }).length;
    let value, compact, pretty;
    for (let count = 1; count <= 400; count++) {
      value = { items: Array.from({ length: count }, (_, id) => ({ id, label: 'value', details: { enabled: true, index: id } })) };
      compact = JSON.stringify(value); pretty = JSON.stringify(value, null, 2);
      if (envelopeSize(compact) <= 11_500 && envelopeSize(pretty) > 11_500 && pretty.length < 20_000) break;
    }
    assert.ok(envelopeSize(compact) <= 11_500 && envelopeSize(pretty) > 11_500, 'fixture 必须跨越信封预算');
    const hubText = formatMcpToolResult({ structuredContent: value }).text;
    const relayed = await runMcpCall(fakeRelayHub({ callReturns: hubText }), { server: 'Feishu', tool: 'get_story' });
    assert.equal(relayed, compact, '结构化结果不再因缩进而截断');
    assert.deepEqual(JSON.parse(relayed), value);
  }
  console.log('ok   中转执行体（search 空配置/旁路/透传；call 英文错误路径/args 容错/长结果预算预截）');
}

// ── 7) catalog handler（capabilities/hosts/mcp.ts）：共享 hub 缓存 + 配置热更 + 工作区解析 ──
{
  const { mcpHost, resolveMcpRelayWorkspaceId } = await import(
    pathToFileURL(compile('main/capabilities/hosts/mcp.ts')).href
  );
  // 同一编译产物 URL：hosts/mcp.ts 内部 new 的 McpHub 与此处直接导入是同一模块实例，patch 生效
  const hubProto = McpHub.prototype;
  const closed = [];
  const originalClose = hubProto.close;
  const received = [];
  hubProto.close = async function () { closed.push(this); };
  hubProto.listAllTools = async function () {
    return this.enabledServers().flatMap((s) => [
      { server: s.name, name: 'get_story', description: 'query story', inputSchema: { type: 'object' } }
    ]);
  };
  hubProto.describeTool = async function (server, tool) {
    const config = this.enabledServers().find(s => s.name === server);
    if (!config) return null;
    this.lives.set(server, { config, tools: [], client: {
      callTool: async request => {
        received.push(request);
        const structuredContent = { assets: 'x'.repeat(42_000), tag_name: 'v2.102.0', items: [{ title: 'bug' }] };
        return {
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent
        };
      }
    } });
    return { server, name: tool, description: 'd', inputSchema: { type: 'object' } };
  };
  try {
    const cfg = (names) => ({
      enabled: true,
      servers: names.map((n) => ({ name: n, enabled: true, transport: 'stdio', command: 'node' }))
    });
    // 显式 bump() 切换配置（effectiveMcp 每次工具调用都会被读，不能按调用次数自动推进）
    let current = cfg(['Alpha']);
    const ctx = {
      config: { effectiveMcp: () => current, get: () => ({ mcp: current }) },
      sessions: { get: () => ({ workspaceId: 'ws1', name: 's' }) },
      resolveBubbleWorkspaceId: () => 'ws-bubble'
    };

    // 工作区解析：优先令牌会话所属工作区（此处模拟 currentAgentSessionId 未设置 → 气泡面）
    assert.equal(resolveMcpRelayWorkspaceId(ctx), 'ws-bubble');
    const ctxNoWs = { ...ctx, resolveBubbleWorkspaceId: () => { throw new Error('no bubble'); } };
    assert.equal(resolveMcpRelayWorkspaceId(ctxNoWs), undefined, '无会话无气泡也不抛');
    assert.equal(resolveMcpRelayWorkspaceId({ ...ctxNoWs, config: { ...ctx.config, get: () => ({ mcp: current, activeWorkspaceId: 'active' }) } }), 'active', 'same active workspace fallback as effectiveMcp, so workspace policy cannot be bypassed');

    // 空配置：search 空清单不报错（handler 兜底空 hub，不建连接）
    const emptyCtx = { ...ctx, config: { effectiveMcp: () => ({ enabled: false, servers: [] }) } };
    const emptyPage = await mcpHost['mcp.search'](emptyCtx, {});
    assert.deepEqual(emptyPage.tools, []);
    assert.match(emptyPage.hint, /No MCP servers are configured/);
    await assert.rejects(() => mcpHost['mcp.call'](emptyCtx, { server: 'x', tool: 'y' }), /No MCP servers are configured/);

    // 正常 search → call；配置热更：server 名单变化即关旧 hub 建新 hub
    const page1 = await mcpHost['mcp.search'](ctx, {});
    assert.deepEqual(page1.servers, ['Alpha']);
    assert.equal(page1.total, 1);
    const unfiltered = await mcpHost['mcp.call'](ctx, { server: 'Alpha', tool: 'get_story', args: { id: 1 } });
    assert.match(unfiltered, /\[mcp\.call: result truncated/);
    assert.ok(unfiltered.length > 10_000);
    const selected = await mcpHost['mcp.call'](ctx, {
      server: 'Alpha', tool: 'get_story', args: { id: 1 }, resultPaths: ['/tag_name', '/items/0/title', '/tag_name']
    });
    assert.ok(selected.length < 100, 'only requested values reach the model, including fields beyond the old cap');
    assert.deepEqual(JSON.parse(selected), { values: { '/tag_name': 'v2.102.0', '/items/0/title': 'bug' } });
    assert.deepEqual(received, Array.from({ length: 2 }, () => ({ name: 'get_story', arguments: { id: 1 } })));
    for (const resultPaths of [[], ['/invalid~2'], ['title'], ['/valid', 42], Array(13).fill('/title'), [`/${'x'.repeat(128)}`]]) {
      await assert.rejects(() => mcpHost['mcp.call'](ctx, { server: 'Alpha', tool: 'get_story', resultPaths }), /resultPaths/);
    }
    assert.equal(received.length, 2, 'invalid selectors must not execute the remote tool');
    assert.equal(closed.length, 0, '同配置复用共享 hub，不重建');

    current = cfg(['Alpha', 'Beta']);
    const page2 = await mcpHost['mcp.search'](ctx, {});
    assert.deepEqual(page2.servers, ['Alpha', 'Beta'], '配置热更后按新名单');
    assert.equal(closed.length, 1, '配置指纹变化关闭旧 hub');

    // 未知 server：handler 抛可纠正英文（executor 转 ok:false 文本）
    await assert.rejects(
      () => mcpHost['mcp.call'](ctx, { server: 'Nope', tool: 'x' }),
      /Unknown MCP server "Nope"\. Configured servers: Alpha, Beta/
    );
  } finally {
    hubProto.close = originalClose;
    delete hubProto.listAllTools;
    delete hubProto.describeTool;
  }
  console.log('ok   catalog handler（共享 hub 复用/配置热更关旧/空配置兜底/工作区解析）');
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('mcp-hub: ok');
