import React from 'react';
import { ChatTranscript, type TranscriptModelBinding } from '../../src/renderer/src/chatSurface/ChatTranscript';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HarnessInjectCard } from '../../src/renderer/src/chatSurface/harnessAnnotations';
import { AgentSessionSurfaceStore } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import { currentApiMock } from './helpers/api-mock';
import type { GuiChatMessage } from '../../src/shared/guiWorker';
import type { GuiInjectionSummary, GuiInjectionDetailsResult } from '../../src/shared/guiHistoryMetadata';

const summary = (key: string): GuiInjectionSummary => ({kind:'summary', at:1000, segments:[{source:key,chars:7,hash:key}],toolCount:0,toolsFingerprint:'',details:{key}});
const full = {at:1000,segments:[{source:'policy',chars:7,hash:'h',text:'private full text'}]};
function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (reason:unknown)=>void; const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject}; }
const openCard = () => fireEvent.click(screen.getByText('本次发送 · 注入 1 段'));

describe('bounded harness metadata', () => {
  it('loads only on expansion, retries failures and releases full text on collapse', async () => {
    const load=vi.fn().mockResolvedValueOnce({ok:false,error:'读取失败'}).mockResolvedValue({ok:true,snapshot:full});
    render(<HarnessInjectCard snapshot={summary('policy')} loadDetails={load}/>);
    expect(load).not.toHaveBeenCalled();openCard();
    await screen.findByRole('alert');fireEvent.click(screen.getByText('重试'));
    await screen.findByText('private full text');expect(load).toHaveBeenCalledTimes(2);
    openCard();expect(screen.queryByText('private full text')).toBeNull();
    openCard();await waitFor(()=>expect(load).toHaveBeenCalledTimes(3));
  });
  it('keeps loaded details across equivalent summary objects and invalidates a changed key', async () => {
    const load=vi.fn().mockResolvedValue({ok:true,snapshot:full});
    const view=render(<HarnessInjectCard snapshot={summary('stable')} loadDetails={load}/>);
    openCard();await screen.findByText('private full text');
    view.rerender(<HarnessInjectCard snapshot={{...summary('stable')}} loadDetails={load}/>);
    await act(async()=>{});expect(load).toHaveBeenCalledTimes(1);expect(screen.queryByText('private full text')).toBeTruthy();
    view.rerender(<HarnessInjectCard snapshot={summary('changed')} loadDetails={load}/>);
    await waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
  });
  it('ignores resolved and rejected requests after collapse or identity replacement', async () => {
    const first=deferred<GuiInjectionDetailsResult>();const second=deferred<GuiInjectionDetailsResult>();
    const load=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view=render(<HarnessInjectCard snapshot={summary('a')} loadDetails={load}/>);
    openCard();await waitFor(()=>expect(load).toHaveBeenCalledTimes(1));openCard();
    await act(async()=>first.resolve({ok:true,snapshot:full}));expect(screen.queryByText('private full text')).toBeNull();
    openCard();await waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
    view.rerender(<HarnessInjectCard snapshot={summary('b')} loadDetails={vi.fn().mockResolvedValue({ok:false,error:'new record'})}/>);
    await act(async()=>second.resolve({ok:true,snapshot:full}));expect(screen.queryByText('private full text')).toBeNull();
    await screen.findByText('new record');
    const rejected=deferred<GuiInjectionDetailsResult>();
    view.rerender(<HarnessInjectCard snapshot={summary('c')} loadDetails={()=>rejected.promise}/>);
    await act(async()=>{});openCard();
    await act(async()=>rejected.reject(new Error('late rejection')));
    expect(screen.queryByText('Error: late rejection')).toBeNull();
  });
});

it('keeps metadata attached to retained body pages and exposes the snapshot loader', async () => {
  const api=currentApiMock();
  api.mockOf('agentSession.historyRange').mockImplementation(async (_id:string,before?:number) => {
    const start=before===undefined?1080:before-120;
    return {messages:Array.from({length:120},(_,i)=>({id:`m${start+i}`,role:'user',ts:start+i,parts:[{kind:'text',text:'body'}]})),
      mode:'auto',busy:false,before:start,total:1200,hasEarlier:start>0,injections:[{...summary(`page${start}`),at:start}],
      compactions:[{at:start+5,tokensBefore:100,tokensAfter:10}], metadataStatus:{injectionCount:10,compactionCount:10,compactionsOverflow:true}};
  });
  const store=new AgentSessionSurfaceStore('metadata-pages',{id:'pi',pi:true,claude:false,acp:false,codex:false});
  store.attach('pi',{flashTip:vi.fn(),t:key=>key});
  try {
    await waitFor(()=>expect(store.harnessStore.get().injections).toHaveLength(1));
    store.retainPageWindow({start:0,end:120});
    await waitFor(()=>expect(store.harnessStore.get().injections.some(view=>view.segments[0]?.source==='page0')).toBe(true));
    store.retainPageWindow({start:480,end:600});
    await waitFor(()=>expect(store.harnessStore.get().injections.some(view=>view.segments[0]?.source==='page480')).toBe(true));
    const keys=store.harnessStore.get().injections.map(view=>view.segments[0]?.source);
    expect(keys).toContain('page480');expect(keys).toContain('page1080');expect(keys).not.toContain('page0');
    expect(typeof store.harnessStore.get().injectionDetails).toBe('function');
  } finally {store.dispose();}
});

