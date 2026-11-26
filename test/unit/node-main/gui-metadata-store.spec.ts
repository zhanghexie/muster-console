// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {GuiSessionStore} from '../../../src/main/agentSession/persist';
import {GuiSessionEventAdapter,type GuiSessionProjection} from '../../../src/main/runtimeKernel/guiSession';
import {guiMetadataRangeIndexPath,writeGuiMetadataRangeIndex} from '../../../src/main/runtimeKernel/guiMetadataRangeIndex';
import {writeMessageRangeIndex} from '../../../src/main/runtimeKernel/messageRangeIndex';
import type {GuiChatMessage,GuiInjectionSnapshot} from '../../../src/shared/guiWorker';
vi.stubGlobal('window',globalThis);
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const message=(index:number,text=`message ${index}`):GuiChatMessage=>({id:`m${index}`,role:'user',ts:index,parts:[{kind:'text',text}]});
function fixture(count=80,contextRepeats=600){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gui-meta-store-'));roots.push(root);
  const context='context '.repeat(contextRepeats);
  const injections:GuiInjectionSnapshot[]=Array.from({length:count},(_,index)=>({at:index*10,segments:[{source:'policy',chars:context.length,hash:`h${index}`,text:`private-${index}:`+context}],
    enginePrompt:{chars:context.length,hash:`engine-${index}`,text:context},tools:[{name:'tool',description:context}]}));
  const messages=Array.from({length:2000},(_,index)=>message(index));
  const compactions=Array.from({length:count},(_,index)=>({at:index,tokensBefore:10000,tokensAfter:1000}));
  const writer = new GuiSessionStore(root);
  writer.retain('session');
  writer.save('session', messages, null, [], compactions);
  for (const [index, injection] of injections.entries()) {
    writer.recordInjection('session', injection);
    if ((index + 1) % 100 === 0) writer.flushSync();
  }
  writer.flushSync();
  return{root,injections,messages,compactions,checkpoint:path.join(root,'agent-sessions/session.json'),events:path.join(root,'agent-session-events/session.ndjson')};
}
describe('GUI metadata Store integration',()=>{
  it('keeps real cold pages and timeline reads bounded beyond the old metadata envelope limit, with no rebuild for a valid detail miss',()=>{
    // Keep the large checkpoint while bounding fixture construction. Each
    // append updates the real projection's metadata and counts against its batch limit.
    const count=400;
    const {root,checkpoint}=fixture(count, 2000);expect(fs.statSync(checkpoint).size).toBeGreaterThan(16*1024*1024);
    const store=new GuiSessionStore(root),ranges=vi.spyOn(store,'loadRangeSnapshot');
    const complete=vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw new Error('normal cold browsing cannot read complete files');});
    const page=store.loadRangeSnapshot('session',undefined,12,'m1000');
    expect(page.messages).toHaveLength(12);expect(page.injections.length).toBeLessThanOrEqual(12);
    expect(page.metadataStatus.injectionCount).toBe(count);expect(JSON.stringify(page)).not.toContain('private-');
    const snapshot=store.injectionDetails('session',page.injections[0].details);expect(snapshot?.segments[0].text).toContain('private-');
    ranges.mockClear();expect(store.injectionDetails('session',{key:'0'.repeat(64)})).toBeNull();expect(ranges).not.toHaveBeenCalled();
    const timeline=store.metadataTimeline('session','injections',undefined,5)!;
    expect(timeline.records).toHaveLength(5);expect(timeline.total).toBe(count);expect(JSON.stringify(timeline)).not.toContain('private-');
    expect(complete).not.toHaveBeenCalled();
  });
  it('repairs a corrupt metadata sidecar once, including equal checkpoint/event mtimes, then reuses positional indexes',()=>{
    const {root,checkpoint,events,messages}=fixture();
    const equal=new Date(Date.now()-1000);fs.utimesSync(checkpoint,equal,equal);fs.utimesSync(events,equal,equal);
    const json=fs.readFileSync(checkpoint,'utf8');
    writeMessageRangeIndex(checkpoint,events,json,messages.map(record=>record.id),{guiMetadataVersion:1,lastUsage:null});
    writeGuiMetadataRangeIndex(checkpoint,events,json);
    const file=guiMetadataRangeIndexPath(checkpoint),bytes=fs.readFileSync(file);bytes[bytes.length-2]^=1;fs.writeFileSync(file,bytes);
    const store=new GuiSessionStore(root),original=fs.readFileSync;
    let fullReads=0;
    const read=vi.spyOn(fs,'readFileSync').mockImplementation(((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
      if(file===checkpoint)fullReads++;return (original as (...args:any[])=>any)(file,...args);
    }) as typeof fs.readFileSync);
    expect(store.loadRangeSnapshot('session',undefined,2).messages.map(record=>record.id)).toEqual(['m1998','m1999']);
    expect(fullReads).toBe(1);read.mockRestore();
    vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw new Error('a repaired index must not recover the complete projection again');});
    expect(store.loadRangeSnapshot('session',undefined,2).metadataStatus.injectionCount).toBe(80);
    expect(store.metadataTimeline('session','compactions',undefined,4)?.records).toHaveLength(4);
  });
  it('writes only changed metadata facts during ordinary messages and restores those facts after writer retirement',async()=>{
    const {root,events}=fixture(),store=new GuiSessionStore(root);store.retain('session');store.loadSnapshot('session');
    const adapter=(store as unknown as {eventAdapters:Map<string,GuiSessionEventAdapter>}).eventAdapters.get('session')!;
    const state=(adapter as unknown as {state:GuiSessionProjection}).state;
    const segment=state.injections[0].segments[0],originalText=segment.text;
    const oldBody=vi.fn(()=>{throw new Error('ordinary writes cannot revisit historical injection bodies');});
    Object.defineProperty(segment,'text',{get:oldBody,enumerable:true,configurable:true});
    const metadata=vi.spyOn(adapter,'metadataSnapshot').mockImplementation(()=>{throw new Error('ordinary messages cannot clone full metadata');});
    const before=fs.statSync(events).size;
    let details:{key:string};
    try{
      store.save('session',[message(1999,'changed message')],null,undefined,undefined,true);
      details=store.recordInjection('session',{at:1999,segments:[{source:'policy',chars:5,hash:'fresh',text:'fresh'}]}).details;
      store.recordCompaction('session',0,{at:0,tokensAfter:77});
      expect(store.loadRangeSnapshot('session',undefined,2).injections.at(-1)?.details).toEqual(details);
      adapter.flushSync();expect(oldBody).not.toHaveBeenCalled();expect(metadata).not.toHaveBeenCalled();
      const length=fs.statSync(events).size-before;expect(length).toBeLessThan(4096);
      const fd=fs.openSync(events,'r'),tail=Buffer.alloc(length);try{fs.readSync(fd,tail,0,length,before);}finally{fs.closeSync(fd);}
      const facts=tail.toString('utf8').trim().split('\n').map(line=>JSON.parse(line).payload);
      expect(facts.map(fact=>fact.kind)).toEqual(['messages','injection','compaction']);
      expect(Object.keys(facts[0].metadata)).toEqual(['lastUsage']);expect(tail.toString('utf8')).not.toContain('private-');
    }finally{Object.defineProperty(segment,'text',{value:originalText,writable:true,configurable:true,enumerable:true});metadata.mockRestore();}
    await store.release('session');
    const cold=new GuiSessionStore(root),restored=cold.loadSnapshot('session');
    expect(restored.messages.at(-1)?.parts).toEqual([{kind:'text',text:'changed message'}]);
    expect(restored.injections).toHaveLength(81);expect(restored.compactions[0].tokensAfter).toBe(77);
    expect(cold.injectionDetails('session',details!)?.segments[0].text).toBe('fresh');
  });
});
