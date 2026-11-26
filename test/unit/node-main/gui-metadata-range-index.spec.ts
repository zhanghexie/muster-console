// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {writeGuiMetadataRangeIndex,readGuiMetadataWindow,readGuiMetadataTimeline,readGuiInjectionDetails,guiMetadataRangeIndexPath} from '../../../src/main/runtimeKernel/guiMetadataRangeIndex';
import type {GuiInjectionSummary} from '../../../src/shared/guiHistoryMetadata';
import type {GuiInjectionSnapshot} from '../../../src/shared/guiWorker';
vi.stubGlobal('window',globalThis);
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(value:unknown){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gui-meta-range-'));roots.push(root);
  const checkpoint=path.join(root,'session.json'),events=path.join(root,'session.ndjson'),json=JSON.stringify(value);
  fs.writeFileSync(checkpoint,json);fs.writeFileSync(events,'');writeGuiMetadataRangeIndex(checkpoint,events,json);
  return{root,checkpoint,events,json};
}
function injection(at:number,text:string):GuiInjectionSnapshot{return{at,segments:[{source:'policy',chars:text.length,hash:`hash-${at}`,text}],
  enginePrompt:{chars:text.length,hash:`engine-${at}`,text},tools:[{name:'tool',description:text}]};}

function fullDetail(checkpoint:string,events:string,reference:{key:string}){const result=readGuiInjectionDetails(checkpoint,events,reference);return result.status==='ok'?result.snapshot:null;}

describe('independently seekable GUI metadata',()=>{
  it('reads small summaries and one requested detail from metadata larger than the old 16MB envelope budget',()=>{
    const injections=Array.from({length:1600},(_,index)=>injection(index*10,`private-record-${index}:`+'context '.repeat(600)));
    const compactions=Array.from({length:1600},(_,index)=>({at:index,tokensBefore:100000,tokensAfter:1000}));
    const {checkpoint,events,json}=fixture({messages:[{id:'m',role:'user',parts:[{kind:'text',text:'{"injections":[{"at":99999}]}'}],ts:350}],injections,compactions});
    expect(Buffer.byteLength(json)).toBeGreaterThan(16*1024*1024);
    const complete=vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw new Error('metadata browse must not read complete files');});
    const opened=vi.spyOn(fs,'openSync'),reads=vi.spyOn(fs,'readSync');
    const page=readGuiMetadataWindow(checkpoint,events,[350,352]);
    expect(page?.injections.map(record=>record.at)).toEqual([350]);
    expect(page?.injectionCount).toBe(1600);expect(page?.compactionCount).toBe(1600);
    expect(page?.compactions.map(record=>record.at)).toEqual([350,351,352]);
    const summary=page!.injections[0];expect(summary.toolCount).toBe(1);expect(summary.segments[0]).not.toHaveProperty('text');
    expect(summary.enginePrompt).not.toHaveProperty('text');expect(summary).not.toHaveProperty('tools');
    expect(JSON.stringify(page)).not.toContain('private-record-');
    expect(opened.mock.calls.some(call=>call[0]===checkpoint)).toBe(false);
    const bytes=(reads.mock.calls as unknown as unknown[][]).reduce<number>((total,call)=>total+(typeof call[3]==='number'?call[3]:0),0);
    expect(bytes).toBeLessThan(200_000);expect(complete).not.toHaveBeenCalled();
    const result=readGuiInjectionDetails(checkpoint,events,summary.details);expect(result.status).toBe('ok');
    const detail=result.status==='ok'?result.snapshot:null;
    expect(detail?.segments[0].text).toBe(injections[35].segments[0].text);expect(detail?.tools?.[0].description).toBe(injections[35].tools?.[0].description);
    expect(opened.mock.calls.filter(call=>call[0]===checkpoint)).toHaveLength(1);
  });
  it('selects effective generations, keeps a boundary baseline and pages every dense history record independently',()=>{
    const {checkpoint,events}=fixture({messages:[],injections:[injection(50,'first-at-50'),injection(10,'baseline'),injection(50,'last-at-50')],
      compactions:Array.from({length:300},(_,index)=>({at:index,tokensAfter:index}))});
    const page=readGuiMetadataWindow(checkpoint,events,[0,49,50,299])!;
    expect(page.injections.map(record=>record.at)).toEqual([10,50]);
    expect(fullDetail(checkpoint,events,page.injections[1].details)?.segments[0].text).toBe('last-at-50');
    expect(page.compactions).toHaveLength(120);expect(page.compactionsOverflow).toBe(true);
    let before:number|undefined;const seen:number[]=[];
    do{const part=readGuiMetadataTimeline(checkpoint,events,'compactions',before,73)!;seen.unshift(...part.records.map(record=>record.at));before=part.hasEarlier?part.before:undefined;if(!part.hasEarlier)break;}while(true);
    expect(seen).toEqual(Array.from({length:300},(_,index)=>index));
    const first=readGuiMetadataTimeline(checkpoint,events,'injections',undefined,2)!;
    const older=readGuiMetadataTimeline(checkpoint,events,'injections',first.before,2)!;
    expect(first.records.map(record=>record.at)).toEqual([50,50]);expect(older.records.map(record=>record.at)).toEqual([10]);
    const sourceRecords=[...older.records,...first.records] as GuiInjectionSummary[];
    expect(sourceRecords.map(record=>fullDetail(checkpoint,events,record.details)?.segments[0].text)).toEqual(['baseline','first-at-50','last-at-50']);
    expect(()=>readGuiMetadataWindow(checkpoint,events,Array(122).fill(1))).toThrow('budget');
    expect(readGuiMetadataTimeline(checkpoint,events,'injections',NaN)).toBeNull();
  });
  it('rejects stale sources, damaged summaries and wrong detail identities instead of returning unrelated content',()=>{
    const value={messages:[{id:'m',nested:{injections:[{at:999,segments:[]}]}}],injections:[injection(1,'中文🙂')],compactions:[]};
    const {checkpoint,events,json}=fixture(value),summary=readGuiMetadataWindow(checkpoint,events,[1])!.injections[0];
    expect(readGuiInjectionDetails(checkpoint,events,{key:'0'.repeat(64)})).toEqual({status:'missing'});
    expect(()=>readGuiInjectionDetails(checkpoint,events,{key:'../escape'})).toThrow('reference');
    const index=guiMetadataRangeIndexPath(checkpoint),data=fs.readFileSync(index);data[data.length-2]^=1;fs.writeFileSync(index,data);
    expect(readGuiMetadataWindow(checkpoint,events,[1])).toBeNull();
    writeGuiMetadataRangeIndex(checkpoint,events,json);
    fs.appendFileSync(events,'changed');expect(readGuiMetadataWindow(checkpoint,events,[1])).toBeNull();expect(readGuiInjectionDetails(checkpoint,events,summary.details)).toEqual({status:'invalid'});
  });
});
