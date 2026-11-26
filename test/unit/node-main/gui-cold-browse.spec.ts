// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,afterAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {AppContext} from '../../../src/main/context';
import type {SessionMeta} from '../../../src/shared/types';
import type {GuiChatMessage} from '../../../src/shared/guiWorker';
const env=vi.hoisted(()=>({root:''}));
vi.mock('electron',()=>({app:{getPath:()=>env.root}}));
import {AgentSessionHost} from '../../../src/main/agentSession/host/agentSessionHost';
import {GuiSessionStore} from '../../../src/main/agentSession/persist';
import {getNodeReplManager} from '../../../src/main/agentSession/tools/nodeRepl';
import {randomUUID} from 'node:crypto';
import * as connections from '../../../src/main/agentSession/host/connection';
import type {GuiRuntimeConnection} from '../../../src/main/agentSession/types';
import * as turn from '../../../src/main/agentSession/host/turn';
import {startTurn} from '../../../src/main/agentSession/host/turn';
vi.stubGlobal('window',globalThis);
// turn.ts 与 messaging.ts 互相 import：用 vi.mock(...,importOriginal) 会在加载真实 turn 时
// 把 messaging 提前求值并捕获真实 startTurn，注册的 mock 对它无效（真实回合还会启动连接、
// 占住文件句柄导致 EBUSY）。改为对唯一模块命名空间 spy，spec 与 messaging 共用同一 spy。
beforeEach(()=>{vi.spyOn(turn,'startTurn').mockImplementation(async()=>{});});
const roots:string[]=[];
const deferred:string[]=[];
afterEach(()=>{
  vi.restoreAllMocks();
  for(const root of roots.splice(0)){
    try{fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
    catch{deferred.push(root);}
  }
});
afterAll(()=>{
  for(const root of deferred.splice(0)){
    try{fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});}catch{/* 系统占用，留给 OS 清理临时目录 */}
  }
});
function fixture(){
  env.root=fs.mkdtempSync(path.join(os.tmpdir(),'gui-cold-browse-'));roots.push(env.root);
  const meta={id:'cold-browse',name:'Cold',type:'terminal',runtime:'codex-gui',workspaceId:'ws',cwd:env.root,createdAt:1,guiMode:'ask'} as SessionMeta;
  const messages:GuiChatMessage[]=Array.from({length:3000},(_,i)=>({id:`message-${i}`,role:'assistant',ts:i+1,finishedAt:i+2,parts:[{kind:'text',text:`body ${i}`}]}));
  const seed=new GuiSessionStore(env.root);seed.save(meta.id,messages);seed.flushSync();
  const config={activeWorkspaceId:'ws',workspaces:[{id:'ws',name:'Workspace',path:env.root}],liveThinkingOnly:true};
  const sessions={get:(id:string)=>id===meta.id?meta:undefined,engineSweepRoster:()=>[meta],rootDependencyRoster:()=>[meta],list:()=>[meta],
    applyActivitySignal:vi.fn(),setQueuedInjects:vi.fn(),setBoardReplyPreview:vi.fn(),touchUsed:vi.fn(),updateGuiMode:vi.fn((_id:string,mode:SessionMeta['guiMode'])=>{meta.guiMode=mode;})};
  const ctx={config:{get:()=>config},sessions,store:{loadSessions:()=>[meta]},getWindow:()=>null} as unknown as AppContext;
  return{meta,messages,ctx,host:new AgentSessionHost(ctx,{userDataDir:env.root})};
}

