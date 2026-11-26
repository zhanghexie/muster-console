/**
 * Worker 身份绑定回归：CLI /v1/tool 与 GUI 进程内共用 bindWorkerToolArgs（规则表在
 * shared/hostTools meta 的 bind 字段）。
 * 回归点：CLI 面原先只在缺 sessionId 时才补本会话 id，Worker 显式传他人 sessionId
 * 可改他人看板/改名/发起合入；GUI 面强制覆盖——两面规则分叉。
 * 运行: node test/worker-binding.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-binding-'));
const compile = createSharedCompiler(root, tmp);

const { bindWorkerToolArgs, workerToolRequiresToken } = await import(
  pathToFileURL(compile('main/capabilities/workerBinding.ts')).href
);
const { ACTOR_SESSION_ID_ARG, ACTOR_BOUND_TOOL_IDS } = await import(
  pathToFileURL(compile('main/capabilities/hosts/actors.ts')).href
);
const { HOST_TOOL_METAS, HOST_STATUS_TOOL_IDS, PTY_HOST_TOOL_ALLOWLIST } = await import(
  pathToFileURL(compile('shared/hostTools/index.ts')).href
);

const ctx = {
  sessions: {
    get: (id) => (id === 'se-me' ? { id: 'se-me', name: '我', workspaceId: 'ws-1' } : undefined)
  }
};

// self 绑定：显式传他人 sessionId / externalSessionId 都被强制改回调用方
for (const tool of ['sessions.setStatus', 'sessions.rename', 'sessions.requestIntegrate']) {
  const out = bindWorkerToolArgs(ctx, tool, { sessionId: 'se-other', externalSessionId: 'ext-x', phase: 'done' }, 'se-me');
  assert.equal(out.sessionId, 'se-me', `${tool} 不得改他人会话`);
  assert.equal('externalSessionId' in out, false, `${tool} 丢弃 externalSessionId`);
}
{
  const out = bindWorkerToolArgs(ctx, 'sessions.setStatus', { phase: 'needs_you', note: '等验收' }, 'se-me');
  assert.equal(out.sessionId, 'se-me');
  assert.equal(out.note, '等验收', '业务参数原样保留');
}

// ui.notify：强制本会话 + 补全 workspaceId/sessionName（显式值不覆盖）
{
  const out = bindWorkerToolArgs(ctx, 'ui.notify', { text: 'hi', sessionId: 'se-other' }, 'se-me');
  assert.equal(out.sessionId, 'se-me');
  assert.equal(out.workspaceId, 'ws-1');
  assert.equal(out.sessionName, '我');
  const kept = bindWorkerToolArgs(ctx, 'ui.notify', { text: 'hi', sessionName: '自定' }, 'se-me');
  assert.equal(kept.sessionName, '自定');
}

// All browser ownership follows the authenticated caller, including background selection/cookies.
{
  for (const tool of ['browser.open', 'browser.activate', 'browser.cookies', 'browser.snapshot']) {
    const forged = { url: 'https://test.local/', tabId: 'tab-b', action: 'get', __browserOwner: { workspaceId: 'forged', sessionId: 'other' } };
    const out = bindWorkerToolArgs(ctx, tool, forged, 'se-me');
    assert.deepEqual(out.__browserOwner, { workspaceId: 'ws-1', sessionId: 'se-me' }, `${tool} must bind the authenticated actor`);
    assert.equal(out.tabId, 'tab-b');
    assert.equal(out.url, 'https://test.local/');
    assert.equal(out.action, 'get');
    assert.deepEqual(forged.__browserOwner, { workspaceId: 'forged', sessionId: 'other' }, 'binding does not mutate caller arguments');
    const unknown = bindWorkerToolArgs(ctx, tool, { __browserOwner: { sessionId: 'forged' } }, 'missing');
    assert.equal('__browserOwner' in unknown, false, `${tool} must not preserve an unknown actor`);
  }
  const otherCtx = { sessions: { get: (id) => id === 'background' ? { name: '后台', workspaceId: 'ws-background' } : undefined } };
  assert.deepEqual(bindWorkerToolArgs(otherCtx, 'browser.activate', { tabId: 'tab-b' }, 'background').__browserOwner,
    { workspaceId: 'ws-background', sessionId: 'background' }, 'background selection must retain its own actor');
  const projectlessCtx = { sessions: { get: (id) => id === 'projectless' ? { name: '独立会话' } : undefined } };
  assert.deepEqual(bindWorkerToolArgs(projectlessCtx, 'browser.cookies', {}, 'projectless').__browserOwner,
    { sessionId: 'projectless' }, 'a real session remains isolated without a workspace');
  assert.equal('__browserOwner' in bindWorkerToolArgs(ctx, 'sessions.observe', { __browserOwner: { sessionId: 'forged' } }, 'se-me'), false,
    'other tools cannot smuggle a browser actor');
}

// actor 绑定：伪造 __actorSessionId 被覆盖
for (const tool of ACTOR_BOUND_TOOL_IDS) {
  const out = bindWorkerToolArgs(ctx, tool, { [ACTOR_SESSION_ID_ARG]: 'se-forged' }, 'se-me');
  assert.equal(out[ACTOR_SESSION_ID_ARG], 'se-me', `${tool} actor 以调用方为准`);
}

// 非绑定工具：伪造 __actorSessionId 被剥掉，其余参数与 sessionId 原样（观察类可查别的会话）
{
  const out = bindWorkerToolArgs(ctx, 'sessions.observe', { sessionId: 'se-other', [ACTOR_SESSION_ID_ARG]: 'se-forged' }, 'se-me');
  assert.equal(ACTOR_SESSION_ID_ARG in out, false);
  assert.equal(out.sessionId, 'se-other');
}

// 规则表自洽：状态四件套全是 self；actor 清单全在 Worker 白名单；Worker 面每个会写入
// 他人可见状态的工具（permissionClass=status）都声明了绑定
{
  for (const id of HOST_STATUS_TOOL_IDS) {
    assert.equal(HOST_TOOL_METAS.find((m) => m.id === id)?.bind, ['ui.suggestReplies', 'ui.reminders'].includes(id) ? 'actor' : 'self', `${id} 须绑定可信身份`);
  }
  for (const id of ACTOR_BOUND_TOOL_IDS.filter(id=>HOST_TOOL_METAS.find(m=>m.id===id)?.presets.includes('pty-allowlist'))) assert.ok(PTY_HOST_TOOL_ALLOWLIST.includes(id), `${id} 在 Worker 白名单`);
  for(const id of ['memory.search','memory.list','memory.note','memory.remember'])assert.ok(ACTOR_BOUND_TOOL_IDS.includes(id),`${id} 必须绑定真实会话身份`);
  assert.ok(!PTY_HOST_TOOL_ALLOWLIST.includes('memory.remember'),'CLI会话令牌没有原始用户授权面');
  const catalogBacked = HOST_TOOL_METAS.filter((m) => !m.schema && m.group !== 'browser');
  const unbound = catalogBacked.filter((m) => m.permissionClass === 'status' && !m.bind).map((m) => m.id);
  assert.deepEqual(unbound, [], `status 档工具须声明 bind：${unbound.join(', ')}`);
}

// 缺令牌拒绝：self 与 actor 都要令牌。回归点：原先只拦 actor，self 工具无令牌时不进绑定，
// 显式传他人 sessionId 即可改他人看板/改名/发起合入
{
  for (const id of HOST_STATUS_TOOL_IDS) assert.equal(workerToolRequiresToken(id), true, `${id} 缺令牌须拒`);
  for (const id of ACTOR_BOUND_TOOL_IDS) assert.equal(workerToolRequiresToken(id), true, `${id} 缺令牌须拒`);
  assert.equal(workerToolRequiresToken('sessions.observe'), false, '观察类工具不要求令牌');
}

// 两条调用链都经 bindWorkerToolArgs，且不再手写按工具名补 sessionId 的分支
{
  const shellApi = fs.readFileSync(path.join(root, 'src/main/protocol/shellApi.ts'), 'utf8');
  assert.match(shellApi, /bindWorkerToolArgs\(/, 'shellApi /v1/tool 走共用绑定');
  assert.match(shellApi, /callingSessionId:\s*caller\.id/, 'CLI 令牌身份须传入 executor 的会话上下文，asSubagent 才能取到父');
  assert.doesNotMatch(shellApi, /toolName === 'sessions\.setStatus'/, 'shellApi 不再手写 self 绑定');
  const gui = fs.readFileSync(path.join(root, 'src/main/agentSession/tools/catalogHostTools.ts'), 'utf8');
  assert.match(gui, /bindWorkerToolArgs\(/, 'GUI 进程内工具走共用绑定');
  assert.doesNotMatch(gui, /ACTOR_SESSION_ID_ARG/, 'GUI 面不按工具名手写 actor 绑定');
}

// 实际 /v1/tool handler：仅外部依赖打桩，不开 HTTP 端口或真实 Electron。
// 还原 callingSessionId 透传时，此用例丢失父身份而转红。
{
  const ts = createRequire(import.meta.url)('typescript');
  const source = fs.readFileSync(path.join(root, 'src/main/protocol/shellApi.ts'), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, '');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [], externalCandidates=[];
  const {toolNameMatches}=await import(pathToFileURL(compile('shared/toolDiscovery.ts')).href);
  // R2 起 shellApi 对 run 入口先展开真实目标——桩环境补齐两个新依赖（用真实实现守契约）
  const { runToolDomainOf } = await import(pathToFileURL(compile('main/capabilities/catalog/runTools.ts')).href);
  const { expandRunToolCall } = await import(pathToFileURL(compile('main/capabilities/runRouter.ts')).href);
  const { ptyProjectedCatalog } = await import(pathToFileURL(compile('main/capabilities/catalog/projectedCatalog.ts')).href);
  const { resolveProjectedHostApiName, routeProjectedHostCall } = await import(pathToFileURL(compile('main/capabilities/projectedHostRoute.ts')).href);
  const { executeProjectedPty } = await import(pathToFileURL(compile('main/capabilities/projectedPty.ts')).href);
  const { modelToolResult } = await import(pathToFileURL(compile('shared/modelToolResult.ts')));
  const shot = { ok: true, path: '/fixture/shot', previewPath: '/fixture/shot' };
  const deps = {
    ...(await import(pathToFileURL(compile('main/protocol/statusBody.ts')))),
    ...(await import(pathToFileURL(compile('shared/setStatus.ts')))),
    ...(await import(pathToFileURL(compile('shared/escalateBudget.ts')))),
    ...(await import(pathToFileURL(compile('shared/boardStatus.ts')))),
    toolNameMatches, runWithExternalMemoryCandidate: async (id,invoke)=>{externalCandidates.push(id);return invoke();},
    AcceptedWork: (await import(pathToFileURL(compile('main/net/acceptedWork.ts')).href)).AcceptedWork,
    requestAbort: () => { const controller = new AbortController(); return { controller, signal: controller.signal, dispose() {} }; },
    runToolDomainOf, expandRunToolCall, ptyProjectedCatalog, resolveProjectedHostApiName, routeProjectedHostCall, executeProjectedPty,
    exports: {}, ACTOR_SESSION_ID_ARG, bindWorkerToolArgs, workerToolRequiresToken,
    parseJsonBufferFlexible: buffer => JSON.parse(buffer.toString('utf8')),
    isWorkerAllowedTool: () => true,
    executeTool: async (_ctx, name, json, opts) => { calls.push({ name, args: JSON.parse(json), opts }); return name === 'browser.screenshot' ? { ok: true, result: shot } : { ok: true }; },
    serializeModelToolResult: (raw, name, args) => JSON.stringify({ ok: raw.ok, result: modelToolResult(name, args, raw.result) }),
    serializeResult: JSON.stringify, recordBrowserToolUse: () => {},
    errorMessage: error => error.message, t: text => text
  };
  const ShellApiServer = Function(...Object.keys(deps), `${code}\nreturn exports.ShellApiServer;`)(...Object.values(deps));
  const worker = ctx.sessions.get('se-me'), scope = {};
  const server = new ShellApiServer({ sessions: { get: id => id === worker.id ? worker : undefined,
    peek: id => id === worker.id ? worker : undefined, sessionScopeToken: () => scope,
    resolveSessionRef: () => ({ id: 'se-me', matchedBy: 'statusToken' }),
    setPhase: () => worker, setLiveStatus: (_id, live) => { worker.liveStatus = live; },
    consumeEscalateBudget: () => ({ escalate: false, message: 'budget spent' }) } });
  const req = new PassThrough();
  req.method = 'POST'; req.url = '/v1/tool'; req.headers = { authorization: 'Bearer bound-token' };
  const res = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
  const handled = server.handle(req, res);
  req.end(JSON.stringify({ name: 'host.sessions.create', arguments: { asSubagent: true, isolation: 'shared', task: 'read' } }));
  await handled;
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(calls[0].args.__actorSessionId, 'se-me');
  assert.equal(calls[0].opts.callingSessionId, 'se-me', '父身份取 Bearer 令牌，不能取模型参数');
  const post = async (url, body, headers) => {
    const req = new PassThrough();
    req.method = 'POST'; req.url = url; req.headers = { authorization: headers.Authorization };
    const res = { writeHead(status) { this.status = status; }, end(text) { this.text = text; } };
    const pending = server.handle(req, res); req.end(JSON.stringify(body)); await pending;
    return { ok: res.status === 200, status: res.status, text: res.text };
  };
  const shotArgs = { action: 'screenshot', params: { tabId: 'tab' } };
  const { dispatchInboundMcpTool } = await import(pathToFileURL(compile('shared/inboundMcp.ts')));
  const inbound = await dispatchInboundMcpTool('host_browser_run', shotArgs,
    { token: 'bound-token', toolUrl: '/v1/tool', statusUrl: '/status' }, { postJson: post }, ['host.browser.run']);
  assert.deepEqual(JSON.parse(inbound.content[0].text), { ok: true, result: { ok: true, path: shot.path } });
  const scripted = await post('/v1/tool', { name: 'host.browser.run', arguments: shotArgs }, { Authorization: 'Bearer bound-token' });
  assert.deepEqual(JSON.parse(scripted.text).result, shot, 'an existing HTTP client gets the original fields');
  const statusUrl = '/v1/s/bound-token/status';
  const report = async args => {
    const reply = await dispatchInboundMcpTool('host_sessions_setStatus', args,
      { token: 'bound-token', toolUrl: '/v1/tool', statusUrl }, { postJson: post }, ['host.sessions.setStatus']);
    assert.ok(!reply.isError, reply.content[0].text);
    return JSON.parse(reply.content[0].text);
  };
  worker.phase = { value: 'needs_you', source: 'user', ts: 1 };
  assert.equal((await post(statusUrl, { phase: 'idle' }, {})).ok, false);
  assert.deepEqual(await report({ phase: 'done' }), {
    ok: true, sessionId: worker.id, phase: 'needs_you', phaseSource: 'user'
  }, 'report the effective sticky board state');
  assert.deepEqual(await report({ note: '推进' }), {
    ok: true, sessionId: worker.id, liveStatus: { label: '推进', kind: 'active' }
  });
  worker.phase = { value: 'idle', source: 'model', ts: 2 };
  assert.deepEqual(await report({ phase: 'needs_you' }), {
    ok: true, sessionId: worker.id, phase: 'idle', phaseSource: 'model', refused: true, message: 'budget spent'
  });
  const rawStatus = await post(statusUrl, { phase: 'needs_you' }, {});
  assert.deepEqual(JSON.parse(rawStatus.text), { ok: true, sessionId: worker.id, matchedBy: 'statusToken',
    phase: 'needs_you', refused: true, message: 'budget spent', warnings: ['budget spent'] });
  {
    // create 现在 additionalProperties:false：模型伪造的身份字段在 schema 阶段即被拒绝，
    // 不再依赖后续剥离（显式失败优于静默忽略）。
    const q = new PassThrough(); q.method = 'POST'; q.url = '/v1/tool'; q.headers = { authorization: 'Bearer bound-token' };
    const response = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
    const done = server.handle(q, response);
    q.end(JSON.stringify({ name: 'host.sessions.create', arguments: { isolation: 'shared', __actorSessionId: 'forged' } }));
    await done;
    assert.equal(response.code, 400, 'forged identity fields are rejected by the create schema');
  }
  {
    const q = new PassThrough(); q.method = 'POST'; q.url = '/v1/tool'; q.headers = { authorization: 'Bearer bound-token' };
    const response = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
    const done = server.handle(q, response); q.end(JSON.stringify({ name: 'sessions.create', arguments: { isolation: 'shared' } })); await done;
    assert.equal(response.code, 403, 'old public names are not accepted');
  }
  {
    const q = new PassThrough(); q.method = 'POST'; q.url = '/v1/tool'; q.headers = {};
    const response = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
    const done = server.handle(q, response); q.end(JSON.stringify({ name: 'host.sessions.observe', arguments: { __actorSessionId: 'forged', __browserOwner: { sessionId: 'forged' } } })); await done;
    assert.equal(response.code, 200, JSON.stringify(response.body));
    assert.equal(calls.at(-1).args.__actorSessionId, undefined);
    assert.equal(calls.at(-1).args.__browserOwner, undefined);
  }
  for (const [action, params, status] of [['inspect', {}, 200], ['run', { id: 'demo', command: 'go' }, 400]]) {
    const before = calls.length;
    const q = new PassThrough(); q.method = 'POST'; q.url = '/v1/tool'; q.headers = { authorization: 'Bearer bound-token' };
    const response = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
    const done = server.handle(q, response); q.end(JSON.stringify({ name: 'host.extensions.run', arguments: { action, params } })); await done;
    assert.equal(response.code, status, JSON.stringify(response.body));
    if (action === 'run') {
      assert.equal(calls.length, before, 'the retired extension action never reaches execution');
    } else {
      const call = calls.at(-1);
      assert.equal(call.name, 'extensions.inspect');
      assert.equal(call.opts.callingSessionId, 'se-me');
      assert.equal(call.args.__actorSessionId, 'se-me');
    }
  }
  {
    const q = new PassThrough(); q.method = 'POST'; q.url = '/v1/tool'; q.headers = { authorization: 'Bearer bound-token' };
    const response = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
    const done = server.handle(q, response); q.end(JSON.stringify({ name: 'host.extensions.run', arguments: { action: 'inspect', params: { __actorSessionId: 'forged' } } })); await done;
    assert.equal(response.code, 400, 'CLI rejects forged identity fields before execution');
  }
  {
    const q = new PassThrough(); q.method = 'POST'; q.url = '/v1/tool'; q.headers = {};
    const response = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
    const done = server.handle(q, response); q.end(JSON.stringify({ name: 'host.extensions.run', arguments: { action: 'inspect', params: {} } })); await done;
    assert.equal(response.code, 401, 'CLI extension authoring requires an authenticated session');
  }
  // R5：发现层退役——memory.note 已常驻，直调（点名与下划线兼容名）不再经 tools.call 代理
  for(const name of ['host.memory.note','host_memory_note']) {
    const q=new PassThrough();q.method='POST';q.url='/v1/tool';q.headers={authorization:'Bearer bound-token'};
    const response={writeHead(code){this.code=code;},end(body){this.body=JSON.parse(body);}};
    const done=server.handle(q,response);q.end(JSON.stringify({name,arguments:{text:'candidate',searchKeys:['candidate']}}));await done;
    assert.equal(response.code,200,JSON.stringify(response.body));
  }
  assert.deepEqual(externalCandidates,['se-me','se-me'],'常驻直调及兼容名不能丢失外部来源边界');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] worker-binding');
