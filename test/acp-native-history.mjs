import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-history-test-'));
const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
const { AcpNativeHistory, acpHistoryActions, acpHistoryStorageKey } =
  await import(pathToFileURL(compile('main/agentSession/drivers/acp/nativeHistory.ts')).href);
const script = path.join(temp, 'fixture.mjs');
const ledger = path.join(temp, 'methods.jsonl');
const scenario = path.join(temp, 'scenario.json');
fs.writeFileSync(script, `
import fs from 'node:fs';
import readline from 'node:readline';
const ledger = ${JSON.stringify(ledger)};
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenario)}, 'utf8'));
const send = value => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', ...value })+'\\n');
readline.createInterface({input:process.stdin}).on('line', line=>{
  const { method, id, params } = JSON.parse(line);
  fs.appendFileSync(ledger, JSON.stringify({ method, params, cwd: process.cwd() })+'\\n');
  if(method==='initialize') return send({id, result:{ protocolVersion:1, agentInfo:scenario.agentInfo, agentCapabilities:{sessionCapabilities:scenario.capabilities}}});
  if(scenario.failure) return send({id,error:scenario.failure});
  send({id,result:scenario.invalidReceipt ? 'unexpected' : scenario.result ?? {}});
});
`);
const setup = (capabilities, options = {}) => fs.writeFileSync(scenario, JSON.stringify({ capabilities, ...options }));
const calls = () => fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const row = { cwd: fs.realpathSync(temp), runtime: 'acp', runtimeResumeToken: 'test-session', piModeId: 'gemini' };
const makeHistory = () => new AcpNativeHistory({
  label: id => ({ gemini:'Gemini CLI',qwen:'Qwen Code',kimi:'Kimi Code' })[id],
  resolve: id => ['gemini', 'qwen', 'kimi'].includes(id) ? { command: process.execPath, args: [script] } : undefined,
  timeout: 5000
});

try {
  assert.deepEqual(acpHistoryActions({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {}, archive: {}, list: {} } } }),
    ['delete', 'archive', 'unarchive']);
  assert.deepEqual(acpHistoryActions({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: null, archive: {} } } }), []);
  assert.deepEqual(acpHistoryActions({ protocolVersion: 2, capabilities: { session: { delete: {} } } }), []);
  setup({ delete: {}, archive: {}, list: {} });
  const history = makeHistory();
  assert.deepEqual(history.describe(row)?.actions, []);
  await history.prepare(row);
  assert.deepEqual(history.describe(row)?.actions, ['delete', 'archive', 'unarchive']);
  assert.equal(history.describe(row)?.permanentDelete, undefined, 'ACP success by itself only confirms removal from history');
  assert.deepEqual(calls().map(call => call.method), ['initialize'], 'discovery does not create, open or modify a session');
  await history.prepare(row);
  assert.equal(calls().length, 1);
  for (const action of ['archive', 'unarchive', 'delete']) await history.update(row, action);
  assert.deepEqual(calls().filter(call => call.method !== 'initialize').map(call => [call.method, call.params]), [
    ['session/archive', { sessionId: row.runtimeResumeToken }],
    ['session/unarchive', { sessionId: row.runtimeResumeToken }],
    ['session/delete', { sessionId: row.runtimeResumeToken }]
  ]);
  setup({}, {});
  await assert.rejects(history.update(row, 'delete'), /未声明此会话历史能力/);
  assert.equal(calls().at(-1).method, 'initialize', 'a changed server must advertise the capability again');
  setup({ delete: {} }, { failure: { code: -32002, message: 'unknown session' } });
  await history.update(row, 'delete');
  setup({ delete: {} }, { failure: { code: -32602, message: 'unverified invalid params' } });
  await assert.rejects(history.update(row, 'delete'), /unverified invalid params/);
  setup({ delete: {} }, { invalidReceipt: true });
  await assert.rejects(history.update(row, 'delete'), /未确认原生会话操作/);
  const previousCount = calls().length;
  await history.prepare({ ...row, piModeId: undefined });
  assert.equal(calls().length, previousCount, 'a legacy row without a recorded preset must never select a new default for history');
  const wrongProfile = acpHistoryStorageKey('gemini', { ...process.env, GEMINI_CLI_HOME: path.join(temp, 'other-profile') });
  await assert.rejects(history.update({ ...row, nativeHistoryStorageKey: wrongProfile }, 'delete'), /另一个历史目录/);
  assert.equal(calls().length, previousCount);
  const qwen = { ...row, piModeId: 'qwen', runtimeResumeToken: '84cb70a7-2463-40d0-bb24-675176bd3564' };
  const qwenHistory = makeHistory();
  setup({ list:{} }, { agentInfo:{ name:'qwen-code',version:'0.28.7' }, result:{success:true} });
  await qwenHistory.prepare(qwen);
  assert.deepEqual(qwenHistory.describe(qwen)?.actions, ['delete']);
  await qwenHistory.update(qwen, 'delete');
  assert.deepEqual(calls().at(-1), { method:'deleteSession', params:{ sessionId:qwen.runtimeResumeToken, cwd:qwen.cwd }, cwd:qwen.cwd });
  setup({ list:{} }, { agentInfo:{ name:'qwen-code',version:'0.28.6' } });
  await assert.rejects(qwenHistory.update(qwen, 'delete'), /未声明此会话历史能力/);
  assert.equal(calls().at(-1).method, 'initialize');
  const kimi = { ...row, piModeId: 'kimi', runtimeResumeToken: 'session_84cb70a7-2463-40d0-bb24-675176bd3564' };
  const agentInfo = { name:'Kimi Code CLI', version:'2.8.1' };
  setup({ delete:{} }, { agentInfo });
  await history.prepare(kimi);
  assert.equal(history.describe(kimi)?.permanentDelete, true);
  const missing = { code:-32602, message:`Invalid params: Unknown sessionId: ${kimi.runtimeResumeToken}`, data:{sessionId:kimi.runtimeResumeToken} };
  setup({ delete:{} }, { agentInfo, failure:missing });
  await history.update(kimi, 'delete');
  setup({ delete:{} }, { agentInfo, failure:{ ...missing, data:{sessionId:'other'} } });
  await assert.rejects(history.update(kimi, 'delete'), /Unknown sessionId/);
  console.log('ACP native history: handshake, explicit actions, scope, receipts and process teardown passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