describe('GUI browsing owns no execution projection',()=>{
  it('opens and reads indexed pages without snapshots, retained adapters or pending-fork bodies',async()=>{
    const {host,meta}=fixture();
    const snapshot=vi.spyOn(host.store,'loadSnapshot').mockImplementation(()=>{throw new Error('browsing cannot read complete snapshot');});
    const retain=vi.spyOn(host.store,'retain').mockImplementation(()=>{throw new Error('browsing cannot retain a projection');});
    const fork=vi.spyOn(host.store,'loadPendingFork').mockImplementation(()=>{throw new Error('browsing cannot read pending-fork payload');});
    try{
      host.open(meta);
      expect(host.isOpen(meta.id)).toBe(true);expect(host.entries.size).toBe(0);
      expect(await host.waitUntilOpen(meta.id,1)).toBe(true);
      expect(host.getHistoryRange(meta.id,undefined,12,'message-1500')?.messages.some(message=>message.id==='message-1500')).toBe(true);
      expect(host.getMode(meta.id)).toBe('ask');expect(host.messageCount(meta.id)).toBe(3000);
      expect((await host.setMode(meta.id,'plan')).ok).toBe(true);expect(host.getMode(meta.id)).toBe('plan');
      expect(host.respondApproval(meta.id,'expired-approval',true)).toBe(false);
      expect(host.respondUserQuestion(meta.id,'expired-question','abort')).toBe(false);
      expect(host.entries.size).toBe(0);
      expect(host.lastAssistantReply(meta.id)).toEqual({id:'message-2999',text:'body 2999'});
      expect(snapshot).not.toHaveBeenCalled();expect(retain).not.toHaveBeenCalled();expect(fork).not.toHaveBeenCalled();
      await host.close(meta.id);expect(host.isOpen(meta.id)).toBe(false);
      expect(host.entries.size).toBe(0);
    }finally{snapshot.mockRestore();retain.mockRestore();fork.mockRestore();await host.closeAll();}
  });
  it('forks a cold source through bounded pages and publishes only the selected semantic prefix',async()=>{
    const {host,meta,ctx}=fixture();host.open(meta);
    const sourceGet=ctx.sessions.get.bind(ctx.sessions);
    let child:SessionMeta|undefined;
    ctx.sessions.get=((id:string)=>child?.id===id?child:sourceGet(id)) as typeof ctx.sessions.get;
    ctx.sessions.createTerminal=(async options=>{
      const next={...meta,id:randomUUID(),name:'Fork'} as SessionMeta;
      await options?.prepareGuiSession?.(next);child=next;return next;
    }) as typeof ctx.sessions.createTerminal;
    const snapshot=vi.spyOn(host.store,'loadSnapshot').mockImplementation(()=>{throw new Error('fork cannot materialize source');});
    const retain=vi.spyOn(host.store,'retain').mockImplementation(()=>{throw new Error('fork cannot retain source');});
    const ranges=vi.spyOn(host.store,'loadRangeSnapshot');
    try{
      const result=await host.forkSession(meta.id,'message-1500');
      expect(result.ok,result.error).toBe(true);expect(host.entries.size).toBe(0);
      expect(snapshot).not.toHaveBeenCalled();expect(retain).not.toHaveBeenCalled();
      expect(ranges.mock.calls.every(call=>(call[2]??120)<=120)).toBe(true);
      const prefix=host.store.loadRangeSnapshot(result.sessionId!,undefined,3);
      expect(prefix.total).toBe(1501);expect(prefix.messages.at(-1)?.id).toBe('message-1500');
      const pending=host.store.loadPendingFork(result.sessionId!);
      expect(pending?.transcript?.count).toBe(1501);expect(pending?.seed).toBeNull();
      const marker=fs.readFileSync(path.join(env.root,'agent-fork-pending',`${result.sessionId}.json`),'utf8');
      expect(Buffer.byteLength(marker)).toBeLessThan(1024);expect(marker).not.toContain('body 1500');
      expect(host.store.readForkTranscript(result.sessionId!,pending!.transcript!,80000)).toContain('body 1500');
      expect(host.store.readForkTranscript(result.sessionId!,pending!.transcript!,80000)).not.toContain('body 1501');
    }finally{snapshot.mockRestore();retain.mockRestore();await host.closeAll();}
  });
  it('locks a cold source during async preparation and rejects publication after source settings change',async()=>{
    const {host,meta,ctx}=fixture();host.open(meta);
    let proceed!:()=>void;const gate=new Promise<void>(resolve=>{proceed=resolve;});
    let reached!:()=>void;const ready=new Promise<void>(resolve=>{reached=resolve;});
    ctx.sessions.createTerminal=(async options=>{reached();await gate;const child={...meta,id:randomUUID()} as SessionMeta;await options?.prepareGuiSession?.(child);return child;}) as typeof ctx.sessions.createTerminal;
    const forking=host.forkSession(meta.id,'message-1200');await ready;
    expect(()=>host.materializeForExecution(meta.id)).toThrow('正在分叉');
    expect((await host.forkSession(meta.id)).ok).toBe(false);
    meta.name='changed';proceed();expect((await forking).ok).toBe(false);
    expect(host.entries.size).toBe(0);await host.closeAll();
  });
  it('protects an unregistered preparation from orphan sweep and removes its owned prefix after a source race',async()=>{
    const {host,meta,ctx}=fixture();host.open(meta);let childId='';
    ctx.sessions.createTerminal=(async options=>{const child={...meta,id:randomUUID()} as SessionMeta;childId=child.id;await options?.prepareGuiSession?.(child);return child;}) as typeof ctx.sessions.createTerminal;
    const original=host.store.saveForkPrefix.bind(host.store);
    vi.spyOn(host.store,'saveForkPrefix').mockImplementationOnce(async(id,messages,assertCurrent)=>{
      host.store.sweepOrphans(new Set([meta.id]));
      expect(host.store.loadPendingFork(id)?.state).toBe('preparing');
      await original(id,messages,assertCurrent);meta.name='changed after prefix';
    });
    const result=await host.forkSession(meta.id,'message-1200');
    expect(result.ok).toBe(false);expect(result.error).toContain('源会话已变化');
    expect(host.store.loadPendingFork(childId)).toBeNull();
    expect(fs.existsSync(path.join(env.root,'agent-sessions',`${childId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(env.root,'agent-session-events',`${childId}.ndjson`))).toBe(false);
    expect(fs.existsSync(path.join(env.root,'agent-session-events',`${childId}.ndjson.index.json`))).toBe(false);
    expect(fs.existsSync(path.join(env.root,'agent-fork-context',`${childId}.seeds.ndjson`))).toBe(false);
    expect(host.store.loadRangeSnapshot(meta.id,undefined,1).total).toBe(3000);
    await host.closeAll();
  });
  it('relocates a cold native fork cutoff by message ID after execution sanitization removes earlier shells',async()=>{
    const {host,meta,ctx}=fixture();meta.runtimeResumeToken='source-native';
    host.store.save(meta.id,[{id:'empty-shell',role:'assistant',parts:[],ts:1},
      {id:'target',role:'user',parts:[{kind:'text',text:'include target'}],ts:2},
      {id:'after-target',role:'assistant',parts:[{kind:'text',text:'must never leak'}],ts:3}]);host.store.flushSync();
    host.store.saveForkPoint(meta.id,'target',{engine:'codex',sessionToken:'source-native',entryId:'native-target',role:'user'});
    const nativeFork=vi.fn(async()=>({status:'forked' as const,token:'child-native'}));
    vi.spyOn(connections,'ensureConnection').mockResolvedValue({nativeFork} as unknown as GuiRuntimeConnection);
    ctx.sessions.createTerminal=(async options=>{const child={...meta,id:randomUUID()} as SessionMeta;await options?.prepareGuiSession?.(child);return child;}) as typeof ctx.sessions.createTerminal;
    host.open(meta);const result=await host.forkSession(meta.id,'target');
    expect(result.ok,result.error).toBe(true);expect(nativeFork).toHaveBeenCalledOnce();
    expect(host.entries.get(meta.id)?.messages.map(message=>message.id)).toEqual(['target','after-target']);
    const child=host.store.loadRangeSnapshot(result.sessionId!,undefined,120);
    expect(child.messages.map(message=>message.id)).toEqual(['target']);expect(JSON.stringify(child)).not.toContain('must never leak');
    await host.closeAll();
  });
  it('materializes only when sending and preserves historical IDs and range positions after restart',async()=>{
    const {host,meta}=fixture();
    host.open(meta);expect(host.entries.size).toBe(0);
    const snapshot=vi.spyOn(host.store,'loadSnapshot');
    const fork=vi.spyOn(host.store,'loadPendingFork');
    try{
      const accepted=await host.send(meta.id,'new instruction');
      // startTurn 被 spy 掉（不挂 assistant 占位）：受理只追加一条用户消息。
      expect(accepted.ok).toBe(true);expect(host.entries.get(meta.id)?.messages).toHaveLength(3001);
      expect(snapshot).toHaveBeenCalled();expect(fork).toHaveBeenCalled();expect(startTurn).toHaveBeenCalled();
      expect(host.getHistoryRange(meta.id,undefined,12,'message-1500')?.messages.some(message=>message.id==='message-1500')).toBe(true);
      await host.close(meta.id);
      host.open(meta);expect(host.entries.size).toBe(0);
      expect(host.getHistoryRange(meta.id)?.total).toBe(3001);
      expect(host.getHistoryRange(meta.id,undefined,12,'message-1500')?.messages.some(message=>message.id==='message-1500')).toBe(true);
    }finally{await host.closeAll();}
  });
  it('waits for cold-view repl disposal without blocking store release, and reports cleanup failure',async()=>{
    const {host,meta}=fixture();host.open(meta);
    let reject!:(error:Error)=>void;
    const disposal=new Promise<void>((_resolve,fail)=>{reject=fail;});
    vi.spyOn(getNodeReplManager(),'dispose').mockImplementationOnce(()=>disposal);
    const release=vi.spyOn(host.store,'release');
    let settled=false;
    const closing=host.close(meta.id);
    void closing.then(()=>{settled=true;},()=>{settled=true;});
    await vi.waitFor(()=>expect(release).toHaveBeenCalledWith(meta.id));
    expect(settled).toBe(false);expect(host.isOpen(meta.id)).toBe(false);
    reject(new Error('repl cleanup failed'));
    await expect(closing).rejects.toThrow('repl cleanup failed');
    expect(host.entries.size).toBe(0);await host.closeAll();
  });

  it('owns failed materialization cleanup, blocks reentry and makes close await the same release',async()=>{
    const {host,meta}=fixture();host.open(meta);
    const snapshot=vi.spyOn(host.store,'loadSnapshot').mockImplementationOnce(()=>{throw new Error('restore failed');});
    const original=host.store.release.bind(host.store);
    let finish!:()=>void;
    const gate=new Promise<void>(resolve=>{finish=resolve;});
    const release=vi.spyOn(host.store,'release').mockImplementationOnce(async id=>{await gate;await original(id);});
    expect(()=>host.materializeForExecution(meta.id)).toThrow('restore failed');
    expect(()=>host.materializeForExecution(meta.id)).toThrow('仍在清理');
    expect(snapshot).toHaveBeenCalledTimes(1);
    let closed=false;const closing=host.close(meta.id).then(()=>{closed=true;});
    await vi.waitFor(()=>expect(release).toHaveBeenCalledOnce());expect(closed).toBe(false);
    finish();await closing;expect(release).toHaveBeenCalledTimes(1);
    host.open(meta);expect(host.materializeForExecution(meta.id).messages).toHaveLength(3000);
    await host.closeAll();
  });
  it('keeps failed storage cleanup as a diagnostic barrier through closeAll',async()=>{
    const {host,meta}=fixture();host.open(meta);
    vi.spyOn(host.store,'loadSnapshot').mockImplementationOnce(()=>{throw new Error('restore failed');});
    vi.spyOn(host.store,'release').mockRejectedValueOnce(new Error('storage owner cleanup failed'));
    expect(()=>host.materializeForExecution(meta.id)).toThrow('restore failed');
    await vi.waitFor(()=>expect(()=>host.materializeForExecution(meta.id)).toThrow('storage owner cleanup failed'));
    expect(host.entries.size).toBe(0);
    await expect(host.closeAll()).rejects.toThrow('GUI session shutdown failed');
  });

});
