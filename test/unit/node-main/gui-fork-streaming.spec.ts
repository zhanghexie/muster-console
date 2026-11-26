// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createForkContextSpool,readForkContextSpool,removeForkContextSpool} from '../../../src/main/agentSession/forkContextSpool';
import {writeGuiForkPrefix} from '../../../src/main/runtimeKernel/guiForkPrefix';
import {readMessageRangeIndex} from '../../../src/main/runtimeKernel/messageRangeIndex';
import {GuiSessionStore} from '../../../src/main/agentSession/persist';
import {FileSessionManager} from '../../../src/main/runtimeKernel/sessionManager';
vi.stubGlobal('window',globalThis);
const roots:string[]=[];
function root(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gui-fork-streaming-'));roots.push(dir);return dir;}
afterEach(()=>{vi.restoreAllMocks();for(const dir of roots.splice(0)){expect(path.dirname(dir)).toBe(os.tmpdir());expect(path.basename(dir).startsWith('gui-fork-streaming-')).toBe(true);fs.rmSync(dir,{recursive:true,force:true});}});
function* messages(count:number){for(let index=0;index<count;index++)yield{id:`message-${index}`,role:'assistant' as const,ts:index,parts:[{kind:'text' as const,text:`正文 ${index} `+'内容'.repeat(80)}]};}

describe('streamed GUI fork artifacts',()=>{
  it('keeps pending context markers small and verifies UTF-8 spool integrity without whole-file reads',()=>{
    const dir=root();let produced=0;
    function* seeds(){for(let index=0;index<1000;index++){produced++;yield{role:'user' as const,text:`${index}:`+'汉字🙂'.repeat(index===10?20000:10),ts:index};}}
    const descriptor=createForkContextSpool(dir,'child',seeds());
    expect(produced).toBe(1000);expect(JSON.stringify(descriptor).length).toBeLessThan(256);
    vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw new Error('spool must stream');});
    let read=0;for(const seed of readForkContextSpool(dir,'child',descriptor)){if(read===10)expect(seed.text).toBe('10:'+'汉字🙂'.repeat(20000));read++;}
    expect(read).toBe(1000);
    expect(()=>Array.from(readForkContextSpool(dir,'other',descriptor))).toThrow('descriptor');
    expect(()=>Array.from(readForkContextSpool(dir,'child',{...descriptor,name:'../escape'}))).toThrow('descriptor');
    fs.appendFileSync(path.join(dir,descriptor.name),'{}\n');
    expect(()=>Array.from(readForkContextSpool(dir,'child',descriptor))).toThrow();
    removeForkContextSpool(dir,'child');expect(fs.existsSync(path.join(dir,descriptor.name))).toBe(false);
  });
  it('does not replace another context body and cleans failed iterator staging',()=>{
    const dir=root(),descriptor=createForkContextSpool(dir,'child',[{role:'user',text:'original',ts:1}]);
    expect(()=>createForkContextSpool(dir,'child',[{role:'user',text:'replacement',ts:1}])).toThrow();
    expect(Array.from(readForkContextSpool(dir,'child',descriptor))[0].text).toBe('original');
    function* broken(){yield{role:'user' as const,text:'partial',ts:1};throw new Error('iterator failed');}
    expect(()=>createForkContextSpool(dir,'broken',broken())).toThrow('iterator failed');
    expect(fs.readdirSync(dir)).toEqual([descriptor.name]);
  });
  it('loads only bounded fork metadata and rejects inconsistent delivery descriptors',()=>{
    const dir=root(),store=new GuiSessionStore(dir);
    store.beginForkPreparation('child');
    const descriptor=store.createForkContext('child',[{role:'user',text:'private prior context',ts:1}]);
    store.savePendingFork('child',{state:'pending',seed:descriptor,transcript:null,delivery:'seed'});
    const read=vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw new Error('metadata must not read context bodies');});
    expect(store.loadPendingFork('child')?.seed).toEqual(descriptor);read.mockRestore();
    store.savePendingFork('child',{state:'pending',seed:descriptor,transcript:descriptor,delivery:'seed'});
    expect(()=>store.loadPendingFork('child')).toThrow('格式损坏');
    store.savePendingFork('child',{state:'pending',seed:descriptor,transcript:null,delivery:'transcript'});
    expect(()=>store.loadPendingFork('child')).toThrow('格式损坏');
    store.clearPendingFork('child');store.finishForkPreparation('child');
    expect(()=>store.beginForkPreparation('../escape')).toThrow('Invalid GUI fork target');
  });
  it('writes 10k messages and externally sorted random-access indexes without a full JSON or ID array',async()=>{
    const dir=root(),sessionId='streamed-child',stats={maxBufferedIds:0,maxMergeReaders:0,messages:0};
    const factory=new FileSessionManager(path.join(dir,'plugins'),{gui:path.join(dir,'agent-session-events')});
    await writeGuiForkPrefix(dir,sessionId,messages(10000),{factory,stats});
    expect(factory.list()).toEqual([]);expect(stats.messages).toBe(10000);
    expect(stats.maxBufferedIds).toBeLessThanOrEqual(4096);expect(stats.maxMergeReaders).toBeLessThanOrEqual(32);
    const checkpoint=path.join(dir,'agent-sessions',`${sessionId}.json`),events=path.join(dir,'agent-session-events',`${sessionId}.ndjson`);
    const full=vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw new Error('range must not read whole artifacts');});
    const range=readMessageRangeIndex(checkpoint,events,undefined,12,'message-5000');
    expect(range?.total).toBe(10000);expect(range?.messages.map(message=>message.id)).toContain('message-5000');
    // The streamed child has its empty metadata index already. Its first cold
    // page/timeline must not recover the entire new transcript just to discover
    // that no historical injection records were inherited.
    expect(fs.existsSync(`${checkpoint}.timeline`)).toBe(true);
    const coldStore=new GuiSessionStore(dir);
    const coldPage=coldStore.loadRangeSnapshot(sessionId,undefined,12,'message-5000');
    expect(coldPage.messages.map(message=>message.id)).toContain('message-5000');
    expect(coldPage.messages.length).toBeLessThanOrEqual(12);
    expect(coldPage.metadataStatus).toEqual({injectionCount:0,compactionCount:0,compactionsOverflow:false});
    expect(coldStore.metadataTimeline(sessionId,'injections')).toEqual({kind:'injections',records:[],before:0,total:0,hasEarlier:false});
    expect(coldStore.injectionDetails(sessionId,{key:'a'.repeat(64)})).toBeNull();
    full.mockRestore();
    const restored=new GuiSessionStore(dir).loadSnapshot(sessionId);
    expect(restored.messages).toHaveLength(10000);expect(restored.messages[5000].id).toBe('message-5000');
    expect(fs.readdirSync(path.join(dir,'agent-sessions')).some(name=>name.includes('.prefix-'))).toBe(false);
    await factory.dispose();
  });
  it('rejects duplicate IDs across sort runs and removes only its unpublished artifacts',async()=>{
    const dir=root();
    function* duplicate(){yield* messages(4100);yield* messages(1);}
    await expect(writeGuiForkPrefix(dir,'duplicate',duplicate())).rejects.toThrow('Duplicate');
    expect(fs.existsSync(path.join(dir,'agent-sessions','duplicate.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir,'agent-session-events','duplicate.ndjson'))).toBe(false);
    const existing=path.join(dir,'agent-session-events','existing.ndjson');fs.writeFileSync(existing,'owned by another operation');
    await expect(writeGuiForkPrefix(dir,'existing',messages(1))).rejects.toThrow();
    expect(fs.readFileSync(existing,'utf8')).toBe('owned by another operation');
  });
  it('reopens a streamed private seed spool through the actual Pi SDK with single-record preparation',async()=>{
    const result=await promisify(execFile)(process.execPath,['test/gui-fork-seed-archive.mjs'],{cwd:process.cwd(),timeout:30000});
    expect(result.stdout).toContain('gui fork seed archive SDK: ok');
  });

});
