import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { codexWorktreeFixture, fixtureGit } from './helpers/codex-worktree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-'));
const compiled = path.join(tmp, 'compiled');
const compile = createSharedCompiler(root, compiled);
const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')).href);
const { forkCodexTurn } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/nativeFork.ts')).href);
const { codexHistoryStorageKey, describeCodexHistory, updateCodexHistory } =
  await import(pathToFileURL(compile('main/agentSession/drivers/codex/nativeHistory.ts')).href);
const { createCodexStreamState, mapCodexReviewEvent } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/streamMap.ts')).href);
const { captureWorkspaceExecutionContext, additionalExecutionDirectories, assertWorkspaceExecutionContextCurrent, pathWritableInContext } =
  await import(pathToFileURL(compile('main/workspaceExecutionContext.ts')).href);
const worker = path.join(tmp, 'worker.mjs');
const transcript = path.join(tmp, 'requests.jsonl');
fs.writeFileSync(worker, `
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
let cwd;
const send = value => console.log(JSON.stringify(value));
const rpc = value => send({type:'app-rpc',value});
send({type:'ready'});
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg=JSON.parse(line);
  if(msg.type==='identity-challenge') return send({type:'identity-response',nonce:msg.nonce});
  if(msg.type==='abort') return process.exit(0);
  if(msg.type==='run-app-server') { cwd = msg.cwd; return; }
  if(msg.type!=='app-rpc') return;
  const q=msg.value;
  fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify(q)+'\\n');
  if(!q.id) return;
  let result={};
  if(q.method==='initialize') result={
    ...(fs.existsSync(${JSON.stringify(path.join(tmp, 'omit-user-agent'))}) ? {} : {userAgent:'Codex Desktop/99.0.0-preview (Windows)'}),
    codexHome:${JSON.stringify(path.join(tmp, 'home'))}
  };
  if(q.method==='thread/start' && fs.existsSync(${JSON.stringify(path.join(tmp, 'native-start-error'))})) {
    return rpc({id:q.id,error:{code:-32602,message:'fixture native thread/start rejected the request'}});
  }
  if(q.method==='permissionProfile/list') result={data:[{id:':workspace',allowed:true}],nextCursor:null};
  if(q.method==='collaborationMode/list') result={data:[{mode:'default',name:'Default'},{mode:'plan',name:'Plan'}]};
  if(q.method==='thread/start' || q.method==='thread/resume') result={thread:{id:'thread-1'},approvalPolicy:'on-request',
    cwd: fs.existsSync(${JSON.stringify(path.join(tmp, 'wrong-cwd'))}) ? ${JSON.stringify(tmp)} : (q.params.cwd ?? cwd),
    approvalsReviewer:'user',activePermissionProfile:{id:fs.existsSync(${JSON.stringify(path.join(tmp, 'bad-policy'))})?':read-only':':workspace'},
    sandbox:{type:'workspaceWrite'}, ...(q.method==='thread/resume'?{collaborationMode:{mode:'default'}}:{})};
  if(q.method==='mcpServerStatus/list') result={data:[{name:'muster',runtimeStatus:'connected',tools:{}}]};
  if(q.method==='thread/turns/list') result={data:q.params.threadId==='attached-continuation'?[]:[{id:'turn-1',status:'completed'}]};
  if(q.method==='thread/read' && q.params.threadId==='attached-continuation') {
    result={thread:{id:'attached-continuation',attachedToThreadId:'staging-thread',forkedFromId:'staging-thread'}};
  }
  if(q.method==='thread/fork') {
    if(q.params.threadId==='archived-original') return rpc({id:q.id,error:{code:-32600,message:'session archived-original is archived.'}});
    result={thread:{id:'fork-1',forkedFromId:q.params.threadId}};
  }
  if(q.method==='thread/delete' && q.params.threadId==='unsupported-delete')
    return rpc({id:q.id,error:{code:-32601,message:'method not found'}});
  if(q.method==='thread/delete' && q.params.threadId==='already-deleted')
    return rpc({id:q.id,error:{code:-32600,message:'no rollout found for thread id already-deleted'}});
  if(q.method==='thread/read' && q.params.threadId==='already-deleted')
    return rpc({id:q.id,error:{code:-32600,message:'thread not loaded: already-deleted'}});
  if(q.method==='thread/read' && ['already-active','still-archived'].includes(q.params.threadId))
    result={thread:{id:q.params.threadId,path:path.join(${JSON.stringify(path.join(tmp, 'home'))},q.params.threadId==='already-active'?'sessions':'archived_sessions','rollout.jsonl')}};
  if(q.method==='thread/unarchive' && ['already-deleted','already-active','still-archived'].includes(q.params.threadId))
    return rpc({id:q.id,error:{code:-32600,message:'no archived rollout found for thread id '+q.params.threadId}});
  if(q.method==='thread/unarchive') result={thread:{id:q.params.threadId==='bad-receipt'?'other':q.params.threadId}};
  if(q.method==='turn/start') {
    if(fs.existsSync(${JSON.stringify(path.join(tmp, 'write-from-turn'))})) {
      execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync('generated.txt', process.cwd())"], {cwd: q.params.cwd ?? cwd});
    }
    result={turn:{id:'turn-1'}};
  }
  rpc({id:q.id,result});
  if(q.method==='turn/start') setTimeout(()=>{
    rpc({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'delegate',type:'collabAgentToolCall',senderThreadId:'thread-1',receiverThreadIds:['child-1']}}});
    rpc({method:'turn/started',params:{threadId:'child-1',turn:{id:'child-turn'}}});
    rpc({method:'item/started',params:{threadId:'child-1',turnId:'old-turn',item:{id:'wrong',type:'fileChange',changes:[{path:'wrong.txt',kind:'update'}]}}});
    rpc({method:'item/started',params:{threadId:'stranger',turnId:'child-turn',item:{id:'wrong',type:'fileChange',changes:[{path:'stranger.txt',kind:'update'}]}}});
    rpc({method:'item/started',params:{threadId:'child-1',turnId:'child-turn',item:{id:'shared-id',type:'fileChange',changes:[]}}});
    rpc({method:'item/fileChange/patchUpdated',params:{threadId:'child-1',turnId:'child-turn',itemId:'shared-id',changes:[{path:'child.txt',kind:{type:'update'},diff:'@@ -1 +1 @@\\n-old\\n+new\\n'}]}});
    rpc({method:'item/completed',params:{threadId:'child-1',turnId:'child-turn',item:{id:'shared-id',type:'fileChange',status:'completed',changes:[]}}});
    rpc({method:'item/completed',params:{threadId:'child-1',turnId:'child-turn',item:{id:'private',type:'agentMessage',text:'CHILD_PRIVATE_TEXT'}}});
    rpc({method:'turn/completed',params:{threadId:'child-1',turn:{id:'child-turn',status:'completed'}}});
    rpc({method:'item/completed',params:{threadId:'child-1',turnId:'child-turn',item:{id:'late',type:'fileChange',changes:[{path:'late.txt',kind:'update'}]}}});
    rpc({method:'thread/tokenUsage/updated',params:{threadId:'other',turnId:'turn-1',tokenUsage:{last:{totalTokens:999},modelContextWindow:1000}}});
    rpc({method:'thread/tokenUsage/updated',params:{threadId:'thread-1',turnId:'old-turn',tokenUsage:{last:{totalTokens:888},modelContextWindow:1000}}});
    rpc({method:'thread/tokenUsage/updated',params:{threadId:'thread-1',turnId:'turn-1',tokenUsage:{last:{totalTokens:123},modelContextWindow:1000}}});
    rpc({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  },20);
});
`);
const host = { cwd: tmp, hostTools: [], getTurnId: () => 'host-turn', getPolicyState: () => ({ mode:'auto', planExecuting:false }), log() {} };
const opts = { executable: process.execPath, env: { ...process.env, CODEX_HOME:path.join(tmp,'home') }, host, nativeSelections: [{id:'permissions',value:':workspace'}, {id:'approvalPolicy',value:'on-request'}, {id:'collaborationMode',value:'default'}], hostMcpConfig:{mcp_servers:{muster:{command:'fixture'}}}, expectedTools:[] };
const limits = { workerPath:worker, jobPath:path.join(root,'src/main/agentSession/drivers/codex/worker/windows-job.ps1') };
const client = createCodexAppServerClient(opts, limits);
const { events } = await client.startThread({workingDirectory:tmp}).runStreamed('hello');
const seen=[];
for await (const event of events) seen.push(event);
const child = seen.filter(event => event.type === 'app.review-only');
assert.equal(child.length, 3, 'only active child file notifications reach review');
const childState = createCodexStreamState();
const review = child.flatMap(value => mapCodexReviewEvent(childState, value.event));
assert.deepEqual(review.map(value => value.type), ['review-tool-start', 'review-tool-update', 'review-tool-result']);
assert.match(review[0].toolCallId, /^child-[0-9a-f]{64}$/);
assert.equal(review[2].reviewChanges[0].path, 'child.txt');
assert.match(review[2].reviewChanges[0].diff, /\+new/);
assert(!JSON.stringify(seen).includes('CHILD_PRIVATE_TEXT'));
assert(!JSON.stringify(seen).includes('wrong.txt'));
assert(!JSON.stringify(seen).includes('stranger.txt'));
assert(!JSON.stringify(seen).includes('late.txt'));
assert.deepEqual(seen.filter(e => e.type === 'app.context-usage').map(e => e.usage), [{tokens:123,contextWindow:1000}]);
const calls = fs.readFileSync(transcript,'utf8').trim().split('\n').map(JSON.parse);
const start = calls.find(q => q.method==='thread/start').params;
const turn = calls.find(q => q.method==='turn/start').params;
assert.equal(start.permissions, ':workspace');
assert.equal(start.approvalPolicy, 'on-request');
assert.equal(start.sandbox, undefined);
assert.equal(turn.sandboxPolicy, undefined);
assert.equal(turn.approvalPolicy, undefined);
assert.ok(calls.some(q => q.method === 'thread/resume'), 'new thread collaboration mode is read from the running thread');
assert.ok(calls.every(q => q.method !== 'thread/settings/update'), 'the observed default is a no-op');
const workerAssets = path.join(compiled, 'main/agentSession/drivers/codex/worker');
fs.mkdirSync(workerAssets, { recursive: true });
fs.copyFileSync(worker, path.join(workerAssets, 'native-worker.mjs'));
fs.copyFileSync(limits.jobPath, path.join(workerAssets, 'windows-job.ps1'));
const fork = await forkCodexTurn({ engine: 'codex', sessionToken: 'thread-1', entryId: 'turn-1', role: 'assistant' }, tmp, opts.executable, opts.env);
assert.deepEqual(fork, { status: 'forked', token: 'fork-1' });
const forkRequest = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse).find(q => q.method === 'thread/fork');
assert.equal(forkRequest.params.lastTurnId, 'turn-1');
const fromInherited = await forkCodexTurn({ engine: 'codex', sessionToken: 'attached-continuation', entryId: 'turn-1', role: 'assistant' },
  tmp, opts.executable, opts.env, 'thread-1');
