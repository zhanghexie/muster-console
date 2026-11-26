// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AppContext} from '../../../src/main/context';
import type {ChatMessage} from '../../../src/shared/types';
const env=vi.hoisted(()=>({root:''}));
vi.mock('electron',()=>({app:{getPath:()=>env.root}}));
vi.mock('../../../src/main/agent/piConfigSync',async importOriginal=>({...await importOriginal<typeof import('../../../src/main/agent/piConfigSync')>(),syncPiConfigFromApp:()=>{},getConfiguredPiThinkingLevels:()=>['low','high']}));
import {Orchestrator} from '../../../src/main/agent/orchestrator';
import {SchedulerSessionAdapter} from '../../../src/main/runtimeKernel/schedulerSession';
import {schedulerSqlitePath} from '../../../src/main/runtimeKernel/schedulerSqlite';
import {observeScheduler} from '../../../src/main/agent/orchestrator/observation';
import {getWorkspacePromptScope} from '../../../src/main/agent/orchestrator/contextStatus';
vi.stubGlobal('window',globalThis);
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

function fixture(){
  env.root=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-cold-browse-'));roots.push(env.root);
  const saved={modes:{first:'ask',second:'default'},models:{first:{providerId:'workspace',modelId:'workspace-model'}},thinkings:{first:'high'}};
  const config={mcp:{enabled:false,servers:[]},activeWorkspaceId:'first',workspaces:['first','second'].map(id=>({id,name:id,path:env.root})),llm:{activeProviderId:'global',activeModelId:'global-model',providers:[
    {id:'global',name:'Global',baseUrl:'http://local',apiKey:'',models:[{id:'global-model',name:'Global'}]},
    {id:'workspace',name:'Workspace',baseUrl:'http://local',apiKey:'',models:[{id:'workspace-model',name:'Workspace'}]}
  ]}};
  const send=vi.fn();
  const store={loadAgentModes:()=>saved.modes,loadAgentModels:()=>saved.models,loadAgentThinking:()=>saved.thinkings,
    saveAgentModes:vi.fn(),saveAgentModels:vi.fn(),saveAgentThinking:vi.fn()};
  const ctx={config:{get:()=>config},store,getWindow:()=>({webContents:{send}}),notify:{push:vi.fn()}} as unknown as AppContext;
  return {ctx,store,send};
}
function message(index:number):ChatMessage{return{id:`message-${index}`,role:'assistant',content:`body ${index}`,createdAt:index+1};}

