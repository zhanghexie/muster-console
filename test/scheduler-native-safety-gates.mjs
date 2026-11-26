/** Native Pi hook must bind scheduler lifecycle, including stop/clear while reviewing. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-native-safety-'));
const compile = createSharedCompiler(root, path.join(temp, 'compiled'));
const load = async name => import(pathToFileURL(compile(name)).href);
try {
  const { createSchedulerDirectoryExtension } = await load('main/agent/providers/directoryExtension.ts');
  const { createSafetyService } = await load('main/safety/service.ts');
  const { captureSafetyContext } = await load('main/safety/bindings.ts');
  const { isSchedulerInvocation } = await load('main/agent/agentScope.ts');
  const { captureWorkspaceExecutionContext } = await load('main/workspaceExecutionContext.ts');
  const workspace = { id:'ws', name:'fixture', path:temp, controlRoot:temp, defaultRootId:'root', rootsRevision:1,
    roots:[{ id:'root', path:temp }] };
  const config = { workspaces:[workspace], activeWorkspaceId:'ws' };
  const context = captureWorkspaceExecutionContext(config, { id:'s', workspaceId:'ws', cwd:temp, sourceRoot:{rootId:'root',path:temp,cwd:temp} });
  let models=0, humans=0;
  const ctx = {config:{get:()=>config},safety:{authorize:async()=>{models++;throw Error('unexpected model');}},ui:{confirm:async()=>{humans++;return {confirmed:true};}}};
  let hook;
  createSchedulerDirectoryExtension(ctx,context)({on:(name,callback)=>{if(name==='tool_call') hook=callback;}});
  for (const command of ['npm test','git push origin main','echo a > out']) assert.equal((await hook({toolName:'bash',input:{command}}))?.block,undefined);
  assert.equal(models,0); assert.equal(humans,0);
  assert.equal((await hook({toolName:'write',input:{path:path.join(temp,'..','outside'),content:'x'}})).block,true,'directory hard deny preserved');
  config.workspaces = [];
  assert.equal((await hook({toolName:'bash',input:{command:'pwd'}})).block,true,'stale directory scope preserved');
  console.log('ok scheduler-native-safety-gates');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
