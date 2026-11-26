import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'worker-codex-permission-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { codexWorkerPermissionSnapshot } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/nativeConfig.ts')));
  const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')));
  const selections = [{ id: 'permissions', value: ':workspace' }, { id: 'approvalPolicy', value: 'on-request' }, { id: 'approvalsReviewer', value: 'user' }];
  const source = path.join(temp, 'source');
  const worktree = path.join(temp, 'worktree');
  fs.mkdirSync(source);
  fs.mkdirSync(worktree);
  const policy = cwd => ({ cwd, runtimeWorkspaceRoots: [cwd], activePermissionProfile: { id: ':workspace', extends: null },
    approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
  const approved = codexWorkerPermissionSnapshot(policy(source), source, selections);
  assert.equal(approved, codexWorkerPermissionSnapshot(policy(worktree), worktree, selections));
  assert.throws(() => codexWorkerPermissionSnapshot({ ...policy(worktree), runtimeWorkspaceRoots: [worktree, source] }, worktree, selections), /did not confirm/);
  assert.throws(() => codexWorkerPermissionSnapshot({ ...policy(worktree), sandbox: { type: 'workspaceWrite', writableRoots: [source] } }, worktree, selections), /did not confirm/);
  assert.throws(() => codexWorkerPermissionSnapshot({ ...policy(worktree), activePermissionProfile: { id: ':workspace', extends: ':read-only' } }, worktree, selections), /did not confirm/);
  assert.throws(() => codexWorkerPermissionSnapshot(policy(source), source, selections.slice(0, 2)), /did not confirm/);

  const worker = path.join(temp, 'worker.mjs');
  const home = path.join(temp, 'home');
  const modeFile = path.join(temp, 'mode');
  const transcript = path.join(temp, 'rpc.jsonl');
  fs.writeFileSync(worker, `
import readline from 'node:readline';
import fs from 'node:fs';
const send = value => console.log(JSON.stringify(value));
const rpc = value => send({type:'app-rpc', value});
const policy = ${JSON.stringify(policy(worktree))};
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8');
send({type:'ready'});
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.type === 'identity-challenge') return send({type:'identity-response',nonce:msg.nonce});
  if (msg.type === 'abort') return process.exit(0);
  if (msg.type !== 'app-rpc' || !msg.value.id) return;
  const q = msg.value;
  fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify(q)+'\\n');
  let result = {};
  if (q.method === 'initialize') result = {userAgent:'codex/99.0.0',codexHome:${JSON.stringify(home)}};
  if (q.method === 'permissionProfile/list') result = {data:[{id:':workspace',allowed:true}]};
  if (q.method === 'thread/start' || q.method === 'thread/resume') result = {...policy,thread:{id:'thread'},
    ...(mode === 'roots' ? {runtimeWorkspaceRoots:[policy.cwd, ${JSON.stringify(source)}]} : {}),
    ...(mode === 'resume-changed' ? {sandbox:{...policy.sandbox,networkAccess:true}} : {})};
  if (q.method === 'mcpServerStatus/list') {
    if (mode === 'late-permission') {
      const { runtimeWorkspaceRoots, sandbox, ...settings } = policy;
      rpc({method:'thread/settings/updated',params:{threadId:'thread',threadSettings:{...settings,sandboxPolicy:{...sandbox,networkAccess:true}}}});
    }
    result = {data:[{name:'muster',runtimeStatus:'connected',tools:{}}]};
  }
  if (q.method === 'turn/start') result = {turn:{id:'native-turn'}};
  rpc({id:q.id,result});
  if (q.method === 'turn/start') rpc({method:'turn/completed',params:{threadId:'thread',turn:{id:'native-turn',status:'completed'}}});
});
`);
  const host = { cwd: worktree, hostTools: [], getTurnId: () => 'host-turn', log() {} };
  for (const mode of ['approved', 'roots', 'late-permission', 'revoked', 'resume-valid', 'resume-changed']) {
    fs.writeFileSync(modeFile, mode);
    fs.writeFileSync(transcript, '');
    let checks = 0;
    const client = createCodexAppServerClient({ executable: process.execPath, env: { ...process.env, CODEX_HOME: home }, host,
      hostMcpConfig: { mcp_servers: { muster: { command: 'fixture' } } }, expectedTools: [], nativeSelections: selections,
      workerPermission: { snapshot: approved, assertCurrent() {
        if (++checks === 3 && mode === 'revoked') throw new Error('Worker authorization revoked');
      } } }, { workerPath: worker, jobPath: path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1') });
    const resume = mode.startsWith('resume-');
    const successful = mode === 'approved' || mode === 'resume-valid';
    const thread = resume ? client.resumeThread('thread', { workingDirectory: worktree }) : client.startThread({ workingDirectory: worktree });
    const { events } = await thread.runStreamed('Continue the existing Worker task.');
    const seen = [];
    const drain = async () => { for await (const event of events) seen.push(event.type); };
    if (successful) await drain();
    else await assert.rejects(drain, /Codex .*permissions|Codex did not confirm|authorization revoked/);
    const requests = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const start = requests.find(request => request.method === (resume ? 'thread/resume' : 'thread/start'));
    assert.equal(start.params.permissions, resume ? undefined : ':workspace');
    assert.equal(start.params.approvalPolicy, resume ? undefined : 'on-request');
    assert.equal(start.params.approvalsReviewer, resume ? undefined : 'user');
    assert.equal(requests.filter(request => request.method === 'turn/start').length, successful ? 1 : 0, mode);
    assert.equal(seen.includes('thread.started'), successful, `A rejected ${mode} thread must not publish a resume token`);
    assert.equal(checks, mode === 'roots' || mode === 'resume-changed' ? 2 : 3, mode);
  }
  console.log('Worker Codex permission: native profile, actual cwd, late settings, and revocation verified before turn/start');
} finally {
  removeWorkspaceFixture(temp, 'worker-codex-permission-');
}
