/**
 * Isolated MCP server-list management and real SDK relay reachability diagnostics.
 * B4 (capability-delivery): the per-engine deployment subsystem (native discovery /
 * adoption / ownership ledgers / drift observation / targetIds routing) was retired.
 * What remains under test: config-backed server CRUD with masked credentials,
 * revision protection, JSON import, legacy targetIds passthrough (display retired),
 * untouched legacy data files, and testMcpConnection (initialize + tools/list).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'mcp-management-'));
const compile = createSharedCompiler(root, tmp);
for (const name of ['@modelcontextprotocol/sdk']) {
  const real = path.resolve(path.dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js')), '..', '..', '..');
  const dest = path.join(tmp, 'node_modules', name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(real, dest, process.platform === 'win32' ? 'junction' : 'dir');
}
const { McpManagementService } = await import(pathToFileURL(compile('main/capabilityManagement/mcpManagement.ts')).href);
const { testMcpConnection } = await import(pathToFileURL(compile('main/capabilityManagement/mcpConnectionTest.ts')).href);
const { decodeChildOutput } = await import(pathToFileURL(compile('main/encoding/winUtf8.ts')).href);
const project = path.join(tmp, 'project');
const userData = path.join(tmp, 'userData');
fs.mkdirSync(project, { recursive: true });
let cfg = { mcp: { enabled: true, servers: [] }, mcpByWorkspace: {}, activeWorkspaceId: 'ws' };
const deps = { getConfig: () => cfg, updateConfig: patch => { cfg = { ...cfg, ...patch }; }, workspaceRoot: id => id === 'ws' ? project : undefined };
const service = new McpManagementService(deps);
const stdio = (name) => ({ name, transport: 'stdio', enabled: true, command: process.execPath, args: ['server.mjs'] });
let count = 0;
async function check(label, job) { await job(); console.log(`ok   ${label}`); count++; }

try {
  await check('服务器清单只落配置：项目/全局分仓、凭据打码、不再触碰引擎文件', async () => {
    const global = await service.save({ scope: 'global', server: { ...stdio('global'), env: { TOKEN: 'raw-global-secret' } } });
    assert.equal(global.server.env.TOKEN, '***');
    const local = await service.save({ scope: 'project', workspaceId: 'ws', server: stdio('local') });
    assert.equal(local.scope, 'project');
    const inventory = await service.list('ws');
    assert.equal(inventory.servers.find(entry => entry.server.name === 'global').inherited, true);
    assert.equal(inventory.servers.find(entry => entry.server.name === 'global').overridden, false);
    assert.equal(inventory.deployments, undefined, '部署台账已随 B4 退役');
    assert.equal(inventory.targets, undefined, '入口分发 DTO 已随 B4 退役');
    for (const file of [path.join(tmp, 'home'), path.join(project, '.mcp.json'), path.join(project, '.cursor'), path.join(project, '.codex'), path.join(project, '.claude.json')]) {
      assert.equal(fs.existsSync(file), false, `服务层不得再写引擎原生配置：${file}`);
    }
    assert.equal(cfg.mcp.servers[0].env.TOKEN, 'raw-global-secret', '配置侧保留真实凭据');
  });

  await check('保留隐藏凭证，内容改动令旧 revision 失效，空对象才删凭证', async () => {
    const entry = (await service.list()).servers.find(entry => entry.server.name === 'global');
    await service.save({ id: entry.id, scope: 'global', expectedRevision: entry.revision, server: { ...entry.server, args: ['changed.mjs'] } });
    assert.equal(cfg.mcp.servers[0].env.TOKEN, 'raw-global-secret');
    await assert.rejects(() => service.save({ id: entry.id, scope: 'global', expectedRevision: entry.revision, server: entry.server }), /已被修改/);
    const fresh = await service.get(entry.id);
    await service.save({ id: fresh.id, scope: 'global', expectedRevision: fresh.revision, server: { ...fresh.server, env: {} } });
    assert.equal(cfg.mcp.servers[0].env, undefined, '删除凭证需要显式空对象');
    await assert.rejects(() => service.save({ scope: 'global', server: { ...stdio('global'), env: { TOKEN: '***' } } }), /没有已保存的值/, '打码值不能凭空当真实值');
  });

  await check('legacy targetIds 原样透传（数据保留、展示退役），旧数据文件不被触碰', async () => {
    cfg = { ...cfg, mcp: { ...cfg.mcp, servers: [...cfg.mcp.servers, { ...stdio('legacy-bound'), targetIds: ['claude-cli', 'retired-worker'] }] } };
    const entry = (await service.list()).servers.find(item => item.server.name === 'legacy-bound');
    assert.deepEqual(entry.server.targetIds, ['claude-cli', 'retired-worker'], '旧绑定字段在清单里保持原样');
    await service.save({ id: entry.id, scope: 'global', expectedRevision: entry.revision, server: { ...entry.server, args: ['kept.mjs'] } });
    assert.deepEqual(cfg.mcp.servers.find(server => server.name === 'legacy-bound').targetIds, ['claude-cli', 'retired-worker'], '编辑其他字段不清除旧绑定');
    // B4 退役的旧台账（origins/ownership/status）只停展示，服务层不再读写；
    // 预置旧文件验证不受影响。
    const legacyDir = path.join(userData, 'capability-management');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFiles = ['mcp-native-origins.json', 'mcp-native-ownership.json', 'mcp-native-status.json'].map(name => path.join(legacyDir, name));
    for (const file of legacyFiles) fs.writeFileSync(file, '{"legacy":true}');
    await service.list('ws');
    await service.remove({ id: entry.id, expectedRevision: (await service.get(entry.id)).revision });
    for (const file of legacyFiles) assert.equal(fs.readFileSync(file, 'utf8'), '{"legacy":true}', `退役数据文件必须原样保留：${path.basename(file)}`);
  });

  await check('MCP 导入不能隐式覆盖已有内容，替换需带版本', async () => {
    await assert.rejects(() => service.importJson({ scope: 'global', json: '{"global":{"command":"other"}}' }), /需要先查看/);
    const added = await service.importJson({ scope: 'global', json: '{"fresh":{"url":"http://127.0.0.1/mcp","type":"http"}}' });
    assert.equal(added[0].server.transport, 'http');
    assert.ok(cfg.mcp.servers.some(server => server.name === 'global'));
  });

  await check('实际 stdio SDK 连接诊断（直连握手），工具目录、超时清理与命令缺失', async () => {
    const sdkServer = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
    const sdkStdio = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
    const serverFile = path.join(tmp, 'server.mjs');
    const pidFile = path.join(tmp, 'server.pid');
    fs.writeFileSync(serverFile, `import fs from 'node:fs';\nimport { McpServer } from ${JSON.stringify(sdkServer)};\nimport { StdioServerTransport } from ${JSON.stringify(sdkStdio)};\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nconst server = new McpServer({name:'fixture',version:'1.0.0'});\nserver.registerTool('identity', {description:'isolated fixture',inputSchema:{}}, async()=>({content:[{type:'text',text:'ISOLATED'}]}));\nawait server.connect(new StdioServerTransport());\n`);
    const tested = await testMcpConnection({ ...stdio('fixture'), args: [serverFile] }, 3000);
    assert.equal(tested.status, 'connected', tested.message);
    assert.match(tested.message, /握手成功/);
    assert.equal(/中转可达/.test(tested.message), false, '直连握手不得宣称「中转可达」');
    assert.deepEqual(tested.tools.map(tool => tool.name), ['identity']);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), undefined, '成功诊断后清理子进程');
    const hungFile = path.join(tmp, 'hung.mjs');
    const hungPid = path.join(tmp, 'hung.pid');
    fs.writeFileSync(hungFile, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(hungPid)},String(process.pid)); process.stdin.resume();`);
    const timed = await testMcpConnection({ ...stdio('hung'), args: [hungFile] }, 250);
    assert.equal(timed.status, 'timeout', timed.message);
    if (fs.existsSync(hungPid)) assert.throws(() => process.kill(Number(fs.readFileSync(hungPid, 'utf8')), 0), undefined, '超时也清理子进程');
    if (process.platform === 'win32') {
      const nestedFile = path.join(tmp, 'nested-hung.mjs');
      const nestedPid = path.join(tmp, 'nested.pid');
      fs.writeFileSync(nestedFile, `import fs from 'node:fs'; import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); fs.writeFileSync(${JSON.stringify(nestedPid)},String(child.pid)); process.stdin.resume(); setInterval(()=>{},1000);`);
      const nested = await testMcpConnection({ ...stdio('nested'), args: [nestedFile] }, 750);
      assert.equal(nested.status, 'timeout', nested.message);
      assert.ok(fs.existsSync(nestedPid), 'Windows 启动器夹具实际产生子进程');
      assert.throws(() => process.kill(Number(fs.readFileSync(nestedPid, 'utf8')), 0), undefined, 'Windows 诊断超时终止自己创建的整个进程树');
    }
    const missing = await testMcpConnection({ ...stdio('missing'), command: path.join(tmp, crypto.randomUUID()), args: [] }, 1000);
    assert.equal(missing.status, 'command-missing', missing.message);
    assert.equal(decodeChildOutput(Buffer.from('有效 UTF8 中文')), '有效 UTF8 中文');
    if (process.platform === 'win32') assert.equal(decodeChildOutput(Buffer.from([0xb2, 0xbb, 0xca, 0xc7])), '不是', 'Windows GBK stderr实际解码，不对乱码字符串猜错误类型');
  });

  await check('清理失败不吞诊断结果：子进程杀不掉时作为 cleanupError 附加字段返回（mcp-settings F-01）', async () => {
    const sdkServer = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
    const sdkStdio = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
    const serverFile = path.join(tmp, 'cleanup-fail-server.mjs');
    fs.writeFileSync(serverFile, `import { McpServer } from ${JSON.stringify(sdkServer)};\nimport { StdioServerTransport } from ${JSON.stringify(sdkStdio)};\nconst server = new McpServer({name:'cleanup-fail',version:'1.0.0'});\nserver.registerTool('identity', {description:'fixture',inputSchema:{}}, async()=>({content:[{type:'text',text:'OK'}]}));\nawait server.connect(new StdioServerTransport());\n`);
    // 伪造「诊断子进程永远杀不掉」：探测(signal 0) 与 SIGKILL 都假装成功。
    // 旧实现此时 cleanup 在 finally 里 throw，把已组装的 connected 结果整体变成 IPC 异常。
    const realKill = process.kill;
    process.kill = (pid, signal) => {
      if (signal === 0 || signal === 'SIGKILL') return true;
      return realKill(pid, signal);
    };
    try {
      const tested = await testMcpConnection({ ...stdio('cleanup-fail'), args: [serverFile] }, 4000);
      assert.equal(tested.status, 'connected', tested.message, '清理失败不得替换诊断结论');
      assert.match(tested.message, /握手成功/);
      assert.ok(tested.cleanupError, '清理失败作为附加字段并入结果');
      assert.match(tested.cleanupError, /未能退出/);
      assert.equal(tested.tools.length, 1, '工具目录不被清理失败清掉');
    } finally { process.kill = realKill; }
  });

  await check('实际 HTTP SDK 连接诊断和认证失败，不启动用户登录', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const sdk = new McpServer({ name: 'http-fixture', version: '1.0.0' });
    sdk.registerTool('http_identity', { description: 'HTTP fixture', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'HTTP' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await sdk.connect(transport);
    let authRequests = 0;
    const server = http.createServer(async (request, response) => {
      if (request.url === '/auth') { authRequests++; response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="isolated"' }); response.end('Unauthorized'); return; }
      if (request.url === '/hang') return;
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      let body; if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { response.writeHead(400); response.end(); return; } }
      await transport.handleRequest(request, response, body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); const base = `http://127.0.0.1:${address.port}`;
    try {
      const success = await testMcpConnection({ name: 'http', enabled: true, transport: 'http', url: `${base}/mcp` }, 3000);
      assert.equal(success.status, 'connected', success.message);
      assert.equal(success.tools[0].name, 'http_identity');
      const failed = await testMcpConnection({ name: 'auth', enabled: true, transport: 'http', url: `${base}/auth`, headers: { Authorization: 'Bearer sensitive-fixture' } }, 1500);
      assert.equal(failed.status, 'auth-required', failed.message);
      assert.equal(failed.message.includes('sensitive-fixture'), false);
      assert.equal(authRequests, 1, '认证失败直接报告，不回落 SSE 或启动 OAuth');
      const timeout = await testMcpConnection({ name: 'hang', enabled: true, transport: 'http', url: `${base}/hang` }, 250);
      assert.equal(timeout.status, 'timeout', timeout.message);
    } finally { await sdk.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await check('总开关关闭时测试结果报 relay-disabled（不跑握手）；开关切换后旧结果按开关前提展示', async () => {
    let handshakes = 0;
    const probe = async () => {
      handshakes++;
      return { ok: true, status: 'connected', tools: [], message: 'handshake', checkedAt: new Date().toISOString(), durationMs: 1 };
    };
    let local = structuredClone({ ...cfg, mcp: { ...cfg.mcp, enabled: false } });
    const svc = new McpManagementService({ getConfig: () => local, updateConfig: patch => { local = { ...local, ...patch }; }, workspaceRoot: id => id === 'ws' ? project : undefined, testConnection: probe });
    const id = (await svc.list()).servers.find(entry => entry.server.name === 'global').id;

    // 关闭时：不启动诊断子进程，结果明确不可用，且不出现「中转可达/握手成功」
    const disabled = await svc.test(id);
    assert.equal(disabled.status, 'relay-disabled');
    assert.equal(disabled.ok, false);
    assert.match(disabled.message, /总开关未启用/);
    assert.equal(handshakes, 0, '总开关关闭时不得执行独立握手');
    let listed = (await svc.list()).servers.find(entry => entry.id === id);
    assert.equal(listed.test?.status, 'relay-disabled', '关闭状态下的 relay-disabled 结果保持展示');

    // 开启后：relay-disabled 结果不再代表可用性（不再展示），测试走真实握手并缓存
    local = { ...local, mcp: { ...local.mcp, enabled: true } };
    listed = (await svc.list()).servers.find(entry => entry.id === id);
    assert.equal(listed.test, undefined, '开关切换后旧结果不再展示');
    const enabled = await svc.test(id);
    assert.equal(enabled.status, 'connected');
    assert.equal(handshakes, 1);
    listed = (await svc.list()).servers.find(entry => entry.id === id);
    assert.equal(listed.test?.status, 'connected');

    // 再关闭：缓存的握手成功不再展示（否则关着开关还宣称握手成功）
    local = { ...local, mcp: { ...local.mcp, enabled: false } };
    listed = (await svc.list()).servers.find(entry => entry.id === id);
    assert.equal(listed.test, undefined, '总开关关闭后不得继续展示握手成功结果');
  });

  console.log(`mcp-management: ${count} checks passed`);
} finally {
  // Only our mkdtemp fixture is removed; user home/userData were never used.
  fs.rmSync(tmp, { recursive: true, force: true });
}
