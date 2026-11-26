// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import type {AppContext} from '../../../src/main/context';
import type {SessionMeta} from '../../../src/shared/types';
import type {GuiChatMessage,GuiWorkerHistoryPage} from '../../../src/shared/guiWorker';
const env=vi.hoisted(()=>({root:''}));
vi.mock('electron',()=>({app:{getPath:()=>env.root}}));
import {AgentSessionHost} from '../../../src/main/agentSession/host/agentSessionHost';
import {sanitizeRestoredMessages,sanitizeRestoredMessagePage} from '../../../src/shared/guiWorker';
import {GuiSessionStore} from '../../../src/main/agentSession/persist';
import {PageMapCoordinator} from '../../../src/renderer/src/chatSurface/pageMapCoordinator';
vi.stubGlobal('window',globalThis);
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

it('keeps cold sanitized rows in their persisted slots across real overlapping and target pages',async()=>{
  env.root=fs.mkdtempSync(path.join(os.tmpdir(),'gui-range-position-'));roots.push(env.root);
  const meta={id:'cold-slots',name:'Cold',type:'terminal',runtime:'codex-gui',workspaceId:'ws',cwd:env.root,createdAt:1} as SessionMeta;
  const messages:GuiChatMessage[]=[
    {id:'before',role:'user',parts:[{kind:'text',text:'before'}],ts:1},
    {id:'empty-shell',role:'assistant',parts:[],queued:true,retryHint:'stale retry',ts:2},
    {id:'target',role:'user',parts:[{kind:'text',text:'target'}],ts:3},
    {id:'after',role:'assistant',parts:[{kind:'text',text:'after'}],ts:4}
  ];
  const seed=new GuiSessionStore(env.root);seed.save(meta.id,messages);seed.flushSync();
  const ctx={config:{get:()=>({activeWorkspaceId:'ws',workspaces:[{id:'ws',name:'Workspace',path:env.root}]})},
    sessions:{get:(id:string)=>id===meta.id?meta:undefined,engineSweepRoster:()=>[meta],rootDependencyRoster:()=>[meta],list:()=>[meta],
      applyActivitySignal:vi.fn(),setQueuedInjects:vi.fn(),setBoardReplyPreview:vi.fn()},store:{loadSessions:()=>[meta]},getWindow:()=>null} as unknown as AppContext;
  const host=new AgentSessionHost(ctx,{userDataDir:env.root});host.open(meta);
  const snapshot=vi.spyOn(host.store,'loadSnapshot').mockImplementation(()=>{throw new Error('range cannot restore complete projection');});
  const retain=vi.spyOn(host.store,'retain').mockImplementation(()=>{throw new Error('range cannot retain projection');});
  const map=new PageMapCoordinator<GuiChatMessage>({generation:1,total:4});
  const apply=(page:GuiWorkerHistoryPage)=>map.applyPage({generation:1,range:{start:page.before,end:page.before+page.messages.length},
    messages:page.messages.map(payload=>({messageId:payload.id,payload})),cursor:{before:page.before,total:page.total,hasEarlier:page.hasEarlier}});
  try{
    const later=host.getHistoryRange(meta.id,4,2)!;apply(later);
    const earlier=host.getHistoryRange(meta.id,2,2)!;apply(earlier);
    expect(earlier.messages.map(message=>message.id)).toEqual(['before','empty-shell']);
    expect(earlier.messages[1].queued).toBeUndefined();expect(earlier.messages[1].retryHint).toBeUndefined();
    const target=host.getHistoryRange(meta.id,undefined,3,'target')!;apply(target);
    expect(map.locateMessage('before')?.index).toBe(0);expect(map.locateMessage('empty-shell')?.index).toBe(1);
    expect(map.locateMessage('target')?.index).toBe(2);expect(map.locateMessage('after')?.index).toBe(3);
    expect(map.getSnapshot().loadedRanges).toEqual([{start:0,end:4}]);
    const shell=host.getHistoryRange(meta.id,2,1)!;expect(shell.messages.map(message=>message.id)).toEqual(['empty-shell']);
    expect(shell.before).toBe(1);expect(shell.total).toBe(4);
    expect(snapshot).not.toHaveBeenCalled();expect(retain).not.toHaveBeenCalled();expect(host.entries.size).toBe(0);
  }finally{snapshot.mockRestore();retain.mockRestore();await host.closeAll();}
});

it('retains aborted empty assistants as recall and diagnostic evidence while full recovery drops only semantic-free shells',()=>{
  const messages:GuiChatMessage[]=[{id:'empty',role:'assistant',parts:[],ts:1},
    {id:'aborted',role:'assistant',parts:[],aborted:true,ts:2}];
  expect(sanitizeRestoredMessages(messages).map(message=>message.id)).toEqual(['aborted']);
  expect(sanitizeRestoredMessagePage(messages).map(message=>message.id)).toEqual(['empty','aborted']);
  expect(sanitizeRestoredMessages(messages)[0].aborted).toBe(true);
});
