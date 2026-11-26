/**
 * MCP 配置 JSON 解析 / 作用域合并 / 保存规整。
 * 运行: node test/mcp-config.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'));
const compileEntry = createSharedCompiler(root, tmp);
const outFile = compileEntry('shared/mcpConfig.ts');

const {
  parseMcpJsonText,
  parseMcpServersObject,
  serializeMcpJson,
  mergeMcpServers,
  resolveEffectiveMcp,
  resolveEffectiveMcpFromApp,
  sanitizeMcpServers,
  emptyMcpJsonTemplate,
  redactMcpDiagnostic
} = await import(pathToFileURL(outFile).href);

/* ---------- JSON 两种外壳 ---------- */
const named = parseMcpJsonText(`{
  "my-mcp-server": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer x" } }
}`);
assert.equal(named.ok, true);
assert.equal(named.servers.length, 1);
assert.equal(named.servers[0].name, 'my-mcp-server');
assert.equal(named.servers[0].transport, 'http');
assert.equal(named.servers[0].url, 'https://example.com/mcp');
assert.equal(named.servers[0].headers.Authorization, 'Bearer x');

const wrapped = parseMcpJsonText(`{
  "mcpServers": {
    "stdio-one": { "command": "npx", "args": ["-y", "pkg"] }
  }
}`);
assert.equal(wrapped.ok, true);
assert.equal(wrapped.servers[0].transport, 'stdio');
assert.equal(wrapped.servers[0].command, 'npx');
assert.deepEqual(wrapped.servers[0].args, ['-y', 'pkg']);

const fromCursorFile = parseMcpServersObject({
  mcpServers: { a: { type: 'http', url: 'http://127.0.0.1/mcp' } },
  settings: { disableProxyTool: false }
});
assert.equal(fromCursorFile.length, 1);
assert.equal(fromCursorFile[0].name, 'a');

/* ---------- 往返 ---------- */
const round = parseMcpJsonText(serializeMcpJson(named.servers));
assert.equal(round.ok, true);
assert.deepEqual(round.servers, named.servers);

const tmpl = parseMcpJsonText(emptyMcpJsonTemplate('demo', 'http'));
assert.equal(tmpl.ok, true);
assert.equal(tmpl.servers[0].name, 'demo');
assert.equal(tmpl.servers[0].transport, 'http');

/* ---------- 工作区同名覆盖用户 ---------- */
const user = [{ name: 'shared', enabled: true, transport: 'http', url: 'http://user' }];
const workspace = [{ name: 'shared', enabled: true, transport: 'http', url: 'http://ws' }];
const merged = mergeMcpServers(user, workspace);
assert.equal(merged.length, 1);
assert.equal(merged[0].url, 'http://ws');

const extra = mergeMcpServers(user, [{ name: 'only-ws', enabled: true, transport: 'stdio', command: 'npx' }]);
assert.equal(extra.length, 2);

const effective = resolveEffectiveMcp({ enabled: true, servers: user }, workspace);
assert.equal(effective.enabled, true);
assert.equal(effective.servers[0].url, 'http://ws');

/* ---------- 具体运行入口：旧配置保持全开，[]全部关闭，项目覆盖后才过滤 ---------- */
const targeted = {
  activeWorkspaceId: 'ws', mcp: { enabled: true, servers: [
    { name: 'legacy', enabled: true, transport: 'stdio', command: 'node' },
    { name: 'closed', enabled: true, transport: 'stdio', command: 'node', targetIds: [] },
    { name: 'cli', enabled: true, transport: 'http', url: 'http://cli', targetIds: ['codex-cli'] },
    { name: 'shared', enabled: true, transport: 'http', url: 'http://global', targetIds: ['pi-dispatcher'] }
  ] }, mcpByWorkspace: { ws: [
    { name: 'shared', enabled: true, transport: 'http', url: 'http://project', targetIds: ['codex-gui'] }
  ] }
};
assert.deepEqual(resolveEffectiveMcpFromApp(targeted, 'ws', 'pi-dispatcher').servers.map(server => server.name), ['legacy'], '项目同名覆盖不因未关联调度而重新暴露全局');
assert.deepEqual(resolveEffectiveMcpFromApp(targeted, 'ws', 'codex-cli').servers.map(server => server.name), ['legacy', 'cli']);
assert.equal(resolveEffectiveMcpFromApp(targeted, 'ws', 'codex-gui').servers.find(server => server.name === 'shared').url, 'http://project');
assert.equal(resolveEffectiveMcpFromApp(targeted, 'ws').servers.length, 4, '未指定目标时保留管理清单');
assert.equal(redactMcpDiagnostic('Bearer isolated-secret failed http://example.test/mcp?token=hidden', { name: 'test', enabled: true, transport: 'http', headers: { Authorization: 'Bearer isolated-secret' } }).includes('isolated-secret'), false);
assert.equal(redactMcpDiagnostic('request http://example.test/mcp?token=hidden failed', { name: 'test', enabled: true, transport: 'http' }).includes('hidden'), false);

/* ---------- 保存时丢掉空 headers/env ---------- */
const cleaned = sanitizeMcpServers([
  { name: '  x  ', enabled: true, transport: 'http', url: 'u', headers: { Authorization: 't', '': 'no', Empty: '' } }
]);
assert.equal(cleaned[0].name, 'x');
assert.deepEqual(cleaned[0].headers, { Authorization: 't' });

const nameless = sanitizeMcpServers([{ name: '  ', enabled: true, transport: 'http', url: 'u' }]);
assert.equal(nameless.length, 0);

/* ---------- 坏 JSON ---------- */
const bad = parseMcpJsonText('{ not json');
assert.equal(bad.ok, false);
assert.match(bad.error, /JSON 无效/);

