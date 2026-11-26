import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'codex-delivery-failure-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')));
  const worker = path.join(temp, 'worker.mjs'), home = path.join(temp, 'home'), marker = path.join(temp, 'send-exit');
  fs.writeFileSync(worker, `
import readline from 'node:readline';
import fs from 'node:fs';
const send = value => console.log(JSON.stringify(value));
const rpc = value => send({type:'app-rpc', value});
send({type:'ready'});
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.type === 'identity-challenge') return send({type:'identity-response',nonce:msg.nonce});
  if (msg.type === 'abort') return process.exit(0);
  if (msg.type !== 'app-rpc' || !msg.value.id) return;
  const q = msg.value;
  let result = {};
  if (q.method === 'initialize') result = {userAgent:'codex/0.166.0',codexHome:${JSON.stringify(home)}};
  if (q.method === 'permissionProfile/list') result = {data:[{id:':workspace',allowed:true}],nextCursor:null};
  if (q.method === 'thread/start') result = {thread:{id:'thread'},approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}};
  if (q.method === 'mcpServerStatus/list') result = {data:[{name:'muster',runtimeStatus:'connected',tools:{}}]};
  if (q.method === 'turn/start') result = {turn:{id:'native-turn'}};
  rpc({id:q.id,result});
  if (q.method === 'turn/start') {
    setTimeout(() => rpc({method:'item/completed',params:{threadId:'thread',turnId:'native-turn',item:{type:'mcpToolCall',id:'pending',server:'muster',tool:'host_probe',status:'completed',arguments:{},result:{content:[],structuredContent:null,_meta:null},error:null}}}), 20);
    if (fs.existsSync(${JSON.stringify(marker)})) setTimeout(() => send({type:'app-exit',code:1}), 100);
  }
});
`);
  const host = { cwd: temp, hostTools: [], getTurnId: () => 'host-turn',
    getPolicyState: () => ({ mode: 'auto', planExecuting: false }), log() {} };
  for (const scenario of ['exit', 'timeout']) {
    if (scenario === 'exit') fs.writeFileSync(marker, '1'); else fs.unlinkSync(marker);
    let enter, release, didEnd;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const ended = new Promise(resolve => { didEnd = resolve; });
    let invalidated = false, acknowledged = false;
    const delivery = { begin() {}, bind() {},
      async observe() { enter(); await gate; if (!invalidated) acknowledged = true; },
      end() { invalidated = true; didEnd(); } };
    const client = createCodexAppServerClient({ executable: process.execPath, env: { ...process.env, CODEX_HOME: home }, host,
      hostMcpConfig: { mcp_servers: { muster: { command: 'fixture' } } }, expectedTools: [], desktopDelivery: delivery },
      { workerPath: worker, jobPath: path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1') });
    const { events } = await client.startThread({ workingDirectory: temp }).runStreamed('fixture');
    const iterator = events[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, 'thread.started');
    assert.equal((await iterator.next()).value.type, 'turn.started');
    await entered;
    // Deliberately stop consuming: failure must invalidate delivery before the
    // async generator reaches its finally block.
    let timer;
    await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${scenario} did not invalidate delivery`)), 8000); })]);
    clearTimeout(timer);
    release();
    assert.equal(invalidated, true);
    assert.equal(acknowledged, false);
    await assert.rejects(async () => { for (;;) { const next = await iterator.next(); if (next.done) break; } },
      scenario === 'exit' ? /退出/ : /超时|timeout/i);
  }
  console.log('Codex delivery failure: queued process exit and timeout invalidate before a stalled consumer resumes');
} finally { removeWorkspaceFixture(temp, 'codex-delivery-failure-'); }