it('bounds internal metadata ownership across overlapping sliding tail ranges', async () => {
  const api=currentApiMock();let tail=120;
  api.mockOf('agentSession.historyRange').mockImplementation(async()=>({
    messages:Array.from({length:120},(_,i)=>({id:`slide${tail+i}`,role:'user',ts:tail+i,parts:[]})),
    injections:Array.from({length:120},(_,i)=>({...summary(`generation${tail+i}`),at:tail+i})),
    compactions:[{at:tail+5}],before:tail,total:tail+120,hasEarlier:true,mode:'auto',busy:false
  }));
  const store=new AgentSessionSurfaceStore('metadata-slide',{id:'pi',pi:true,claude:false,acp:false,codex:false});
  store.attach('pi',{flashTip:vi.fn(),t:key=>key});
  try {
    await waitFor(()=>expect(store.harnessStore.get().injections.length).toBe(120));
    for(let step=0;step<24;step++) {
      tail++;await store.ensureMessageLoaded(`slide${tail+119}`);
      const held=(store as unknown as {metadataMessages:Map<string,{injection?:unknown}>}).metadataMessages;
      const bodyIds=new Set((store.getSnapshot().messages as readonly GuiChatMessage[]).map(message=>message.id));
      expect(held.size).toBeLessThanOrEqual(bodyIds.size);
      expect([...held.keys()].every(id=>bodyIds.has(id))).toBe(true);
      expect([...held.values()].filter(item=>item.injection).length).toBeLessThanOrEqual(bodyIds.size);
    }
  } finally {store.dispose();}
});

it('keeps actual sparse transcript snapshots stable across unchanged 10k viewport retention', async () => {
  const originalResizeObserver=globalThis.ResizeObserver;
  vi.stubGlobal('ResizeObserver', class {observe():void{} unobserve():void{} disconnect():void{}});
  const api=currentApiMock();
  const injection={...summary('stable-window'),at:0};
  api.mockOf('agentSession.historyRange').mockImplementation(async (_id:string,before?:number)=>{
    const end=before??10000,start=Math.max(0,end-120);
    return {messages:Array.from({length:end-start},(_,offset)=>({id:`stable-${start+offset}`,role:offset%2?'assistant':'user',ts:start+offset,parts:[{kind:'text',text:`history ${start+offset}`}]})),
      before:start,total:10000,hasEarlier:start>0,mode:'auto',busy:false,injections:[injection],
      compactions:start<=9900&&end>9900?[{at:9900,tokensBefore:100,tokensAfter:50}]:[],
      metadataStatus:{injectionCount:1,compactionCount:1,compactionsOverflow:false}};
  });
  const store=new AgentSessionSurfaceStore('stable-metadata-sparse',{id:'pi',pi:true,claude:false,acp:false,codex:false});
  store.attach('pi',{flashTip:vi.fn(),t:key=>key});
  let renders=0;
  const model:TranscriptModelBinding<GuiChatMessage>={toDisplay:message=>({id:message.id,role:message.role,content:message.parts.filter(part=>part.kind==='text').map(part=>'text' in part?part.text:'').join(''),createdAt:message.ts})};
  function ActualTranscript():React.JSX.Element {
    renders++;
    const snapshot=React.useSyncExternalStore(store.subscribe,store.getSnapshot);
    const harness=React.useSyncExternalStore(store.harnessStore.subscribe,store.harnessStore.get);
    return <ChatTranscript sessionId="stable-metadata-sparse" busy={false} model={model} messages={snapshot.messages as readonly GuiChatMessage[]}
      harness={harness} compactions={snapshot.compactions} page={snapshot.page}
      messageIndex={id=>store.messageIndex(id)} onVirtualWindow={window=>store.retainPageWindow(window)}/>;
  }
  let view:ReturnType<typeof render>|undefined;
  try {
    await waitFor(()=>expect(store.getSnapshot().messages.length).toBe(120));
    view=render(<ActualTranscript/>);
    await waitFor(()=>expect(view!.container.querySelector('[data-mid="stable-9999"]')).toBeTruthy());
    act(()=>store.retainPageWindow({start:9880,end:10000}));
    await waitFor(()=>expect(store.getSnapshot().page?.loadState.earlier.status).not.toBe('loading'));
    const state=store.getSnapshot(), harness=store.harnessStore.get(), injections=harness.injections, compactions=state.compactions;
    for(let attempt=0;attempt<12;attempt++) {
      act(()=>store.retainPageWindow({start:9880,end:10000}));
      expect(store.harnessStore.get()).toBe(harness);
      expect(store.harnessStore.get().injections).toBe(injections);
      expect(store.getSnapshot().compactions).toBe(compactions);
      expect(store.getSnapshot()).toBe(state);
    }
    expect(renders).toBeLessThan(12);
  } finally {view?.unmount();store.dispose();vi.stubGlobal('ResizeObserver',originalResizeObserver);}
});