assert.deepEqual(fromInherited, { status: 'forked', token: 'fork-1' });
const inheritedForkRequest = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse).filter(q => q.method === 'thread/fork').at(-1);
assert.equal(inheritedForkRequest.params.threadId, 'thread-1', 'verify and fork an inherited checkpoint from its recorded Codex thread');
assert.deepEqual(await forkCodexTurn({ engine: 'codex', sessionToken: 'attached-continuation', entryId: 'turn-1', role: 'assistant' },
  tmp, opts.executable, opts.env, 'archived-original'), { status: 'unsupported' });
const nativeRow = { cwd: tmp, runtimeResumeToken: 'attached-continuation', nativeHistoryStorageKey: codexHistoryStorageKey(opts.env),
  codexContinuationHistory: [{ sourceId: 'already-deleted' }, { sourceId: 'fallback-fork', stagingId: 'staging-thread' }] };
assert.deepEqual(describeCodexHistory(nativeRow, opts.env)?.ids, ['already-deleted', 'fallback-fork', 'staging-thread', 'attached-continuation']);
const requestCount = () => fs.readFileSync(transcript, 'utf8').trim().split('\n').length;
const beforeWrongHome = requestCount();
await assert.rejects(updateCodexHistory(nativeRow, 'delete', opts.executable, { ...opts.env, CODEX_HOME: path.join(tmp, 'different-profile') }), /另一个历史目录/);
assert.equal(requestCount(), beforeWrongHome, 'profile mismatch must stop before launching a native request');
await assert.rejects(updateCodexHistory({ ...nativeRow, nativeHistoryStorageKey: undefined }, 'delete', opts.executable,
  { ...opts.env, CODEX_HOME: path.join(tmp, 'different-profile') }), /存储位置不一致/);