describe('scheduler browsing does not materialize an execution bucket',()=>{
  it('keeps startup, workspace browsing and model controls on bounded read paths until the first send',async()=>{
    const f=fixture();
    const piFile=path.join(env.root,'original-pi.jsonl');fs.writeFileSync(piFile,JSON.stringify({type:'session',cwd:env.root})+'\n');
    const messages=Array.from({length:1000},(_,index)=>message(index));
    messages[990]={...messages[990],userQuestion:{status:'pending',questions:[]} as never};
    messages[991]={...messages[991],turnChanges:{id:'interrupted',state:'collecting',files:[],warnings:[]} as never};
    messages[999]={id:'queued-original',role:'user',content:'queued before restart',createdAt:1000,queued:true};
    for(const workspaceId of ['first','second']){
      const seed=new SchedulerSessionAdapter(env.root,workspaceId,{display:messages,api:[],piSessionFile:piFile});await seed.flush('seed');seed.close();
    }
    const logFile=schedulerSqlitePath(env.root,'workspace-first');
    const secondLog=schedulerSqlitePath(env.root,'workspace-second');
    const readRevision=(file:string)=>{const db=new DatabaseSync(file);try{return (db.prepare("SELECT value FROM scheduler_meta WHERE key='revision'").get() as {value:string}).value}finally{db.close();}};
    const originalRevision=readRevision(logFile),secondRevision=readRevision(secondLog);
    const o=new Orchestrator(f.ctx);
    expect(o.buckets.size).toBe(0);expect(o.getAgentMode()).toBe('ask');
    const tail=o.getHistoryRange('first');
    expect(tail.total).toBe(1000);expect(tail.before).toBe(880);expect(tail.messages).toHaveLength(120);
    expect(tail.messages.find(message=>message.id==='message-990')?.userQuestion?.status).toBe('aborted');
    expect(tail.messages.find(message=>message.id==='message-991')?.turnChanges?.state).toBe('error');
    expect(tail.messages.at(-1)?.queued).toBe(true);
    expect(o.getContextStatus('first')).toMatchObject({provider:'workspace',modelId:'workspace-model'});
    expect(getWorkspacePromptScope(o,'first').workspaceContext?.cwd).toBe(env.root);
    o.bindWorkspace('second');o.bindWorkspace('first');
    expect(f.send.mock.calls.filter(([channel])=>channel==='agent:history')).toHaveLength(2);
    expect(o.buckets.size).toBe(0);
    o.setAgentMode('plan','second');o.switchModel('second',{providerId:'workspace',modelId:'workspace-model'});o.setThinking('low','second');
    expect(o.getAgentMode('second')).toBe('plan');expect(o.getContextStatus('second').modelId).toBe('workspace-model');
    expect(o.buckets.size).toBe(0);
    expect(readRevision(logFile)).toBe(originalRevision);expect(readRevision(secondLog)).toBe(secondRevision);
    vi.spyOn(o,'maybeIdleMicrocompact').mockResolvedValue(undefined);
    vi.spyOn(o,'checkSendImages').mockReturnValue({ok:true});
    const start=vi.spyOn(o,'startTurn').mockImplementation(async bucket=>{
      expect(bucket.queue.map(item=>item.id)).toEqual(['queued-original']);
      expect(bucket.display[10].id).toBe('message-10');
      expect(bucket.display.find(message=>message.id==='message-990')?.userQuestion?.status).toBe('aborted');
    });
    await o.send('new instruction','first');
    expect(start).toHaveBeenCalledOnce();expect(o.buckets.size).toBe(1);
    expect(o.getHistoryRange('first',undefined,12,'message-10').messages.some(message=>message.id==='message-10')).toBe(true);
    await o.flushSessions();
    const activeSession=o.buckets.get('first')!.schedulerSession!;
    const activeRevision=activeSession.revision;
    o.bindWorkspace('second');o.bindWorkspace('first');
    expect(o.buckets.get('first')!.schedulerSession!.revision).toBe(activeRevision);
    activeSession.close();
    const restarted=new Orchestrator(f.ctx);expect(restarted.buckets.size).toBe(0);
    expect(restarted.getHistoryRange('first').total).toBe(1001);
    expect(restarted.getHistoryRange('first',undefined,12,'message-10').messages.some(message=>message.id==='message-10')).toBe(true);
  });
  it('observes a cold settled reply across pages without full history or bucket creation',async()=>{
    const f=fixture();
    const messages=Array.from({length:1000},(_,index)=>message(index));
    messages[5]={...messages[5],finishedAt:1500};
    messages[998]={...messages[998],local:true,finishedAt:3000};
    const seed=new SchedulerSessionAdapter(env.root,'first',{display:messages,api:[]});await seed.flush('seed');seed.close();
    const o=new Orchestrator(f.ctx);
    const full=vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw new Error('observation must not read full files');});
    const read=vi.spyOn(fs,'readSync');
    try {
      expect(observeScheduler(o,'first',false)).toEqual({busy:false,createdAt:0,updatedAt:0,lastReply:null});
      expect(read).not.toHaveBeenCalled();
      expect(observeScheduler(o,'first',true)).toMatchObject({busy:false,createdAt:1,updatedAt:1500,
        lastReply:{messageId:'message-5',text:'body 5',status:'completed',finishedAt:1500}});
      expect(o.buckets.size).toBe(0);
    }finally{full.mockRestore();read.mockRestore();}
  });

});
