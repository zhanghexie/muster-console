/** A retained native transcript may omit an unchanged message payload, never its fresh metadata. */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage, GuiWorkerHistory, GuiWorkerHistoryPage } from '../../src/shared/guiWorker';
import {overrideGuiHistory} from './helpers/gui-history-range';
import { currentApiMock } from './helpers/api-mock';

const environment = vi.hoisted(() => ({ web: false }));
vi.mock('../../src/renderer/src/webGatewayEnvironment', () => ({ isWebGateway: () => environment.web }));

const message = (text = 'initial'): GuiChatMessage => ({ id: 'a', role: 'assistant', ts: 1, parts: [{ kind: 'text', text }] });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
};

function client(id = 'conditional') {
  const ref: { current: ChatSurface | null } = { current: null };
  function Probe({ visible }: { visible: boolean }) {
    ref.current = useAgentSessionSurface({ sessionId: id, runtimeId: 'pi', visible });
    return null;
  }
  const ui = (visible: boolean) => <StoreProvider><Probe visible={visible} /></StoreProvider>;
  const view = render(ui(true));
  return { ref, view, show: (visible: boolean) => act(async () => { view.rerender(ui(visible)); }) };
}

function backend() {
  const state={history:{messages:[message()],mode:'auto',busy:false} as GuiWorkerHistory};
  overrideGuiHistory(currentApiMock(),async()=>JSON.parse(JSON.stringify(state.history)));
  currentApiMock().override('agentSession.getHistory',async()=>{throw new Error('complete transcript forbidden');});
  return state;
}

const texts = (surface: ChatSurface) => surface.getSnapshot().messages.map(item =>
  (item as GuiChatMessage).parts.filter(part => part.kind === 'text').map(part => part.text).join(''));