assert.equal(fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse).at(-1).method, 'initialize');
await assert.rejects(updateCodexHistory({ cwd: tmp, runtimeResumeToken: 'unsupported-delete' }, 'delete', opts.executable, opts.env), /不支持这项历史操作/);
await assert.rejects(updateCodexHistory({ cwd: tmp, runtimeResumeToken: 'bad-receipt' }, 'unarchive', opts.executable, opts.env), /未确认原生会话操作/);
await updateCodexHistory(nativeRow, 'unarchive', opts.executable, opts.env);
await updateCodexHistory({ cwd: tmp, runtimeResumeToken: 'already-active' }, 'unarchive', opts.executable, opts.env);
await assert.rejects(updateCodexHistory({ cwd: tmp, runtimeResumeToken: 'still-archived' }, 'unarchive', opts.executable, opts.env), /no archived rollout/);
await assert.rejects(updateCodexHistory({ cwd: tmp, runtimeResumeToken: 'already-deleted' }, 'unarchive', opts.executable, opts.env), /thread not loaded/);
await updateCodexHistory(nativeRow, 'delete', opts.executable, opts.env);
const deletedIds = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse)
  .filter(q => q.method === 'thread/delete').slice(-4).map(q => q.params.threadId);
assert.deepEqual(deletedIds, ['attached-continuation', 'staging-thread', 'fallback-fork', 'already-deleted'], 'delete the Codex lineage newest first');
fs.writeFileSync(path.join(tmp, 'omit-user-agent'), '1');
const resumed = client.resumeThread('thread-1', {workingDirectory:tmp});
const next = await resumed.runStreamed('resume');
const resumedEvents=[];
for await (const event of next.events) resumedEvents.push(event);
assert.equal(resumedEvents.find(e => e.type === 'app.context-usage')?.usage.tokens,123);
assert.ok(fs.readFileSync(transcript,'utf8').includes('thread/resume'));

