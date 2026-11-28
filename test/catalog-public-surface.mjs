/** Native names, removed aliases, real handler side effects and role boundaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { EventEmitter } from 'node:events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-public-'));
const compile = createSharedCompiler(root, tmp);
const load = (file) => import(pathToFileURL(compile(file)).href);
try {
  // sessionsHost now reaches delegate.ts, which imports Electron before the
  // terminal capture section. All compiled modules must see the same stub.
  const electronDir=path.join(tmp,'node_modules','electron');fs.mkdirSync(electronDir,{recursive:true});
  fs.writeFileSync(path.join(electronDir,'package.json'),JSON.stringify({type:'module',main:'index.js'}));
  fs.writeFileSync(path.join(electronDir,'index.js'),`import {EventEmitter} from 'node:events';export const ipcMain=new EventEmitter();export const app={getPath:()=>${JSON.stringify(tmp)}};export const shell={};export const webContents={};`);
  const {ipcMain}=await import(pathToFileURL(path.join(electronDir,'index.js')).href);
  const c = await load('main/capabilities/catalog.ts');
  const { resolveTurnHiddenTools, isToolDefHidden } = await load('shared/turnVisibility.ts');
  const defs = c.TOOL_DEFS;
  const visible = defs.filter(d => !d.schedulerHidden);
  assert.equal(new Set(defs.map(d=>d.name)).size,defs.length);
  for (const name of ['sessions.closeBatch','sessions.resumeInterrupted','sessions.markProcessed','sessions.outbox','sessions.bulkArchive','tasks.query','pipeline.status','services.list','services.createScheduled','services.update','services.enable','services.disable','services.delete','services.runNow','tools.defineTool','tools.updateTool','tools.removeTool','tools.listDynamicTools','llm.setActive','terminal.focus','chat.refresh']) {
    assert.equal(c.getToolDef(name),undefined,name+' removed');
    assert.ok(!c.isWorkerAllowedTool(name));
    assert.ok(!c.isExtensionHostTool(name));
  }
  for(const name of ['sessions.requestIntegrate']) assert.ok(c.getToolDef(name).schedulerHidden);
  const hidden = resolveTurnHiddenTools('prompt-task');
  for(const name of ['automations.create','automations.setEnabled','sessions.delete','sessions.recoverInterrupted','sessions.setArchived','sessions.interrupt','sessions.restartConversation']) assert.equal(isToolDefHidden(c.getToolDef(name),hidden),true,name);
  const info=c.getCatalogInfo();
  assert.equal(info.tools.find(d=>d.name==='host.mail.read').workerVisible,true);
  assert.ok(info.tools.every(d => d.name.startsWith('host.') || d.name.startsWith('ext.')), 'settings catalog exposes only public names');
  assert.equal(info.tools.some(d => d.name === 'sessions.readMessages'), false);
  assert.ok(c.isExtensionHostTool('host.sessions.select'));
  assert.ok(c.isWorkerAllowedTool('sessions.create'));
  assert.equal(c.getToolDef('tasks.get'),undefined);
  assert.deepEqual(c.getToolDef('sessions.setArchived').parameters.required,['sessionIds','archived']);
  assert.equal(c.getToolDef('sessions.create').parameters.properties.isolate,undefined);
  assert.equal(c.getToolDef('automations.update').parameters.properties.serviceId,undefined);
  const { assertToolArguments } = await load('main/capabilities/schemaValidation.ts');
  for (const [name, base] of [['automations.create', {name:'x', runtime:'pi', prompt:'x'}], ['automations.update', {automationId:'a'}]]) {
    const schema = c.getToolDef(name).parameters;
    assertToolArguments(schema, base, name);
    for (const trigger of [{kind:'time'}, {kind:'webhook', provider:'gitlab', projectId:6528}, {kind:'file'}, {kind:'phase'}]) {
      assert.throws(() => assertToolArguments(schema, {...base, trigger}, name), /Invalid parameters/);
    }
  }
  const { AUTOMATIONS_RUN_DOMAIN } = await load('main/capabilities/catalog/runTools.ts');
  const { resolveRunToolCall } = await load('main/capabilities/catalog/runFactory.ts');
  assert.throws(() => resolveRunToolCall(AUTOMATIONS_RUN_DOMAIN, { action: 'create', params: {
    name: 'x', prompt: 'x', runtime: 'pi', trigger: { kind: 'webhook', provider: 'gitlab', projectId: 6528 }
  } }), /Invalid parameters/);
  assert.equal(resolveRunToolCall(AUTOMATIONS_RUN_DOMAIN, { action: 'create', params: {
    name: 'x', prompt: 'x', runtime: 'pi', delayMinutes: 5
  } }).targetTool, 'automations.create');
  assert.ok(!('aliases' in info.tools[0]));
  assert.notEqual(c.catalogSnippetFor(c.getToolDef('sessions.select')),c.catalogSnippetFor(c.getToolDef('sessions.review')));

  const { sessionsHost } = await load('main/capabilities/hosts/sessions.ts');
  for (const args of [undefined,{}, {sessionIds:[]}, {sessionIds:[' ']}]) assert.throws(()=>sessionsHost['sessions.completeAndArchive']({},args),/Explicit/);
  const changes=[];
  const sessions=[{id:'s1',type:'terminal',name:'first',phase:{value:'needs_you'}},{id:'s2',type:'terminal',name:'second',phase:{value:'needs_you'}}];
  const ctx={resolveBubbleWorkspaceId:()=> 'ws',sessions:{
    listForAgent:()=>({sessions}),
    resolveSessionRef:({sessionId})=>{if(sessionId==='bad')throw Error('missing');return {id:sessionId};},
    get:(id)=>sessions.find(s=>s.id===id),
    setArchived:(id,value)=>{changes.push([id,value]);return {id,archived:value};},
    restoreArchived:async id=>{changes.push([id,false]);return {id,archived:false};},
    markProcessed:(id)=>changes.push([id,'processed'])
  }};
  sessionsHost['sessions.completeAndArchive'](ctx,{sessionIds:['s1']});
  assert.deepEqual(changes,[['s1','processed']],'only explicit target completed');
  changes.length=0;
  const archived=await sessionsHost['sessions.setArchived'](ctx,{sessionIds:['s1','bad','s2'],archived:false});
  assert.deepEqual(changes,[['s1',false],['s2',false]]);
  assert.equal(archived.failed.length,1);
  await assert.rejects(sessionsHost['sessions.setArchived'](ctx,{sessionIds:[],archived:true}),/non-empty/);
  await assert.rejects(sessionsHost['sessions.setArchived'](ctx,{sessionId:'s1',archived:true}),/non-empty/);

  // The handler requires a concrete choice; dirty status cannot override it.
  const created=[];
  const createCtx={...ctx,config:{get:()=>({defaultRuntime:'pi',workspaces:[{id:'ws',path:root}],workspace:root})},
    git:{resolveMainRepoFor:async()=>root,probeDirty:async()=>true},sessions:{...ctx.sessions, isChatRuntime: id=>id==='pi',
      listByWorkspace:()=>[{id:'active',type:'terminal',lifecycle:'working',cwd:root}],
      createTerminal:async(input)=>{created.push(input);return {id:'new'};}
    }};
  const { sourceRootsFor } = await load('main/workspacePaths.ts');
  const rootId = sourceRootsFor(createCtx.config.get().workspaces[0])[0].id;
  await sessionsHost['sessions.create'](createCtx,{isolation:'shared'});
  await sessionsHost['sessions.create'](createCtx,{isolation:'isolated',isolationGroups:[{rootId,relativePath:'',repoSet:[]}]});
  assert.deepEqual(created.map(s=>s.isolate),[false,true]);
  for (const isolation of [undefined,'auto','false']) await assert.rejects(()=>sessionsHost['sessions.create'](createCtx,{isolation}),/isolation must be explicitly/);
  assert.equal(created.length,2,'invalid or missing isolation must not create a session');
  createCtx.git.probeDirty=async()=>false;
  await sessionsHost['sessions.create'](createCtx,{isolation:'isolated',isolationGroups:[{rootId,relativePath:'',repoSet:[]}]});
  assert.equal(created.at(-1).isolate,true,'a clean repo still respects explicit isolation');
  createCtx.git.probeDirty=async()=>null;
  await sessionsHost['sessions.create'](createCtx,{isolation:'shared'});
  assert.equal(created.at(-1).isolate,false,'unknown dirty status does not override an explicit shared choice');

  createCtx.config.get=()=>({defaultRuntime:'codex',workspaces:[{id:'ws',path:root}],workspace:root});
  await sessionsHost['sessions.create'](createCtx,{isolation:'shared'});
  assert.equal(created.at(-1).runtime,'pi','empty agent session does not default to a configured CLI');
  await sessionsHost['sessions.create'](createCtx,{isolation:'shared',runtime:'codex'});
  assert.equal(created.at(-1).runtime,'codex','explicit CLI runtime is preserved');
  const createTerminal = createCtx.sessions.createTerminal;
  const rejected = [];
  createCtx.sessions.createTerminal=async input=>{rejected.push(input.runtime);throw new Error('GUI disabled');};
  await assert.rejects(()=>sessionsHost['sessions.create'](createCtx,{isolation:'shared'}),/GUI disabled/);
  assert.deepEqual(rejected,['pi'],'an unavailable GUI does not trigger a fallback to the configured CLI');
  createCtx.sessions.createTerminal=createTerminal;

  for (const profile of ['powershell','bash','zsh']) {
    await sessionsHost['terminal.create'](createCtx,{shellProfileId:profile,rootId,cwd:root,select:false});
    assert.equal(created.at(-1).shellProfileId,profile);
    assert.equal(created.at(-1).isolate,false);
    assert.equal(created.at(-1).activate,false);
    assert.equal(created.at(-1).runtime,undefined);
  }
  const beforeInvalidShell=created.length;
  await assert.rejects(()=>sessionsHost['terminal.create'](createCtx,{shellProfileId:'bash',task:'agent work'}),/Agent options/);
  await assert.rejects(()=>sessionsHost['terminal.create'](createCtx,{}),/shellProfileId/);
  assert.equal(created.length,beforeInvalidShell);

  const {servicesHost}=await load('main/capabilities/hosts/services.ts');
  const writes=[];
  const automationCtx={...ctx,runtimes:{get:()=>({enabled:true})},tasks:{
    get:()=>({id:'a',trigger:{kind:'time'}}),
    create:(input)=>{writes.push(input);return input;},
    update:(id,input)=>{writes.push([id,input]);return input;}
  }};
  await servicesHost['automations.create'](automationCtx,{name:'Task',runtime:'pi',prompt:'Work',delayMinutes:5,model:{providerId:'p',modelId:'m'}});
  assert.equal(writes[0].providerId,'p');
  assert.equal(writes[0].modelId,'m');
  await servicesHost['automations.update'](automationCtx,{automationId:'a',model:{providerId:'p2',modelId:'m2'}});
  assert.deepEqual(writes[1],['a',{providerId:'p2',modelId:'m2'}]);
  await assert.rejects(()=>servicesHost['automations.update'](automationCtx,{automationId:'a',model:{providerId:'p'}}),/model requires/);
  assert.equal(writes.length,2,'partial model must not change the automation');

  const {chatHost}=await load('main/capabilities/hosts/chat.ts');
  const actions=[];
  const chatCtx={...ctx,sessions:{...ctx.sessions,isChatRuntime:()=>true,refreshFresh:async()=>actions.push('restart'),
    captureManagedInterruptSnapshot:async id=>{actions.push(['capture',id]);return {}; }},
    agentSessions:{entries:new Map(),abort:async(id)=>actions.push(['abort',id])},pty:{write:(id,text)=>{actions.push([id,text]);return true;}}};
  await chatHost['sessions.interrupt'](chatCtx,{sessionId:'s1'});
  assert.deepEqual(actions,[['capture','s1'],['abort','s1']]);
  await assert.rejects(()=>chatHost['sessions.restartConversation'](chatCtx,{sessionId:'s1'}),/GUI/);
  assert.equal(actions.length,2,'unsupported restart must not interrupt GUI');
  chatCtx.sessions.isChatRuntime=()=>false;
  const signal=await chatHost['sessions.interrupt'](chatCtx,{sessionId:'s1'});
  assert.equal(signal.interruptRequested,true);
  assert.deepEqual(actions.at(-1),['s1','\x03']);
  await chatHost['sessions.restartConversation'](chatCtx,{sessionId:'s1'});
  assert.equal(actions.at(-1),'restart');

  // Exercise the actual capture handler with a renderer reply.
  const {terminalHost}=await load('main/capabilities/hosts/terminal.ts');
  const win=Object.assign(new EventEmitter(), { isDestroyed:()=>false });
  win.webContents=Object.assign(new EventEmitter(), { isDestroyed:()=>false, send:(_channel,{requestId})=>queueMicrotask(()=>ipcMain.emit(`terminal:capture:${requestId}`,{}, {ok:true,dataUrl:'data:image/png;base64,aGVsbG8='})) });
  const captureCtx={...ctx,pty:{getBuffer:()=> 'output',getOutputCursor:()=> 'fixture-cursor'},getWindow:()=>win};
  const local=await terminalHost['terminal.capture'](captureCtx,{sessionId:'s1'});
  assert.ok(local.previewPath);assert.equal(local.imageCaptured,true);assert.equal(local.textTail,'output');
  console.log(`catalog-public-surface: ok (${visible.length} scheduler tools)`);
} finally {
  assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('catalog-public-'));
  fs.rmSync(tmp,{recursive:true,force:true});
}