describe('GUI bounded recovery',()=>{
  beforeEach(()=>{environment.web=false;currentApiMock().override('config.get',async()=>({workspaces:[],activeWorkspaceId:null,
    llm:{providers:[{id:'p',enabled:true,models:[{id:'model'}]}],activeProviderId:'p',activeModelId:'model'}}));});
  it('retains message references while visibility refreshes bounded pages and metadata',async()=>{
    const state=backend();state.history.messages=[{...message(),parts:[{kind:'text',text:'retained '.repeat(8192)}]}];
    const view=client();await waitFor(()=>expect(view.ref.current!.getSnapshot().messages).toHaveLength(1));
    const initial=view.ref.current!.getSnapshot().messages;
    state.history={...state.history,mode:'ask',busy:true,piModeId:'new-preset',usage:{tokens:88,contextWindow:1000}};
    for(let index=0;index<8;index++){await view.show(false);await view.show(true);}
    await waitFor(()=>expect(currentApiMock().mockOf('agentSession.historyRange')).toHaveBeenCalledTimes(9));
    const snapshot=view.ref.current!.getSnapshot();expect(snapshot.messages).toBe(initial);expect(snapshot.mode).toBe('ask');
    expect(snapshot.busy).toBe(true);expect(snapshot.preset?.id).toBe('new-preset');expect(snapshot.status?.usage?.tokens).toBe(88);
    expect(currentApiMock().mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
  });
  it.each(['delta','part','sync','clear'] as const)('restores hidden %s changes through bounded ranges',async kind=>{
    const state=backend(),view=client();await waitFor(()=>expect(texts(view.ref.current!)).toEqual(['initial']));
    const notify=vi.fn(),stop=view.ref.current!.subscribe(notify);await view.show(false);
    state.history={...state.history,messages:kind==='clear'?[]:[message(`hidden-${kind}`)]};
    act(()=>currentApiMock().emit('agentSession:event',{sessionId:'conditional',kind:kind==='clear'?'sync':kind,messageId:'a',partIndex:0,deltaKind:'text',delta:'hidden',part:{kind:'text',text:'hidden'},messages:state.history.messages}));
    expect(notify).not.toHaveBeenCalled();expect(texts(view.ref.current!)).toEqual(['initial']);await view.show(true);
    await waitFor(()=>expect(texts(view.ref.current!)).toEqual(kind==='clear'?[]:[`hidden-${kind}`]));stop();
    expect(currentApiMock().mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
  });
  it.each(['reject','null','malformed'] as const)('keeps data and reports %s without full fallback or an automatic retry loop',async failure=>{
    backend();const view=client();await waitFor(()=>expect(texts(view.ref.current!)).toEqual(['initial']));
    currentApiMock().override('agentSession.historyRange',async()=>{if(failure==='reject')throw new Error('range unavailable');return failure==='null'?null:{messagesUnchanged:true};});
    await view.show(false);await view.show(true);
    await waitFor(()=>expect(view.ref.current!.getSnapshot().historyError).toBeTruthy());
    await act(async()=>{await Promise.resolve();await Promise.resolve();});
    expect(currentApiMock().mockOf('agentSession.historyRange')).toHaveBeenCalledTimes(1);expect(texts(view.ref.current!)).toEqual(['initial']);
    expect(currentApiMock().mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
  });
  it('queues a bounded desync recovery behind one in-flight page',async()=>{
    backend();const view=client();await waitFor(()=>expect(texts(view.ref.current!)).toEqual(['initial']));
    const pending=deferred<GuiWorkerHistoryPage>();let calls=0;
    currentApiMock().override('agentSession.historyRange',()=>++calls===1?pending.promise:Promise.resolve({messages:[message('repaired')],mode:'auto',busy:false,before:0,total:1,hasEarlier:false}));
    await view.show(false);await view.show(true);
    act(()=>currentApiMock().emit('agentSession:event',{sessionId:'conditional',kind:'part',messageId:'missing',partIndex:0,part:{kind:'text',text:'x'}}));
    await act(async()=>pending.resolve({messages:[message('old')],mode:'auto',busy:false,before:0,total:1,hasEarlier:false}));
    await waitFor(()=>expect(texts(view.ref.current!)).toEqual(['repaired']));expect(calls).toBe(2);
    expect(currentApiMock().mockOf('agentSession.historyRange').mock.calls.every(call=>call[2]===120)).toBe(true);
    expect(currentApiMock().mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
  });
  it('does not overwrite newer metadata clocks with a delayed range',async()=>{
    backend();const view=client();await waitFor(()=>expect(texts(view.ref.current!)).toEqual(['initial']));
    const pending=deferred<GuiWorkerHistoryPage>();currentApiMock().override('agentSession.historyRange',()=>pending.promise);
    await view.show(false);await view.show(true);
    act(()=>{currentApiMock().emit('agentSession:event',{sessionId:'conditional',kind:'busy',busy:true,queued:0});currentApiMock().emit('agentSession:event',{sessionId:'conditional',kind:'context',usage:{tokens:77,contextWindow:1000}});});
    await act(async()=>pending.resolve({messages:[message()],mode:'auto',busy:false,usage:{tokens:1,contextWindow:1000},before:0,total:1,hasEarlier:false}));
    expect(view.ref.current!.getSnapshot().busy).toBe(true);expect(view.ref.current!.getSnapshot().status?.usage?.tokens).toBe(77);
  });
  it('ignores responses from a disposed epoch and from before clear',async()=>{
    const first=deferred<GuiWorkerHistoryPage>();currentApiMock().override('agentSession.historyRange',()=>first.promise);
    const view=client();await view.show(false);const state=backend();state.history.messages=[message('fresh')];await view.show(true);
    await waitFor(()=>expect(texts(view.ref.current!)).toEqual(['fresh']));
    await act(async()=>first.resolve({messages:[message('stale')],mode:'auto',busy:false,before:0,total:1,hasEarlier:false}));
    expect(texts(view.ref.current!)).toEqual(['fresh']);
    const stale=deferred<GuiWorkerHistoryPage>();currentApiMock().override('agentSession.historyRange',()=>stale.promise);
    await view.show(false);await view.show(true);await act(async()=>view.ref.current!.actions.clear());
    act(()=>currentApiMock().emit('agentSession:event',{sessionId:'conditional',kind:'sync',messages:[]}));
    await act(async()=>stale.resolve({messages:[message('revived')],mode:'auto',busy:false,before:0,total:1,hasEarlier:false}));
    expect(texts(view.ref.current!)).toEqual([]);
  });
  it('refreshes the retained reading window by a bounded target request after hide and reveal',async()=>{
    const state=backend();state.history.messages=Array.from({length:1000},(_,index)=>({...message(`body ${index}`),id:`message-${index}`,ts:index}));
    const view=client();await waitFor(()=>expect(view.ref.current!.getSnapshot().messages).toHaveLength(120));
    await act(async()=>{await view.ref.current!.actions.ensureMessageLoaded?.('message-500');view.ref.current!.actions.retainPageWindow?.({start:480,end:530,anchorIndex:500});});
    await view.show(false);state.history.messages=state.history.messages.map(item=>item.id==='message-500'?{...item,parts:[{kind:'text',text:'updated while hidden'}]}:item);
    await view.show(true);
    await waitFor(()=>expect(texts(view.ref.current!)).toContain('updated while hidden'));
    expect(currentApiMock().mockOf('agentSession.historyRange').mock.lastCall).toEqual(['conditional',undefined,120,'message-500']);
    expect(view.ref.current!.actions.messageIndex?.('message-500')).toBe(500);
    expect(currentApiMock().mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
  });
  it.each([false,true])('keeps a large transcript bounded on warm reveal (web=%s)',async web=>{
    environment.web=web;const state=backend();state.history.messages=Array.from({length:1000},(_,index)=>({...message(`body ${index}`),id:`message-${index}`,ts:index}));
    const view=client();await waitFor(()=>expect(view.ref.current!.getSnapshot().messages).toHaveLength(120));const initial=view.ref.current!.getSnapshot().messages;
    for(let index=0;index<3;index++){await view.show(false);await view.show(true);}
    await waitFor(()=>expect(currentApiMock().mockOf('agentSession.historyRange')).toHaveBeenCalledTimes(4));expect(view.ref.current!.getSnapshot().messages).toBe(initial);
    expect(currentApiMock().mockOf('agentSession.getHistory')).not.toHaveBeenCalled();
  });
});