const workspacePath = path.join(tmp, 'projects'); const sharedRepo = path.join(tmp, 'shared');
fs.mkdirSync(sharedRepo);
const source = path.join(workspacePath, '源 repo'); const tree = path.join(tmp, 'isolated checkout');
const row = { ...codexWorktreeFixture(source, tree, 'source', workspacePath), id: 'isolated', runtime: 'codex-gui', workspaceId: 'isolated' };
const config = { workspaces: [{ id: row.workspaceId, path: workspacePath, controlRoot: workspacePath, defaultRootId: 'source',
  roots: [{ id: 'source', path: workspacePath }, { id: 'shared', path: sharedRepo }] }] };
const capture = (overrides = {}) => captureWorkspaceExecutionContext(config, { ...row, ...overrides });
const context = capture();
assert.equal(context.cwd, tree);
assert.equal(row.cwd, source);
assert.equal(capture({ cwd: workspacePath }).cwd, tree, 'an aggregate cwd uses the registered primary checkout');
assert.equal(capture({ cwd: path.join(source, 'src') }).cwd, path.join(tree, 'src'));
assert.equal(capture({ worktreeGroups: { ...row.worktreeGroups, borrowedFrom: 'owner' } }).cwd, tree);
assert.deepEqual(additionalExecutionDirectories(context), [sharedRepo], 'the mapped source cannot be made writable through its parent');
assert.equal(pathWritableInContext('generated.txt', context), true);
assert.equal(pathWritableInContext(path.join(source, 'generated.txt'), context), false);
assert.equal(capture({ runtime: 'pi' }).cwd, source, 'other runtimes keep their source cwd policy');
assert.equal(capture({ cwd: tree, worktreeGroups: undefined }).cwd, tree, 'legacy checkout cwd remains valid');
const untracked = path.join(source, 'untracked'); fs.mkdirSync(untracked);
assert.throws(() => capture({ cwd: untracked }), /Cannot use the isolated Codex working directory/);
const nested = path.join(source, 'nested repo'); fs.mkdirSync(nested);
fixtureGit(nested, 'init', '-q', '-b', 'master');
assert.throws(() => capture({ cwd: nested }), /No isolated worktree maps/);
const nestedTree = path.join(tree, 'nested repo');
const nestedPlacement = codexWorktreeFixture(nested, nestedTree);
const nestedGroup = { ...row.worktreeGroups.groups[0], repos: [{ path: 'nested repo', branch: nestedPlacement.worktreeBranch }] };
assert.equal(capture({ cwd: nested, worktreeGroups: { ...row.worktreeGroups, groups: [nestedGroup] } }).cwd, nestedTree);
const treeSubdir = path.join(tree, 'src');
const relocatedSubdir = path.join(tree, 'relocated-src');
fs.renameSync(treeSubdir, relocatedSubdir);
fs.symlinkSync(path.join(source, 'src'), treeSubdir, 'junction');
assert.throws(() => capture({ cwd: path.join(source, 'src') }), /directory or branch changed/);
fs.unlinkSync(treeSubdir);
fs.renameSync(relocatedSubdir, treeSubdir);
const isolatedClient = createCodexAppServerClient({ ...opts, host: { ...host, cwd: context.cwd, workspaceContext: context } }, limits);
const run = async thread => { for await (const _ of (await thread.runStreamed('test cwd')).events) {} };
const settings = { workingDirectory: context.cwd };
fs.writeFileSync(path.join(tmp, 'write-from-turn'), '1');
for (const [method, thread] of [['thread/start', isolatedClient.startThread(settings)], ['thread/resume', isolatedClient.resumeThread('thread-1', settings)]]) {
  fs.writeFileSync(transcript, '');
  await run(thread);
  const requests = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.find(q => q.method === method).params.cwd, tree);
  assert.equal(requests.find(q => q.method === 'turn/start').params.cwd, tree);
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(tree, 'generated.txt'), 'utf8')), fs.realpathSync(tree));
  assert.equal(fs.existsSync(path.join(source, 'generated.txt')), false);
}
assert.equal(fixtureGit(tree, 'branch', '--show-current'), row.worktreeBranch);
assert.equal(fs.realpathSync(fixtureGit(context.cwd, 'rev-parse', '--show-toplevel')), fs.realpathSync(tree));
assert.equal(fixtureGit(source, 'branch', '--show-current'), 'master');
fs.writeFileSync(transcript, '');
fs.writeFileSync(path.join(tmp, 'wrong-cwd'), '1');
await assert.rejects(run(isolatedClient.resumeThread('thread-1', settings)), /did not confirm the isolated working directory/);
assert.doesNotMatch(fs.readFileSync(transcript, 'utf8'), /"method":"turn\/start"/);
fs.unlinkSync(path.join(tmp, 'wrong-cwd'));
fs.unlinkSync(path.join(tmp, 'write-from-turn'));
fixtureGit(tree, 'switch', '-qc', 'different-branch');
assert.throws(() => assertWorkspaceExecutionContextCurrent(config, context), /branch changed/);
await assert.rejects(run(isolatedClient.resumeThread('thread-1', settings)), /branch changed/);
assert.doesNotMatch(fs.readFileSync(transcript, 'utf8'), /"method":"turn\/start"/);
fs.renameSync(tree, path.join(tmp, 'moved checkout'));
assert.throws(() => capture(), /isolated checkout/);

fs.writeFileSync(path.join(tmp, 'bad-policy'),'1');
const rejected = await client.startThread({workingDirectory:tmp}).runStreamed('reject');
await assert.rejects(async () => { for await (const _ of rejected.events) {} }, /did not confirm/);
fs.writeFileSync(path.join(tmp, 'native-start-error'), '1');
fs.writeFileSync(transcript, '');
const failed = await client.startThread({workingDirectory:tmp}).runStreamed('native error');
await assert.rejects(async () => { for await (const _ of failed.events) {} }, /fixture native thread\/start rejected the request/);
assert.doesNotMatch(fs.readFileSync(transcript, 'utf8'), /"method":"turn\/start"/);
console.log('codex context app-server: ok');