const empty = parseMcpJsonText('{ "foo": 1 }');
assert.equal(empty.ok, false);

/* ---------- B1 中转两工具：shared/mcpRelay 纯投影 ---------- */
{
  const relayFile = compileEntry('shared/mcpRelay.ts');
  const relay = await import(pathToFileURL(relayFile).href);
  const {
    buildMcpSearchPage,
    splitMcpRelayTools,
    MCP_RELAY_CONNECT_ERROR,
    MCP_SEARCH_PARAMETERS,
    MCP_CALL_PARAMETERS,
    MCP_SEARCH_DESCRIPTION,
    MCP_CALL_DESCRIPTION,
    MCP_SEARCH_PAGE_MAX_CHARS
  } = relay;

  // schema 骨架：search 全可选；call 必填 server/tool，args 对象可省
  assert.equal(MCP_SEARCH_PARAMETERS.type, 'object');
  assert.equal(MCP_SEARCH_PARAMETERS.required, undefined);
  assert.deepEqual(MCP_CALL_PARAMETERS.required, ['server', 'tool']);
  assert.equal(MCP_CALL_PARAMETERS.properties.args.type, 'object');
  assert.match(MCP_SEARCH_DESCRIPTION, /nextOffset/);
  assert.match(MCP_CALL_DESCRIPTION, /mcp\.search/);

  // 空配置：空清单不报错，带可操作 hint
  const emptyPage = buildMcpSearchPage({ servers: [], tools: [] });
  assert.deepEqual(emptyPage.tools, []);
  assert.equal(emptyPage.total, 0);
  assert.equal(emptyPage.nextOffset, undefined);
  assert.match(emptyPage.hint, /No MCP servers are configured/);

  // 常规：摘要条目 / includeSchema 全量 / query 过滤 / server 过滤
  const tools = [
    { server: 'Feishu', name: 'get_story', description: 'query story items\nsecond line', inputSchema: { type: 'object' } },
    { server: 'Play', name: 'press_key', description: 'press a key' }
  ];
  const page = buildMcpSearchPage({ servers: ['Feishu', 'Play'], tools });
  assert.equal(page.total, 2);
  assert.equal(page.tools.length, 2);
  assert.equal(page.tools[0].name, 'get_story');
  assert.equal(page.tools[0].summary, 'query story items', '默认只给一行摘要');
  assert.equal(page.tools[0].inputSchema, undefined, '默认不带 schema');
  const withSchema = buildMcpSearchPage({ servers: ['Feishu'], tools, includeSchema: true, server: 'Feishu' });
  assert.deepEqual(withSchema.tools[0].inputSchema, { type: 'object' });
  assert.equal(withSchema.tools[0].summary, undefined);
  const filtered = buildMcpSearchPage({ servers: ['Feishu', 'Play'], tools, query: 'press' });
  assert.deepEqual(filtered.tools.map(t => t.name), ['press_key']);
  assert.equal(filtered.hint, undefined, '有匹配不给 no-match hint');

  // 连接失败：不当工具列、不静默，单独 connectErrors 且不计入 total
  const broken = buildMcpSearchPage({
    servers: ['Feishu', 'Down'],
    tools: [...tools, { server: 'Down', name: MCP_RELAY_CONNECT_ERROR, description: 'spawn ENOENT' }]
  });
  assert.equal(broken.total, 2, '连接失败条目不计入工具总数');
  assert.deepEqual(broken.connectErrors, [{ server: 'Down', error: 'spawn ENOENT' }]);
  assert.deepEqual(splitMcpRelayTools([{ server: 'x', name: MCP_RELAY_CONNECT_ERROR, description: '' }, ...tools]).ok.length, 2);

  // 截断续页：超预算分页、nextOffset 接续、首页永不落空
  const many = Array.from({ length: 40 }, (_, i) => ({
    server: 'Bulk', name: `tool_${i}`, description: 'd'.repeat(600)
  }));
  const bigPage = buildMcpSearchPage({ servers: ['Bulk'], tools: many, includeSchema: true, limit: 20 });
  assert.ok(bigPage.tools.length >= 1 && bigPage.tools.length < 20, '预算内截断');
  assert.equal(typeof bigPage.nextOffset, 'number');
  assert.ok(JSON.stringify(bigPage.tools).length <= MCP_SEARCH_PAGE_MAX_CHARS + 200);
  const next = buildMcpSearchPage({ servers: ['Bulk'], tools: many, includeSchema: true, limit: 20, offset: bigPage.nextOffset });
  assert.equal(next.tools.length > 0, true, '续页非空');
  assert.equal(
    next.tools.some(t => bigPage.tools.some(p => p.name === t.name)),
    false,
    '续页与首页不重叠（稳定排序下按 offset 接续）'
  );
  let offset = 0, seen = new Set();
  for (let guard = 0; guard < 20; guard++) {
    const p = buildMcpSearchPage({ servers: ['Bulk'], tools: many, limit: 5, offset });
    p.tools.forEach(t => seen.add(t.name));
    if (p.nextOffset === undefined) break;
    offset = p.nextOffset;
  }
  assert.equal(seen.size, 40, '分页不重不漏覆盖全部条目');

  // limit/offset 归一：非法值收敛到默认，不抛
  const clamped = buildMcpSearchPage({ servers: ['Bulk'], tools: many, limit: 'abc', offset: -3 });
  assert.equal(clamped.tools.length, 10, '非法 limit 回落默认 10、offset 负数归零');

  console.log('ok   mcpRelay 纯投影（空配置/摘要与 schema/过滤/连接失败旁路/预算续页）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('mcp-config: ok');
