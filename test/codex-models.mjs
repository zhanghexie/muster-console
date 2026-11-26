/** Codex 目录的实际 stdio 子进程合同，及原生 app-server 的模型与档位传输。无厂商推理。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { queryCodexModels } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/models.ts')));
const { CodexRuntimeDriver } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/driver.ts')));
const fixture = path.join(tmp, 'app-server.cjs');
fs.writeFileSync(fixture, `
const rl=require('node:readline').createInterface({input:process.stdin});
let initialized=false;
rl.on('line',line=>{
 const m=JSON.parse(line);const answer=(result,error)=>process.stdout.write(JSON.stringify({id:m.id,result,error})+'\\n');
 if(m.method==='initialize')return answer({});
 if(m.method==='initialized'){initialized=true;return;}
 if(!initialized)return answer(null,{message:'missing initialized'});
 const scenario=process.env.CATALOG_CASE;
 if(m.method==='config/read')return answer({config:scenario==='empty'?{}:{model:'configured',model_reasoning_effort:'high',profiles:{p:{model:'profile-model'}},api_key:'must-not-leak'}});
 if(scenario==='hang')return;
 if(scenario==='bad-json')return process.stdout.write('invalid\\n');
 if(scenario==='early-exit')return process.exit(4);
 if(scenario==='unsupported')return answer(null,{message:'Method not found'});
 if(scenario==='empty')return answer({data:[],nextCursor:null});
 if(m.params.cursor && scenario==='partial-bad')return answer({});
 if(m.params.cursor)return answer({data:[{model:'second',displayName:'Second',supportedReasoningEfforts:[]}],nextCursor:scenario==='loop'?'page2':null});
 answer({data:[{id:'opaque-id',model:'first',displayName:'First',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low'},{model:'hidden',hidden:true},{model:'first'},{model:''}],nextCursor:'page2'});
});
`);
const env = { ...process.env };
try {
  const query = (scenario, timeoutMs = 3000) => queryCodexModels(process.execPath, tmp, { argsPrefix: [fixture], env: { ...env, CATALOG_CASE: scenario }, timeoutMs });
  const result = await query('normal');
  assert.equal(result.ok, true); assert.equal(result.source, 'app-server');
  assert.deepEqual(result.items.map((item) => item.id), ['first', 'second', 'configured', 'profile-model']);
  assert.equal(result.defaultModelId, 'configured');
  assert.deepEqual(result.items[0].parameters[0].options.map(o => o.value), ['low', 'high']);
  assert.equal(result.items[0].parameters[0].defaultValue, 'low');
  assert.deepEqual(result.defaultParameters, { reasoning: 'high' });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  const catalogDriver = new CodexRuntimeDriver({}, { userDataDir: tmp }, { listModels: async () => result });
  const describe = modelId => catalogDriver.describeModelParameters({ cwd: tmp, modelOverride: { providerId: 'codex-gui', modelId } });
  const configuredOnly = await describe('configured');
  assert.equal(configuredOnly.unavailable, true, 'a configuration-only model ID has unconfirmed reasoning options');
  assert.match(configuredOnly.warning, /configured/);
  const withoutEffort = await describe('second');
  assert.equal(withoutEffort.unavailable, undefined, 'an empty native effort list is a confirmed result');
  assert.deepEqual(withoutEffort.parameters, []);
  const fallback = await query('unsupported');
  assert.equal(fallback.ok, true); assert.equal(fallback.source, 'config');
  assert.match(fallback.warning, /Method not found/);
  assert.deepEqual(fallback.items.map((item) => item.id), ['configured', 'profile-model']);
  for (const scenario of ['empty', 'bad-json', 'early-exit', 'loop', 'partial-bad', 'hang']) {
    const failed = await query(scenario, scenario === 'hang' ? 500 : 3000);
    assert.equal(failed.ok, false, scenario + ' 不可默默空成功');
    assert.ok(failed.error);
  }

  const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')));
  const workerDir = path.join(root, 'src/main/agentSession/drivers/codex/worker');
  const hostMcpScript = path.join(tmp, 'host-mcp.cjs');
  fs.writeFileSync(hostMcpScript, '');
  fs.writeFileSync(path.join(tmp, 'app-server'), String.raw`
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const threadId = 'fixture-thread';
const turnId = 'fixture-turn';
let tools = {};
let threadRequest;
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const { method, params } = request;
  const emit = message => console.log(JSON.stringify(message));
  const answer = result => emit({ id: request.id, result });
  if (method === 'initialize') return answer({ codexHome: process.env.CODEX_HOME });
  if (method === 'permissionProfile/list') return answer({ data: [], nextCursor: null });
  if (method === 'thread/start' || method === 'thread/resume') {
    threadRequest = { method, params };
    tools = Object.fromEntries((params.config['mcp_servers.muster'].enabled_tools ?? []).map(name => [name, {}]));
    return answer({ thread: { id: threadId }, cwd: params.cwd });
  }
  if (method === 'mcpServerStatus/list') return answer({ data: [{ name: 'muster', runtimeStatus: 'connected', tools }] });
  if (method !== 'turn/start') return answer({});
  fs.writeFileSync('rpc.json', JSON.stringify({ thread: threadRequest, turn: params }));
  answer({ turn: { id: turnId } });
  emit({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'reply', text: 'ok' } } });
  emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
});`);
  const driver = new CodexRuntimeDriver({ config: { effectiveMcp: () => ({ enabled: false, servers: [] }) } }, { userDataDir: tmp }, {
    createAppServerClient: options => createCodexAppServerClient({
      ...options, env: { ...options.env, CODEX_HOME: path.join(tmp, 'codex-home') }
    }, { workerPath: path.join(workerDir, 'native-worker.mjs'), jobPath: path.join(workerDir, 'windows-job.ps1') }),
    resolveExecutable: async () => ({ ok: true, executable: process.execPath, packaged: false }),
    hostMcpScript
  });
  for (const [model, effort] of [['chosen', 'high'], ['next', 'low'], [undefined, undefined]]) {
    const first = model === 'chosen';
    const conn = await driver.connect({
      sessionId: 'fixture', cwd: tmp, resumeToken: first ? undefined : 'fixture-thread',
      modelOverride: model ? { providerId: 'codex-gui', modelId: model } : undefined,
      mode: 'default', planExecuting: false, systemPromptAppend: '', hostTools: [], modeController: {},
      getTurnId: () => 'host-turn', getPolicyState: () => ({ mode: 'default', planExecuting: false }),
      requestApproval: async () => ({ approved: true }), log() {}
    });
    const received = [];
    const drain = (async () => { for await (const event of conn.events) received.push(event); })();
    const rpcFile = path.join(tmp, 'rpc.json');
    if (fs.existsSync(rpcFile)) fs.unlinkSync(rpcFile);
    try {
      await conn.send('reply ok', undefined, effort ? { reasoning: effort } : {});
    } finally {
      await conn.close();
      await drain;
    }
    assert.equal(received.find(event => event.type === 'error'), undefined);
    assert.ok(received.some(event => event.type === 'turn-complete'));
    const { thread, turn } = JSON.parse(fs.readFileSync(rpcFile, 'utf8'));
    assert.equal(thread.method, first ? 'thread/start' : 'thread/resume');
    assert.equal(thread.params.threadId, first ? undefined : 'fixture-thread');
    assert.equal(thread.params.cwd, tmp);
    assert.equal(thread.params.model, model, 'native thread model override or default');
    assert.equal(turn.model, model, 'native turn model override or default');
    assert.equal(turn.effort, effort, 'native reasoning override or default');
  }
} finally {
  assert.ok(tmp.startsWith(os.tmpdir() + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log('ok codex-models (stdio catalog, config fallback, errors, native thread and turn RPC)');
