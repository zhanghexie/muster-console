import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-safety-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const entryPath = compile('main/agentSession/host/approvals.ts');
  fs.writeFileSync(path.join(tmp, 'main/agentSession/host/base.mjs'), 'export const applySignal=()=>{}; export const persistEntry=()=>{}; export const syncEntry=()=>{}; export const getDriver=()=>undefined; export const push=()=>{}; export const log=()=>{}; export const applyInjectQueueChange=()=>{}; export const cancelStreamingPersist=()=>{};');
  fs.writeFileSync(path.join(tmp, 'main/agentSession/tools/catalogHostTools.mjs'), "export const CATALOG_HOST_TOOL_IDS=['browser.run'];");
  fs.mkdirSync(path.join(tmp, 'main/safety'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'main/safety/bindings.mjs'), 'export const authorizeSafetyOperation=(ctx,input)=>ctx.authorize(input);');
  const { decideToolCallPermission } = await import(pathToFileURL(compile('main/agentSession/tools/policy.ts')).href);
  const autoPolicy = command => decideToolCallPermission({ mode:'auto', planExecuting:false, engineToolName:'bash', input:{command}, cwd:tmp, hostToolIds:[], hostClassOf:()=> 'shell', userRules:[] });
  assert.equal(autoPolicy('git push origin main').decision,'auto');
  assert.equal(autoPolicy('npm test && echo done').decision,'auto');
  const { handleApprovalRequest, respondApproval } = await import(pathToFileURL(entryPath).href);
  let reviews = 0;
  const entry = { sessionId:'s', workspaceId:'ws', runtimeId:'pi', cwd:tmp, mode:'default', planExecuting:false, planAllowedPrompts:[],
    messages:[], activeApproval:null, assistant:{parts:[]}, toolset:{hostTools:[],hostClassOf:()=> 'shell'}, activeTurnStartedAt:1 };
  const host = { entries:new Map([['s',entry]]), subagentApprovals:new Map(), ctx:{sessions:{get:()=>({configurePermissions:true})},authorize:async()=>{reviews++;throw Error('unexpected model');}} };
  for (const command of ['git push origin main','npm test','echo a > output']) {
    assert.equal((await handleApprovalRequest(host,entry,{toolName:'bash',toolCallId:command,input:{command}})).approved,true);
    assert.equal(entry.activeApproval,null);
  }
  assert.equal(reviews,0,'ordinary shell never invokes approval model or human card');
  entry.mode='ask';
  assert.equal((await handleApprovalRequest(host,entry,{toolName:'bash',toolCallId:'deny',input:{command:'npm install'}})).approved,false);
  entry.mode='default';
  const pending=handleApprovalRequest(host,entry,{toolName:'write',toolCallId:'outside',input:{path:path.join(tmp,'..','outside'),content:'x'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(entry.activeApproval,'directory permission remains human controlled');
  respondApproval(host,'s',entry.activeApproval.approvalId,false);
  assert.equal((await pending).approved,false);
  assert.equal(reviews,0);
  console.log('ok gui-worker-safety-gates');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
