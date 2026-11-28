import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-native-history-')));
const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
const { probeOpenCodeHistory, updateOpenCodeHistory } =
  await import(pathToFileURL(compile('main/agentSession/drivers/acp/opencodeHistory.ts')).href);
const { ZCodeNativeHistory } =
  await import(pathToFileURL(compile('main/agentSession/drivers/zcode/nativeHistory.ts')).href);
const { AcpNativeHistory } =
  await import(pathToFileURL(compile('main/agentSession/drivers/acp/nativeHistory.ts')).href);
const { wrapCmdShimIfNeeded } =
  await import(pathToFileURL(compile('main/agentSession/drivers/acp/agents.ts')).href);

const state = path.join(temp, 'opencode.json');
const testId = 'ses_fixture';
fs.writeFileSync(path.join(temp, 'serve'), `
const fs = require('node:fs');
const http = require('node:http');
const state = ${JSON.stringify(state)};
const id = ${JSON.stringify(testId)};
const server = http.createServer(async (req,res) => {
  const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
  if (req.headers.authorization !== auth) { res.writeHead(401).end('{}'); return; }
  if (req.url === '/api/info') { res.end('{"version":"2.2.6","urls":[]}'); return; }
  const data = JSON.parse(fs.readFileSync(state, 'utf8'));
  const url = new URL(req.url,'http://localhost');
  if (url.pathname === '/api/session') {
    const cursor = url.searchParams.get('cursor');
    const parentID = cursor || url.searchParams.get('parentID');
    const children = data.children?.[parentID] ?? [];
    const page = cursor ? children.slice(1) : children.slice(0,1);
    res.end(JSON.stringify({data:page.map(id=>({id,parentID})),cursor:!cursor&&children.length>1?{next:parentID}:{}}));
    return;
  }
  if (req.url !== '/api/session/' + id) { res.writeHead(500).end('{}'); return; }
  if (data.removed) { res.writeHead(404).end('{"_tag":"SessionNotFoundError"}'); return; }
  if (req.method === 'GET') {
    res.end(JSON.stringify({data:{id:data.wrongId ? 'unrelated' : id,time:data.archived ? {archived:1} : {}}}));
  } else if (req.method === 'PATCH') {
    const body = JSON.parse(await new Promise(resolve=>{let source='';req.on('data',chunk=>source+=chunk);req.on('end',()=>resolve(source));}));
    if (!data.ignoreUpdate) fs.writeFileSync(state, JSON.stringify({...data, archived:body.archived}));
    res.writeHead(204).end();
  } else if (req.method === 'DELETE') {
    fs.writeFileSync(state, JSON.stringify({...data,removed:true})); res.writeHead(204).end();
  } else res.writeHead(500).end('{}');
});
server.listen(0,'127.0.0.1',()=>console.log('server listening on http://127.0.0.1:'+server.address().port));
`);
const openCode = { executable: process.execPath, cwd: temp, env: process.env };
const save = value => fs.writeFileSync(state, JSON.stringify(value));
const load = () => JSON.parse(fs.readFileSync(state, 'utf8'));

