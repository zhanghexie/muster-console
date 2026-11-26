/**
 * 2026-09-28 MCP 接入审查修复的回归用例（代理层 / 各引擎映射）：
 * 1) parseMcpRelayCallArgs：JSON 字符串 / 直接对象 / 双重转义 / legacy 键都收，非对象拒绝；
 * 2) 执行体唯一 + 四面接线（meta/resident/pty 投影/GUI/A3 登记；旧 mcpExtension 退役；
 *    legacy 单工具 runMcpProxy 随 B2 停用直注、B4 删除，本文件不再覆盖四 action 形态）。
 * （原 syncPiMcpFromApp 节随 B4「第三方 MCP 逐引擎部署退役」删除：第三方 MCP 只经宿主
 *  中转投递，宿主不再写 ~/.pi/agent/mcp.json。）
 * 运行: node test/mcp-integration.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-integration-'));
const compile = createSharedCompiler(root, tmp);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// mcpProxy 只经相对路径引 mcpHub（类型）与 shared/i18n，但 mcpHub 会拉 SDK：种桩包
{
  const pkgDir = path.join(tmp, 'node_modules', '@modelcontextprotocol', 'sdk');
  fs.mkdirSync(path.join(pkgDir, 'client'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@modelcontextprotocol/sdk', type: 'module', exports: { './*': './*' } })
  );
  const stub = (names) => names.map((n) => `export class ${n} {}`).join('\n');
  fs.writeFileSync(path.join(pkgDir, 'client', 'index.js'), `${stub(['Client'])}\n`);
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

const proxy = await import(pathToFileURL(compile('main/agent/mcpProxy.ts')).href);
const { parseMcpRelayCallArgs } = proxy;
assert.equal('runMcpProxy' in proxy, false, 'B4: legacy runMcpProxy 已删除，只剩中转两工具执行体');
assert.equal('MCP_PROXY_ACTIONS' in proxy, false, 'B4: 四 action 词表随 legacy 代理删除');

// ── 1) call 参数解析：三种形态都收（行为用例主体在 mcp-hub.mjs §6，这里保边缘容错） ──
{
  assert.deepEqual(parseMcpRelayCallArgs({ arguments_json: '{"a":1}' }), { a: 1 }, 'JSON 字符串');
  assert.deepEqual(parseMcpRelayCallArgs({ arguments: { a: 1 } }), { a: 1 }, '模型直接给对象');
  assert.deepEqual(
    parseMcpRelayCallArgs({ arguments_json: JSON.stringify(JSON.stringify({ a: 1 })) }),
    { a: 1 },
    '双重转义也解开（常见的模型格式错误，不该整次调用失败）'
  );
  assert.deepEqual(parseMcpRelayCallArgs({}), {}, '无参=空对象');
  assert.deepEqual(parseMcpRelayCallArgs({ arguments_json: '   ' }), {});
  assert.deepEqual(parseMcpRelayCallArgs({ arguments_json: { a: 1 } }), { a: 1 }, '字段错填对象也收');
  assert.throws(() => parseMcpRelayCallArgs({ arguments_json: '[1,2]' }), /JSON object/, '数组拒绝');
  assert.throws(() => parseMcpRelayCallArgs({ arguments_json: '{bad' }), 'JSON 语法错误要抛');
  console.log('ok   call 参数解析（字符串/对象/双重转义/非对象拒绝）');
}

// ── 2) 执行体唯一 + 四面接线：调度/GUI/PTY/ACP 同源一个形态 ──
{
  // B1：调度旧 mcp 扩展退役；GUI 旧 mcp 桥由并行 B2 退役（存在性不在此断言，属 B2 域）。
  // 两工具唯一执行体在 mcpProxy，catalog handler 只做接线。
  assert.equal(fs.existsSync(path.join(root, 'src/main/agent/mcpExtension.ts')), false, 'mcpExtension.ts 已退役');
  const piProvider = read('src/main/agent/providers/piProvider.ts');
  assert.equal(/createMcpExtensionFactory/.test(piProvider), false, 'piProvider 不再挂 mcp 单工具扩展');
  assert.equal(/'mcp'/.test(piProvider), false, 'piProvider 工具名册不再注册裸 mcp');

  const proxySrc = read('src/main/agent/mcpProxy.ts');
  const hostSrc = read('src/main/capabilities/hosts/mcp.ts');
  assert.ok(/export async function runMcpSearch/.test(proxySrc) && /export async function runMcpCall/.test(proxySrc), 'mcpProxy 提供中转两工具执行体');
  assert.ok(/runMcpSearch|runMcpCall/.test(hostSrc), 'hosts/mcp.ts 复用共享执行体');
  assert.equal((hostSrc.match(/new McpHub\(/g) ?? []).length, 1, 'hub 实例只在 relayHubFor 缓存处创建');
  assert.ok(/'mcp\.search'/.test(hostSrc) && /'mcp\.call'/.test(hostSrc), 'handler 键为两工具点名');
  const executorSrc = read('src/main/capabilities/executor.ts');
  assert.ok(/\.\.\.mcpHost/.test(executorSrc), 'executor 并入 mcpHost');

  // mcpHub 连接层约束不动（预算/冷却/摘除/SSE 回落由 mcp-hub.mjs 锁）
  const hubSrc = read('src/main/agent/mcpHub.ts');
  assert.ok(/MCP_RESULT_MAX_CHARS = 20_000/.test(hubSrc), '20k 截断约定保留在连接层');

  // 注册面四处同步
  const metaSrc = read('src/shared/hostTools/meta.ts');
  assert.ok(/def\('mcp\.search', 'mcp', 'read', ALL_PRESETS/.test(metaSrc), 'meta：mcp.search=read 全 preset');
  assert.ok(/def\('mcp\.call', 'mcp', 'dynamic', ALL_PRESETS/.test(metaSrc), 'meta：mcp.call=dynamic 档过决策表');
  const { hostToolBinding, hostToolPermissionClass, HOST_MCP_TOOL_IDS, listHostToolIds } = await import(
    pathToFileURL(compile('shared/hostTools/index.ts')).href
  );
  assert.deepEqual(HOST_MCP_TOOL_IDS, ['mcp.search', 'mcp.call']);
  assert.equal(hostToolBinding('mcp.call'), 'actor', '身份绑定 actor');
  assert.equal(hostToolBinding('mcp.search'), 'actor');
  assert.equal(hostToolPermissionClass('mcp.call'), 'dynamic');
  for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset']) {
    const ids = listHostToolIds(preset);
    assert.ok(ids.includes('mcp.search') && ids.includes('mcp.call'), `${preset} 全员投影`);
  }

  const { residentHostToolIds } = await import(pathToFileURL(compile('shared/toolDiscovery.ts')).href);
  for (const role of ['scheduler', 'worker']) {
    assert.ok(residentHostToolIds(role).includes('mcp.search'), `${role} 常驻 mcp.search`);
    assert.ok(residentHostToolIds(role).includes('mcp.call'), `${role} 常驻 mcp.call`);
  }

  // pty/ACP 投影：inboundMcpToolDefs 含两工具且 schema 来自 catalog
  const { inboundMcpToolDefs } = await import(pathToFileURL(compile('main/inboundMcp/toolList.ts')).href);
  for (const preset of ['pty-allowlist', 'acp-subset']) {
    const defs = inboundMcpToolDefs(preset);
    const search = defs.find(t => t.name === 'host_mcp_search');
    const call = defs.find(t => t.name === 'host_mcp_call');
    assert.ok(search && call, `${preset} 投影两工具`);
    assert.deepEqual(call.inputSchema.required, ['server', 'tool']);
    assert.equal(call.inputSchema.properties.resultPaths.type, 'array');
    assert.match(search.description, /nextOffset/);
  }

  // GUI：catalogHostTools 点名清单含两工具（R4 显式 ID 列表，替代原 meta 组展开）；调度：piProvider 常驻自动注册（catalog resident 投影）
  assert.ok(residentHostToolIds('worker').includes('mcp.search') && residentHostToolIds('worker').includes('mcp.call'), 'GUI source roster contains the relay pair');

  // A3 登记与调度提示行
  const registrySrc = read('src/main/agent/injection-registry.ts');
  assert.ok(/both\.tool-schema\.mcp-relay/.test(registrySrc), 'A3：中转两工具注入已登记');
  assert.match(read('src/main/agent/systemPrompt.ts'), /mcp\.search.*nextOffset.*mcp\.call/, '调度提示行指路新两工具');
  console.log('ok   中转两工具接线（调度退役旧 mcp / meta·resident·pty·GUI 四面同步 / A3 登记）');
}

// ── 3) Core 同步调用点必须从工作台存储根解析目标目录 ──
{
  const files = [
    'src/main/config.ts',
    'src/main/agent/orchestrator.ts',
    'src/main/agent/providers/piProvider.ts',
    'src/main/agentSession/drivers/pi/driver.ts'
  ];
  const callRe = /\bsync(?:PiMcp|PiConfig)FromApp\s*\(/g;
  for (const rel of files) {
    const src = read(rel);
    assert.match(src, /userDataStorage\([^\n]+\.resolve\('app', 'muster-core'\)/, `${rel} 必须解析 Core 私有目录`);
    let m;
    while ((m = callRe.exec(src))) {
      // 取该调用的实参串（到匹配的右括号）
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
      }
      const args = src.slice(m.index + m[0].length, i - 1);
      assert.ok(
        /,\s*(agentDir|userDataStorage\()/.test(args),
        `${rel} 的 ${m[0]}…) 必须显式传 Core 私有目录，实参：${args.slice(0, 120)}`
      );
    }
  }
  console.log('ok   Core 同步调用点一律使用工作台私有目录');
}


fs.rmSync(tmp, { recursive: true, force: true });
console.log('mcp-integration: ok');
