import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'codex-delivery-transport-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')));
  const worker = path.join(temp, 'worker.mjs'), home = path.join(temp, 'home'), modeFile = path.join(temp, 'mode');
  const permissionFile = path.join(temp, 'permissions.json');
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
  const permissionFile = ${JSON.stringify(permissionFile)};
  const permissionFixture = fs.existsSync(permissionFile);
  const permissionState = () => JSON.parse(fs.readFileSync(permissionFile, 'utf8'));
  const settings = () => {
    const state = permissionState();
    return {activePermissionProfile:{id:state.profile},approvalPolicy:state.approval,approvalsReviewer:'user',collaborationMode:{mode:'plan'}};
  };
  if (permissionFixture && q.method === 'thread/settings/update') {
    const state = permissionState();
    if (q.params.permissions) state.profile = q.params.permissions;
    if (q.params.approvalPolicy) state.approval = q.params.approvalPolicy;
    state.updates.push(Object.fromEntries(Object.entries(q.params).filter(([key]) => key !== 'threadId')));
    fs.writeFileSync(permissionFile, JSON.stringify(state));
    rpc({id:q.id,result:{}});
    rpc({method:'thread/settings/updated',params:{threadId:'thread',threadSettings:settings()}});
    return;
  }
  if (q.method === 'turn/start') {
    if (permissionFixture) {
      const state = permissionState();
      state.atSubmission.push([state.profile, state.approval]);
      fs.writeFileSync(permissionFile, JSON.stringify(state));
    }
    rpc({method:'item/completed',params:{threadId:'thread',turnId:'native-turn',item:{type:'mcpToolCall',id:'early',server:'muster',tool:'host_desktop_act',status:'completed',arguments:{},result:{content:[],structuredContent:null,_meta:null},error:null}}});
    rpc({id:q.id,result:{turn:{id:'native-turn'}}});
    const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8');
    if (mode === 'error') rpc({method:'error',params:{threadId:'thread',willRetry:false,error:{message:'fixture failure'}}});
    else rpc({method:'turn/completed',params:{threadId:'thread',turn:{id:'native-turn',status:mode}}});
    return;
  }
  let result = {};
  if (q.method === 'initialize') result = {userAgent:'codex/0.166.0',codexHome:${JSON.stringify(home)}};
  if (q.method === 'permissionProfile/list') result = {data:[{id:':workspace',allowed:true},
    ...(permissionFixture ? [{id:':danger-full-access',allowed:permissionState().allowed}] : [])],nextCursor:null};
  if (permissionFixture && q.method === 'configRequirements/read') result = {requirements:{allowedApprovalPolicies:permissionState().policies}};
  if (q.method === 'thread/start') result = {thread:{id:'thread'},approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}};
  if (permissionFixture && (q.method === 'thread/start' || q.method === 'thread/resume')) result = {thread:{id:'thread'},...settings()};
  if (q.method === 'mcpServerStatus/list') result = {data:[{name:'muster',runtimeStatus:'connected',tools:{}}]};
  rpc({id:q.id,result});
});
`);
  const host = { cwd: temp, hostTools: [], getTurnId: () => 'host-turn',
    getPolicyState: () => ({ mode: 'auto', planExecuting: false }), log() {} };
  for (const mode of ['completed', 'failed', 'error']) {
    fs.writeFileSync(modeFile, mode);
    const order = [];
    let active = false;
    const delivery = {
      begin(host) { active = true; order.push(`begin:${host}`); },
      bind(host, thread, turn) { order.push(`bind:${host}:${thread}:${turn}`); },
      async observe(host, event) {
        order.push(`observe:${host}:${event.params.item.id}`);
        await new Promise(resolve => setTimeout(resolve, 40));
        order.push('observed');
      },
      end(host) { if (active) { active = false; order.push(`end:${host}`); } }
    };
    const client = createCodexAppServerClient({ executable: process.execPath, env: { ...process.env, CODEX_HOME: home }, host,
      hostMcpConfig: { mcp_servers: { muster: { command: 'fixture' } } }, expectedTools: [], desktopDelivery: delivery },
      { workerPath: worker, jobPath: path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1') });
    const { events } = await client.startThread({ workingDirectory: temp }).runStreamed('fixture');
    for await (const event of events) if (['turn.completed', 'turn.failed', 'error'].includes(event.type)) order.push('terminal');
    assert.deepEqual(order, ['begin:host-turn', 'bind:host-turn:thread:native-turn', 'observe:host-turn:early', 'observed', 'end:host-turn', 'terminal'],
      `${mode}: early native events must finish acknowledgement and invalidate the slot before the terminal event`);
  }
  let manual = false;
  let journal;
  const permissionHost = { ...host, getAutomaticPermissions: () => !manual,
    getNativePermissionRestore: () => journal,
    async onNativePermissionRestore(selections) { journal = selections; } };
  const session = { profile: ':workspace', approval: 'on-request', allowed: true, policies: ['on-request', 'never'],
    updates: [], atSubmission: [] };
  fs.writeFileSync(permissionFile, JSON.stringify(session));
  fs.writeFileSync(modeFile, 'completed');
  const runPermissionTurn = async resume => {
    const client = createCodexAppServerClient({ executable: process.execPath, env: { ...process.env, CODEX_HOME: home }, host: permissionHost,
      hostMcpConfig: { mcp_servers: { muster: { command: 'fixture' } } }, expectedTools: [] },
      { workerPath: worker, jobPath: path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1') });
    const thread = resume ? client.resumeThread('thread', { workingDirectory: temp }) : client.startThread({ workingDirectory: temp });
    const { events } = await thread.runStreamed('fixture');
    for await (const event of events) assert.ok(event.type !== 'error', JSON.stringify(event));
  };
  await runPermissionTurn(false);
  assert.deepEqual(journal, [{ id: 'permissions', value: ':workspace' }, { id: 'approvalPolicy', value: 'on-request' }]);
  manual = true;
  await runPermissionTurn(true);
  assert.equal(journal, undefined);
  let state = JSON.parse(fs.readFileSync(permissionFile));
  assert.deepEqual(state.atSubmission, [[':danger-full-access', 'never'], [':workspace', 'on-request']]);
  assert.deepEqual(state.updates, [{ permissions: ':danger-full-access' }, { approvalPolicy: 'never' },
    { permissions: ':workspace' }, { approvalPolicy: 'on-request' }], 'use native IDs and leave collaboration mode untouched');
  manual = false;
  state.allowed = false;
  state.policies = ['on-request'];
  fs.writeFileSync(permissionFile, JSON.stringify(state));
  await runPermissionTurn(true);
  state = JSON.parse(fs.readFileSync(permissionFile));
  assert.deepEqual(state.atSubmission.at(-1), [':workspace', 'on-request']);
  assert.equal(state.updates.length, 4, 'no unsupported changes when the native catalog disables higher permissions');
  console.log('Codex app-server delivery transport: early event and completion ordering passed');
} finally { removeWorkspaceFixture(temp, 'codex-delivery-transport-'); }