const grokState = path.join(temp, 'grok.json');
const grokScript = path.join(temp, 'grok.mjs');
const grokExecutable = path.join(temp, process.platform === 'win32' ? 'grok.cmd' : 'grok');
const grokId = '01a22250-2944-7401-af25-a28dc21598f1';
fs.writeFileSync(grokScript, `
import fs from 'node:fs';
import readline from 'node:readline';
const [flag, domain, operation, target] = process.argv.slice(2);
const state = ${JSON.stringify(grokState)};
const id = ${JSON.stringify(grokId)};
if (domain === 'agent') {
  readline.createInterface({input:process.stdin}).on('line', line=>{
    const {id, method}=JSON.parse(line);
    if(method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{}}}}}));
  });
} else if (flag === '--no-auto-update' && domain === 'sessions' && operation === 'delete') {
  if (target === '--help') console.log('Usage: grok sessions delete [OPTIONS] <ID>');
  else if (target === id) {
    const {status}=JSON.parse(fs.readFileSync(state,'utf8'));
    if (status==='present') { fs.writeFileSync(state, '{"status":"deleted"}'); console.log('Deleted session '+id); }
    else if (status==='deleted') console.log("Session '"+id+"' not found.");
    else if (status==='unconfirmed') console.log('Deleted session unrelated');
    else { console.log('Deleted session '+id); process.exitCode=1; }
  }
}
`);
if (process.platform === 'win32') fs.writeFileSync(grokExecutable, `@"${process.execPath}" "${grokScript}" %*\r\n`);
else {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(grokExecutable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(grokScript)} "$@"\n`, { mode:0o755 });
}

try {
  save({ archived:false });
  assert.equal(await probeOpenCodeHistory(openCode), true);
  await updateOpenCodeHistory(openCode, testId, 'archive');
  assert.equal(load().archived, true);
  await updateOpenCodeHistory(openCode, testId, 'unarchive');
  assert.equal(load().archived, false);
  save({ archived:false, ignoreUpdate:true });
  await assert.rejects(updateOpenCodeHistory(openCode, testId, 'archive'), /未确认关联的原生会话状态/);
  save({ archived:false, wrongId:true });
  await assert.rejects(updateOpenCodeHistory(openCode, testId, 'delete'), /未确认关联的原生会话状态/);
  assert.equal(load().removed, undefined);
  save({ archived:true, children:{ [testId]:['ses_first','ses_second'], ses_second:['ses_grandchild'] } });
  await assert.rejects(updateOpenCodeHistory(openCode, testId, 'delete', new Set(['ses_grandchild'])), /另一条集序会话/);
  assert.equal(load().removed, undefined);
  await updateOpenCodeHistory(openCode, testId, 'delete', new Set(['ses_unrelated']));
  await updateOpenCodeHistory(openCode, testId, 'delete');
  assert.equal(load().removed, true);

  let nativeExists = true, foreignWorkspace = false, staleAck = false, versionSupported = true, reclaimed = 0;
  const requests = [];
  const zcodeId = 'sess_123';
  const zcode = new ZCodeNativeHistory(() => process.execPath, () => {
    const rpc = new EventEmitter();
    rpc.request = async (method, params) => {
      requests.push({ method, params });
      if (method === 'runtime/capabilities') return { historyFirst:versionSupported };
      if (method === 'session/list') {
        assert.deepEqual(params.sessionIds, [zcodeId]);
        if (params.workspace) assert.equal(params.workspace.workspacePath, temp);
        return { sessions:nativeExists && !(foreignWorkspace && params.workspace) ? [{ sessionId:zcodeId }] : [] };
      }
      assert.equal(method, 'v4/command');
      assert.equal(params.type, 'deleteSession');
      assert.equal(params.sessionId, zcodeId);
      assert.equal(typeof params.issuedAt, 'number');
      if (!staleAck) nativeExists = false;
      return { commandId:params.commandId, status:'accepted' };
    };
    return { rpc, waitReady:async()=>{}, close:async()=>{ reclaimed++; } };
  });
  const row = { runtimeResumeToken:zcodeId, cwd:temp };
  await zcode.prepare(row, 'archive');
  assert.equal(requests.length, 0);
  await zcode.prepare(row, 'delete');
  assert.deepEqual(zcode.describe(row)?.actions, ['delete']);
  assert.equal(zcode.describe(row)?.permanentDelete, undefined);
  foreignWorkspace = true;
  await assert.rejects(zcode.update(row, 'delete'), /属于另一个工作目录/);
  assert.ok(nativeExists);
  foreignWorkspace = false;
  staleAck = true;
  await assert.rejects(zcode.update(row, 'delete'), /未确认原生会话操作/);
  assert.ok(nativeExists);
  staleAck = false;
  await zcode.update(row, 'delete');
  assert.equal(nativeExists, false);
  await zcode.update(row, 'delete');
  versionSupported = false;
  await assert.rejects(zcode.update(row, 'delete'), /未声明此会话历史能力/);
  assert.equal(reclaimed, 6);

  const grok = new AcpNativeHistory({ label: () => 'Grok Build', resolve: () => wrapCmdShimIfNeeded(grokExecutable, ['--no-auto-update','agent','stdio']) });
  const grokRow = { piModeId:'grok', cwd:temp, runtimeResumeToken:grokId };
  const saveGrok = status => fs.writeFileSync(grokState, JSON.stringify({ status }));
  await grok.prepare(grokRow, 'archive');
  assert.deepEqual(grok.describe(grokRow)?.actions, []);
  await grok.prepare(grokRow, 'delete');
  assert.deepEqual(grok.describe(grokRow)?.actions, ['delete']);
  assert.equal(grok.describe(grokRow)?.permanentDelete, true);
  saveGrok('unconfirmed');
  await assert.rejects(grok.update(grokRow,'delete'), /未确认原生会话操作/);
  saveGrok('nonzero');
  await assert.rejects(grok.update(grokRow,'delete'), /未确认原生会话操作/);
  saveGrok('present');
  await grok.update(grokRow,'delete');
  await grok.update(grokRow,'delete');
  assert.equal(JSON.parse(fs.readFileSync(grokState,'utf8')).status,'deleted');
  assert.deepEqual(grok.describe({...grokRow,runtimeResumeToken:'partial'})?.actions, []);
  console.log('Native history: OpenCode v2, ZCode v4 and Grok CLI scoped operations passed');
} finally {
  fs.rmSync(temp, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
}
