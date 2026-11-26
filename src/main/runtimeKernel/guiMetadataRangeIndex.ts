import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {parseInjectionSnapshots,parseCompactionRecords,toolCatalogFingerprint,type GuiInjectionSnapshot,type GuiCompactionRecord} from '../../shared/guiWorker';
import type {GuiHistoryMetadataWindow,GuiInjectionDetailRef,GuiInjectionSummary,GuiMetadataKind,GuiMetadataTimelinePage} from '../../shared/guiHistoryMetadata';

const MAGIC=Buffer.from('MSTRMDT1'),HEADER=20,ROW=104,HASH_ROW=36,PAGE_LIMIT=120;
type Stamp={size:number;mtimeMs:number;ctimeMs:number};
type Envelope={source:Stamp;events:Stamp|null};
type RecordSpan={at:number;offset:number;length:number;ordinal:number;hash:Buffer;summary:Buffer};
type OpenIndex={fd:number;envelope:Envelope;injections:number;compactions:number;rows:number;hashes:number;blobs:number;size:number};
export const guiMetadataRangeIndexPath=(checkpoint:string):string=>`${checkpoint}.timeline`;
function stamp(file:string):Stamp|null{try{const s=fs.statSync(file);return{size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
function diagnostic(error:unknown):void{if((error as NodeJS.ErrnoException).code!=='ENOENT')console.warn('[gui-metadata-index] rebuilding unavailable metadata index:',String(error));}
function same(a:Stamp|null,b:Stamp|null):boolean{return a===b||!!a&&!!b&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function hash(value:string|Buffer):Buffer{return createHash('sha256').update(value).digest();}
function read(fd:number,size:number,position:number):Buffer{
  const bytes=Buffer.alloc(size);let done=0;while(done<size){const n=fs.readSync(fd,bytes,done,size-done,position+done);if(!n)throw new Error('Truncated GUI metadata index');done+=n;}return bytes;
}
function write(fd:number,bytes:Buffer):void{let done=0;while(done<bytes.length)done+=fs.writeSync(fd,bytes,done,bytes.length-done);}
function skipWhitespace(bytes:Buffer,position:number):number{while([9,10,13,32].includes(bytes[position]!))position++;return position;}
function skipValue(bytes:Buffer,position:number):number{
  let depth=0,quoted=false,escaped=false;
  for(let cursor=position;cursor<bytes.length;cursor++){
    const byte=bytes[cursor];
    if(quoted){if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34){quoted=false;if(!depth)return cursor+1;}}
    else if(byte===34)quoted=true;
    else if(byte===123||byte===91)depth++;
    else if(byte===125||byte===93){if(!depth)return cursor;if(--depth===0)return cursor+1;}
    else if(!depth&&(byte===44||[9,10,13,32].includes(byte!)))return cursor;
  }
  throw new Error('Unterminated GUI checkpoint value');
}
/** Inspect only root properties, so a nested tool argument named injections
 * cannot impersonate the checkpoint's metadata array. */
function* arraySpans(bytes:Buffer,key:string):IterableIterator<{offset:number;length:number;ordinal:number}>{
  let cursor=skipWhitespace(bytes,0);if(bytes[cursor++]!==123)throw new Error('Invalid GUI checkpoint object');
  for(;;){
    cursor=skipWhitespace(bytes,cursor);if(bytes[cursor]===125)return;
    if(bytes[cursor]!==34)throw new Error('Invalid GUI checkpoint key');
    const end=skipValue(bytes,cursor),name=JSON.parse(bytes.subarray(cursor,end).toString('utf8'));
    cursor=skipWhitespace(bytes,end);if(bytes[cursor++]!==58)throw new Error('Invalid GUI checkpoint property');cursor=skipWhitespace(bytes,cursor);
    if(name===key){
      if(bytes[cursor++]!==91)return;
      let ordinal=0;cursor=skipWhitespace(bytes,cursor);
      while(bytes[cursor]!==93){const offset=cursor;cursor=skipValue(bytes,cursor);yield{offset,length:cursor-offset,ordinal:ordinal++};
        cursor=skipWhitespace(bytes,cursor);if(bytes[cursor]===93)break;if(bytes[cursor++]!==44)throw new Error('Invalid GUI metadata separator');cursor=skipWhitespace(bytes,cursor);}
      return;
    }
    cursor=skipWhitespace(bytes,skipValue(bytes,cursor));if(bytes[cursor]===125)return;if(bytes[cursor++]!==44)throw new Error('Invalid GUI checkpoint separator');
  }
}
export function summarizeGuiInjection(snapshot:GuiInjectionSnapshot,key?:string):GuiInjectionSummary{
  snapshot=parseInjectionSnapshots([snapshot])[0];if(!snapshot)throw new Error('Invalid GUI injection snapshot');
  key??=hash(JSON.stringify(snapshot)).toString('hex');
  return{kind:'summary',at:snapshot.at,segments:snapshot.segments.map(({text:_text,...segment})=>segment),
    ...(snapshot.enginePrompt?{enginePrompt:{chars:snapshot.enginePrompt.chars,hash:snapshot.enginePrompt.hash}}:{}),
    toolCount:snapshot.tools?.length??0,toolsFingerprint:toolCatalogFingerprint(snapshot.tools),details:{key}};
}

/** Built at the existing checkpoint boundary. Full records stay in that
 * checkpoint; this sidecar contains small summaries and independently seekable
 * spans, never a giant JSON metadata envelope. */
export function writeGuiMetadataRangeIndex(checkpoint:string,events:string,json:string):void{
  const source=stamp(checkpoint);if(!source)throw new Error('GUI metadata checkpoint missing');
  const bytes=Buffer.from(json);if(bytes.length!==source.size)throw new Error('GUI metadata checkpoint changed');
  const collect=(kind:GuiMetadataKind):RecordSpan[]=>{
    const out:RecordSpan[]=[];
    for(const span of arraySpans(bytes,kind)){
      const raw:unknown=JSON.parse(bytes.subarray(span.offset,span.offset+span.length).toString('utf8'));
      const value=kind==='injections'?parseInjectionSnapshots([raw])[0]:parseCompactionRecords([raw])[0];if(!value)continue;
      const digest=hash(JSON.stringify(value));
      const summary=kind==='injections'?summarizeGuiInjection(value as GuiInjectionSnapshot,digest.toString('hex')):value;
      out.push({...span,at:value.at,hash:digest,summary:Buffer.from(JSON.stringify(summary))});
    }
    return out.sort((a,b)=>a.at-b.at||a.ordinal-b.ordinal);
  };
  const injections=collect('injections'),compactions=collect('compactions');
  if(injections.length>0xffffffff||compactions.length>0xffffffff)throw new Error('GUI metadata index is too large');
  const envelope=Buffer.from(JSON.stringify({source,events:stamp(events)} satisfies Envelope));
  if(envelope.length>4096)throw new Error('GUI metadata envelope exceeds budget');
  const header=Buffer.alloc(HEADER);MAGIC.copy(header);header.writeUInt32LE(envelope.length,8);header.writeUInt32LE(injections.length,12);header.writeUInt32LE(compactions.length,16);
  let blobPosition=HEADER+envelope.length+(injections.length+compactions.length)*ROW+injections.length*HASH_ROW;
  const file=guiMetadataRangeIndexPath(checkpoint),temporary=`${file}.${randomUUID()}.tmp`,fd=fs.openSync(temporary,'wx',0o600);
  try{
    try{
      write(fd,header);write(fd,envelope);
      for(const records of [injections,compactions])for(const record of records){
        const row=Buffer.alloc(ROW);row.writeDoubleLE(record.at);row.writeDoubleLE(record.offset,8);row.writeDoubleLE(record.length,16);
        row.writeDoubleLE(blobPosition,24);row.writeUInt32LE(record.summary.length,32);row.writeUInt32LE(record.ordinal,36);
        record.hash.copy(row,40);hash(record.summary).copy(row,72);write(fd,row);blobPosition+=record.summary.length;
      }
      const lookup=injections.map((record,index)=>({hash:record.hash,index})).sort((a,b)=>Buffer.compare(a.hash,b.hash));
      for(const item of lookup){const row=Buffer.alloc(HASH_ROW);item.hash.copy(row);row.writeUInt32LE(item.index,32);write(fd,row);}
      for(const records of [injections,compactions])for(const record of records)write(fd,record.summary);
    }finally{fs.closeSync(fd);}
    if(!same(source,stamp(checkpoint)))throw new Error('GUI metadata checkpoint changed during indexing');
    fs.renameSync(temporary,file);
  }finally{fs.rmSync(temporary,{force:true});}
}
/** Streaming forks have no historical metadata and must not read their newly
 * written complete transcript merely to publish an empty timeline. */
export function writeEmptyGuiMetadataRangeIndex(checkpoint:string,events:string):void{
  const source=stamp(checkpoint);if(!source)throw new Error('GUI metadata checkpoint missing');
  const envelope=Buffer.from(JSON.stringify({source,events:stamp(events)} satisfies Envelope)),header=Buffer.alloc(HEADER);
  MAGIC.copy(header);header.writeUInt32LE(envelope.length,8);
  const file=guiMetadataRangeIndexPath(checkpoint),temporary=`${file}.${randomUUID()}.tmp`;
  try{fs.writeFileSync(temporary,Buffer.concat([header,envelope]),{flag:'wx',mode:0o600});fs.linkSync(temporary,file);}
  finally{fs.rmSync(temporary,{force:true});}
}
function open(checkpoint:string,events:string):OpenIndex|null{
  let fd:number|undefined;
  try{
    fd=fs.openSync(guiMetadataRangeIndexPath(checkpoint),'r');const header=read(fd,HEADER,0);
    if(!header.subarray(0,8).equals(MAGIC))throw new Error('Invalid GUI metadata index header');
    const length=header.readUInt32LE(8),injections=header.readUInt32LE(12),compactions=header.readUInt32LE(16);
    if(length>4096)throw new Error('Invalid GUI metadata envelope size');
    const envelope=JSON.parse(read(fd,length,HEADER).toString('utf8')) as Envelope;
    if(!envelope.source||!same(envelope.source,stamp(checkpoint))||!same(envelope.events,stamp(events)))throw new Error('Stale GUI metadata index');
    const rows=HEADER+length,hashes=rows+(injections+compactions)*ROW,blobs=hashes+injections*HASH_ROW,size=fs.fstatSync(fd).size;
    if(blobs>size)throw new Error('Truncated GUI metadata tables');
    return{fd,envelope,injections,compactions,rows,hashes,blobs,size};
  }catch(error){if(fd!==undefined)fs.closeSync(fd);diagnostic(error);return null;}
}
function current(index:OpenIndex,checkpoint:string,events:string):boolean{return same(index.envelope.source,stamp(checkpoint))&&same(index.envelope.events,stamp(events));}
function count(index:OpenIndex,kind:GuiMetadataKind):number{return kind==='injections'?index.injections:index.compactions;}
function row(index:OpenIndex,kind:GuiMetadataKind,position:number):Buffer{
  if(!Number.isSafeInteger(position)||position<0||position>=count(index,kind))throw new Error('Invalid GUI metadata ordinal');
  const value=read(index.fd,ROW,index.rows+((kind==='injections'?0:index.injections)+position)*ROW);
  if(!Number.isFinite(value.readDoubleLE(0)))throw new Error('Invalid GUI metadata time');return value;
}
function summary<T>(index:OpenIndex,kind:GuiMetadataKind,position:number):T{
  const record=row(index,kind,position),offset=record.readDoubleLE(24),length=record.readUInt32LE(32);
  if(!Number.isSafeInteger(offset)||offset<index.blobs||!length||offset+length>index.size)throw new Error('Invalid GUI metadata summary span');
  const bytes=read(index.fd,length,offset);if(!hash(bytes).equals(record.subarray(72,104)))throw new Error('Invalid GUI metadata summary checksum');
  const value=JSON.parse(bytes.toString('utf8')) as {at:number;details?:GuiInjectionDetailRef};
  if(value.at!==record.readDoubleLE(0)||kind==='injections'&&value.details?.key!==record.subarray(40,72).toString('hex'))throw new Error('GUI metadata summary mismatch');
  return value as T;
}
function upperBound(index:OpenIndex,kind:GuiMetadataKind,at:number):number{
  let lo=0,hi=count(index,kind);while(lo<hi){const middle=Math.floor((lo+hi)/2);if(row(index,kind,middle).readDoubleLE(0)<=at)lo=middle+1;else hi=middle;}return lo;
}

/** At most one effective injection per visible message plus its boundary
 * baseline. Dense generations remain available through the separate timeline.
 * The first-snapshot fallback matches resolveInjectionCards: capture can finish
 * after the first accepted user timestamp, so that first turn uses generation 0. */
export function readGuiMetadataWindow(checkpoint:string,events:string,timestamps:readonly number[]):GuiHistoryMetadataWindow|null{
  if(timestamps.length>PAGE_LIMIT+1)throw new Error('GUI metadata window exceeds message budget');
  const index=open(checkpoint,events);if(!index)return null;
  try{
    const times=timestamps.filter(Number.isFinite),positions=new Set<number>();
    for(const time of times)if(index.injections)positions.add(Math.max(0,upperBound(index,'injections',time)-1));
    const injections=[...positions].sort((a,b)=>a-b).map(position=>summary<GuiInjectionSummary>(index,'injections',position));
    const from=times.length?Math.min(...times):Infinity,to=times.length?Math.max(...times):Infinity;
    const start=Math.max(0,upperBound(index,'compactions',from)-1),end=upperBound(index,'compactions',to);
    const retainedStart=Math.max(start,end-PAGE_LIMIT),compactions:GuiCompactionRecord[]=[];
    for(let position=retainedStart;position<end;position++)compactions.push(summary(index,'compactions',position));
    if(!current(index,checkpoint,events))return null;
    return{injections,compactions,injectionCount:index.injections,compactionCount:index.compactions,compactionsOverflow:retainedStart>start};
  }catch(error){diagnostic(error);return null;}finally{fs.closeSync(index.fd);}
}
export function readGuiMetadataTimeline(checkpoint:string,events:string,kind:GuiMetadataKind,before?:number,limit=PAGE_LIMIT):GuiMetadataTimelinePage|null{
  const index=open(checkpoint,events);if(!index)return null;
  try{
    if(before!==undefined&&!Number.isSafeInteger(before))throw new Error('Invalid GUI metadata cursor');
    const total=count(index,kind),end=before===undefined?total:Math.max(0,Math.min(total,Math.floor(before)));
    const take=Number.isFinite(limit)?Math.max(1,Math.min(PAGE_LIMIT,Math.floor(limit))):PAGE_LIMIT,start=Math.max(0,end-take);
    const records=[];for(let position=start;position<end;position++)records.push(summary<GuiInjectionSummary|GuiCompactionRecord>(index,kind,position));
    return current(index,checkpoint,events)?{kind,records,before:start,total,hasEarlier:start>0}:null;
  }catch(error){diagnostic(error);return null;}finally{fs.closeSync(index.fd);}
}
export type GuiInjectionDetailRead={status:'ok';snapshot:GuiInjectionSnapshot}|{status:'missing'}|{status:'invalid'};
export function readGuiInjectionDetails(checkpoint:string,events:string,reference:GuiInjectionDetailRef):GuiInjectionDetailRead{
  if(!reference||!/^[a-f0-9]{64}$/.test(reference.key))throw new Error('Invalid GUI injection detail reference');
  const index=open(checkpoint,events);if(!index)return{status:'invalid'};let checkpointFd:number|undefined;
  try{
    const wanted=Buffer.from(reference.key,'hex');let lo=0,hi=index.injections,position=-1;
    while(lo<hi){const middle=Math.floor((lo+hi)/2),entry=read(index.fd,HASH_ROW,index.hashes+middle*HASH_ROW),order=Buffer.compare(entry.subarray(0,32),wanted);
      if(!order){position=entry.readUInt32LE(32);break;}if(order<0)lo=middle+1;else hi=middle;}
    if(position<0)return{status:'missing'};
    const record=row(index,'injections',position);if(!record.subarray(40,72).equals(wanted))throw new Error('GUI injection lookup mismatch');
    const offset=record.readDoubleLE(8),length=record.readDoubleLE(16);
    if(![offset,length].every(Number.isSafeInteger)||offset<0||length<1||offset+length>index.envelope.source.size)throw new Error('Invalid GUI injection detail span');
    checkpointFd=fs.openSync(checkpoint,'r');const raw:unknown=JSON.parse(read(checkpointFd,length,offset).toString('utf8')),value=parseInjectionSnapshots([raw])[0];
    if(!value||!hash(JSON.stringify(value)).equals(wanted))throw new Error('GUI injection detail checksum mismatch');
    return current(index,checkpoint,events)?{status:'ok',snapshot:value}:{status:'invalid'};
  }catch(error){diagnostic(error);return{status:'invalid'};}finally{if(checkpointFd!==undefined)fs.closeSync(checkpointFd);fs.closeSync(index.fd);}
}
