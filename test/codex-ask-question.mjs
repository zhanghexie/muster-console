/**
 * Codex / ACP 问卷目录项 + Codex 全量宿主工具 mcp_servers 注册（B1b）+ 网关
 * askQuestion / requestApproval 通道。
 * 运行: node test/codex-ask-question.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.tmp', 'codex-ask-question');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const compile = createSharedCompiler(root, tmp);

const mcpServersOut = compile('main/agentSession/drivers/acp/mcpServers.ts');
const hostMcpOut = compile('main/agentSession/drivers/codex/hostToolsMcp.ts');
const gatewayOut = compile('main/agentSession/drivers/acp/hostToolGateway.ts');

const {
  askQuestionCatalogEntry,
  requestApprovalCatalogEntry,
  hostToolsToCatalog
} = await import(pathToFileURL(mcpServersOut).href);
const { setupCodexHostToolsMcp, CODEX_HOST_MCP_SERVER, CODEX_HOST_TOOLS_TIMEOUT_SEC } =
  await import(pathToFileURL(hostMcpOut).href);
const { startHostToolGateway } = await import(pathToFileURL(gatewayOut).href);

const hostTool = (id, permissionClass = 'status') => ({
  id,
  label: id,
  description: `${id} 描述`,
  parameters: { type: 'object' },
  permissionClass,
  execute: async () => 'ok'
});

// 网关 HTTP 调用助手（token 鉴权走真实链路）
async function callGateway(gw, payload) {
  const res = await new Promise((resolve, reject) => {
    const u = new URL(gw.url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify({ token: gw.token, ...payload }));
    req.end();
  });
  return res;
}

{
  const entry = askQuestionCatalogEntry();
  assert.equal(entry.name, 'askQuestion');
  assert.match(entry.description, /question|survey/i);
  assert.equal(entry.inputSchema.required.includes('questions'), true);
  const appr = requestApprovalCatalogEntry();
  assert.equal(appr.name, 'host_requestApproval');
  assert.ok(appr.inputSchema.required.includes('toolName'), '审批请求必须带 toolName');
}

{
  const catalog = hostToolsToCatalog([hostTool('sessions.setStatus')], {
    includeAskQuestion: true,
    includeRequestApproval: true
  });
  assert.deepEqual(
    catalog.tools.map((t) => t.name),
    ['sessions_setStatus', 'host_requestApproval']
  );
  assert.deepEqual(hostToolsToCatalog([hostTool('host.ask')], { includeAskQuestion: true }).tools.map(t => t.name), ['host_ask']);
  // 默认不含审批项（ACP 走原生 request_permission，不重复挂自愿档）
  const acpStyle = hostToolsToCatalog([hostTool('sessions.setStatus')], { includeAskQuestion: true });
  assert.equal(
    acpStyle.tools.some((t) => t.name === 'host_requestApproval'),
    false,
    'includeRequestApproval 缺省不追加'
  );
}

{
  const handle = await setupCodexHostToolsMcp({
      sessionId: 's1',
      cwd: tmp,
      hostTools: [hostTool('sessions.setStatus')],
      requestApproval: async () => ({ approved: true }),
      getPolicyState: () => ({ mode: 'default', planExecuting: false }),
      log: () => {}
    });
  try {
    assert.ok(handle, '无问卷通道时仍保留可用宿主工具');
    const names = handle.catalog.tools.map(tool => tool.name);
    assert.ok(names.includes('sessions_setStatus'));
    assert.ok(names.includes('host_requestApproval'));
    assert.ok(!names.includes('askQuestion'), '无问卷通道时不注册问卷');
  } finally { handle?.close(); }
}

{
  const handle = await setupCodexHostToolsMcp(
    {
      sessionId: 's1',
      cwd: tmp,
      hostTools: [hostTool('sessions.setStatus'), hostTool('bgtasks.shell', 'shell')],
      requestApproval: async () => ({ approved: true }),
      requestUserQuestion: async () => ({ kind: 'aborted' }),
      getPolicyState: () => ({ mode: 'default', planExecuting: false }),
      log: () => {}
    },
    // .ts 候选路径已删除（P0-1：不构成可加载入口），测试显式指定脚本
    { hostMcpScript: path.join(root, 'src/main/inboundMcp/stdioEntry.ts') }
  );
  assert.ok(handle, '有问卷通道即注册');
  const server = handle.configFragment.mcp_servers[CODEX_HOST_MCP_SERVER];
  assert.ok(server.command, 'stdio command');
  assert.ok(Array.isArray(server.args) && server.args.length >= 1, 'MCP 脚本 args');
  assert.equal(server.enabled, true);
  // B1b：全量宿主工具 + 问卷 + 自愿审批——与政策层目录同源，不再虚列
  assert.deepEqual(server.enabled_tools, [
    'sessions_setStatus',
    'bgtasks_shell',
    'host_requestApproval'
  ]);
  assert.equal(server.tool_timeout_sec, CODEX_HOST_TOOLS_TIMEOUT_SEC);
  assert.ok(server.env.MUSTER_HOST_TOOLS_URL, '网关 URL');
  assert.ok(server.env.MUSTER_HOST_TOOLS_TOKEN, '网关 token');
  assert.ok(fs.existsSync(server.env.MUSTER_HOST_TOOLS_CATALOG), 'catalog 落盘');
  const catalog = JSON.parse(fs.readFileSync(server.env.MUSTER_HOST_TOOLS_CATALOG, 'utf8'));
  assert.equal(catalog.tools.length, 3, 'catalog 含实际工具且不添加旧问卷别名');
  handle.close();
  assert.equal(fs.existsSync(server.env.MUSTER_HOST_TOOLS_CATALOG), false, 'close 清临时目录');
}

// 旧问卷名不再经网关执行，即使问卷通道存在。
{
  const seen = [];
  const gw = await startHostToolGateway({
    sessionId: 's1',
    cwd: tmp,
    hostTools: [],
    requestApproval: async () => ({ approved: true }),
    requestUserQuestion: async (req) => {
      seen.push(req);
      return { kind: 'answered', answers: [{ id: 'q1', selected: ['是'] }] };
    },
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    log: () => {}
  });
  const res = await callGateway(gw, {
    name: 'askQuestion',
    arguments: {
      title: '确认',
      questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '是' }, { label: '否' }] }]
    }
  });
  assert.equal(seen.length, 0);
  assert.equal(res.isError, true);
  gw.close();
}

// 网关：requestApproval（B1b）→ 审批卡；批准/拒绝文案与反馈回灌
{
  const approvals = [];
  const gw = await startHostToolGateway({
    sessionId: 's1',
    cwd: tmp,
    hostTools: [],
    requestApproval: async (req) => {
      approvals.push(req);
      return approvals.length === 1
        ? { approved: true, feedback: '可以，但别动 config' }
        : { approved: false, reason: '先写测试' };
    },
    requestUserQuestion: async () => ({ kind: 'aborted' }),
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    log: () => {}
  });
  const ok = await callGateway(gw, {
    name: 'host_requestApproval',
    arguments: { toolName: 'shell', input: { command: 'rm -rf dist' }, reason: '清理产物' }
  });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /已批准/);
  assert.match(ok.text, /别动 config/, '批准文本带用户反馈');
  assert.equal(approvals[0].toolName, 'shell');
  assert.deepEqual(approvals[0].input, { command: 'rm -rf dist' });
  assert.equal(approvals[0].reason, '清理产物', 'reason 原样透传');

  const denied = await callGateway(gw, {
    name: 'host_requestApproval',
    arguments: { toolName: 'shell', input: { command: 'rm -rf node_modules' } }
  });
  assert.equal(denied.isError, false, '拒绝不是执行错误（模型读文本调整方案）');
  assert.match(denied.text, /用户拒绝：先写测试/);
  assert.match(denied.text, /不要执行/, '拒绝必须指示放弃动作');
  gw.close();
}

// 网关：无审批通道时 requestApproval 明确报错（fail-closed，不静默批准）
{
  const gw = await startHostToolGateway({
    sessionId: 's1',
    cwd: tmp,
    hostTools: [],
    requestUserQuestion: async () => ({ kind: 'aborted' }),
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    log: () => {}
  });
  const res = await callGateway(gw, { name: 'host_requestApproval', arguments: { toolName: 'shell' } });
  assert.equal(res.isError, true);
  assert.match(res.text, /未接入审批通道/);
  gw.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] codex-ask-question');
