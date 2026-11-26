// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import type {AppContext} from '../../../src/main/context';
vi.stubGlobal('window',globalThis);
const mocks=vi.hoisted(()=>({root:'',handlers:new Map<string,(event:unknown,...args:unknown[])=>unknown>()}));
vi.mock('electron',()=>({app:{getPath:()=>mocks.root}}));
vi.mock('../../../src/main/ipc/handle',()=>({
  handle:(channel:string,handler:(event:unknown,...args:unknown[])=>unknown)=>mocks.handlers.set(channel,handler),
  ipcCaller:()=>undefined,
  ownIpcResource:()=>{}
}));
vi.mock('../../../src/main/turnChanges/ipc',()=>({registerTurnChangesIpc:()=>{}}));
import {registerAgentSessionIpc} from '../../../src/main/ipc/agentSession';
afterEach(()=>{
  mocks.handlers.clear();
  if(mocks.root)fs.rmSync(mocks.root,{recursive:true,force:true});
  mocks.root='';
});

it('normalizes JSON positional nulls before the strict metadata timeline reader',async()=>{
  mocks.root=fs.mkdtempSync(path.join(os.tmpdir(),'gui-metadata-web-transport-'));
  const timeline=vi.fn((_session:string,_kind:string,before?:number,limit=120)=>{
    if(before!==undefined&&!Number.isSafeInteger(before))throw new Error('invalid cursor');
    return{ok:true,page:{records:[],total:0,before:0,hasEarlier:false,limit}};
  });
  registerAgentSessionIpc({agentSessions:{metadataTimeline:timeline}} as unknown as AppContext);
  const invoke=mocks.handlers.get('agentSession:metadataTimeline')!;
  // webApiShim transports its complete positional argument list as JSON.
  const args=JSON.parse(JSON.stringify(['session','injections',undefined,40]));
  expect(await invoke({},...args)).toMatchObject({ok:true});
  expect(timeline).toHaveBeenLastCalledWith('session','injections',undefined,40);
  await invoke({},'session','compactions',null,null);
  expect(timeline).toHaveBeenLastCalledWith('session','compactions',undefined,120);
  expect(()=>invoke({},'session','injections','invalid',40)).toThrow('invalid cursor');
});
