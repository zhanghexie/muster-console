import {writeEmptyGuiMetadataRangeIndex,guiMetadataRangeIndexPath} from './guiMetadataRangeIndex';
import { userDataStorage } from './storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {GuiChatMessage} from '../../shared/guiWorker';
import {withoutDisplayThinking} from '../../shared/thinkingDisplay';
import type {SessionLogFactory,SessionLogHandle} from './sessionManager';
import {SessionEventLog} from './sessionEventLog';
import type {EventEnvelope} from './contracts';

// MSTRRNG1: kept wire-compatible with readMessageRangeIndex. Construction is
// deliberately separate from the complete-JSON convenience index writer.
const HEADER=16,ORDINAL=48,ID_ENTRY=36,RUN_SIZE=4096,FAN_IN=32,MAX_COUNT=0xffffffff;
const metadata={lastUsage:null};
export type ForkPrefixStats={maxBufferedIds:number;maxMergeReaders:number;messages:number};
function write(fd:number,bytes:Buffer):void{let offset=0;while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset);}
function copy(file:string,out:number):void{const fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(65536);try{let size:number;while((size=fs.readSync(fd,buffer,0,buffer.length,null))>0)write(out,buffer.subarray(0,size));}finally{fs.closeSync(fd);}}
function stamp(file:string){const info=fs.statSync(file);return {size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs};}
function publish(temporary:string,file:string,owned:()=>void):void{fs.linkSync(temporary,file);owned();fs.unlinkSync(temporary);}
function record(fd:number):Buffer|null{const out=Buffer.alloc(ID_ENTRY);let offset=0;while(offset<ID_ENTRY){const size=fs.readSync(fd,out,offset,ID_ENTRY-offset,null);if(!size){if(offset)throw new Error('Truncated fork ID run');return null;}offset+=size;}return out;}

/** External sorting has fixed 4096-record runs and at most 32 open readers.
 * Online carry levels cap even the list of pending runs (32-bit ordinals). */
class HashRuns{
  private buffer:Buffer[]=[];private levels:string[][]=[];private serial=0;
  constructor(private stage:string,private stats:ForkPrefixStats){}
  add(hash:Buffer,index:number){const entry=Buffer.alloc(ID_ENTRY);hash.copy(entry);entry.writeUInt32LE(index,32);this.buffer.push(entry);
    this.stats.maxBufferedIds=Math.max(this.stats.maxBufferedIds,this.buffer.length);if(this.buffer.length===RUN_SIZE)this.flush();}
  private next(){return path.join(this.stage,`ids-${this.serial++}.bin`);}
  private carry(file:string,level=0):void{const pending=this.levels[level]??=[];pending.push(file);if(pending.length===FAN_IN){this.levels[level]=[];this.carry(this.merge(pending),level+1);}}
  private flush():void{if(!this.buffer.length)return;this.buffer.sort((a,b)=>Buffer.compare(a.subarray(0,32),b.subarray(0,32)));const file=this.next(),fd=fs.openSync(file,'wx');
    try{let previous:Buffer|undefined;for(const entry of this.buffer){if(previous?.equals(entry.subarray(0,32)))throw new Error('Duplicate fork message ID');write(fd,entry);previous=entry.subarray(0,32);}}finally{fs.closeSync(fd);}
    this.buffer=[];this.carry(file);}
  private merge(inputs:string[]):string{this.stats.maxMergeReaders=Math.max(this.stats.maxMergeReaders,inputs.length);const output=this.next(),out=fs.openSync(output,'wx'),fds:number[]=[];
    try{for(const file of inputs)fds.push(fs.openSync(file,'r'));const heads=fds.map(fd=>record(fd));let previous:Buffer|undefined;
      for(;;){let chosen=-1;for(let index=0;index<heads.length;index++)if(heads[index]&&(chosen<0||Buffer.compare(heads[index]!.subarray(0,32),heads[chosen]!.subarray(0,32))<0))chosen=index;
        if(chosen<0)break;const entry=heads[chosen]!;if(previous?.equals(entry.subarray(0,32)))throw new Error('Duplicate fork message ID');write(out,entry);previous=Buffer.from(entry.subarray(0,32));heads[chosen]=record(fds[chosen]);}
    }finally{for(const fd of fds)fs.closeSync(fd);fs.closeSync(out);}
    for(const file of inputs)fs.unlinkSync(file);return output;}
  finish():string{this.flush();let pending=this.levels.flat();if(!pending.length){const empty=this.next();fs.closeSync(fs.openSync(empty,'wx'));return empty;}
    while(pending.length>1){const next:string[]=[];for(let index=0;index<pending.length;index+=FAN_IN){const group=pending.slice(index,index+FAN_IN);next.push(group.length===1?group[0]:this.merge(group));}pending=next;}return pending[0];}
}

/** Write a fresh semantic GUI branch without an adapter's full projection,
 * another message array, a whole JSON string, or an all-ID in-memory sort. */
export async function writeGuiForkPrefix(userDataRoot:string,sessionId:string,messages:Iterable<GuiChatMessage>,options:{factory?:SessionLogFactory;liveThinkingOnly?:boolean;assertCurrent?:()=>void;stats?:ForkPrefixStats}={}):Promise<void>{
  if(!/^[a-zA-Z0-9_-]+$/.test(sessionId)||sessionId.length>160)throw new Error('Invalid GUI fork session ID');
  const checkpointDir=userDataStorage(userDataRoot).resolve('app', 'agent-sessions'),eventDir=userDataStorage(userDataRoot).resolve('app', 'agent-session-events');
  fs.mkdirSync(checkpointDir,{recursive:true});fs.mkdirSync(eventDir,{recursive:true});
  const checkpoint=path.join(checkpointDir,`${sessionId}.json`),events=path.join(eventDir,`${sessionId}.ndjson`),index=`${checkpoint}.ranges`;
  if(fs.existsSync(checkpoint)||fs.existsSync(index)||fs.existsSync(guiMetadataRangeIndexPath(checkpoint)))throw new Error('GUI fork target already exists');
  const stage=fs.mkdtempSync(path.join(checkpointDir,`.${sessionId}.prefix-`));
  const stats=options.stats??{maxBufferedIds:0,maxMergeReaders:0,messages:0};
  const ordinals=path.join(stage,'ordinals.bin'),jsonFile=path.join(stage,'checkpoint.json'),rangeFile=path.join(stage,'index.bin');
  let log:SessionLogHandle|undefined,eventsOwned=false,checkpointOwned=false,indexOwned=false,metadataOwned=false;
  Object.assign(stats,{maxBufferedIds:0,maxMergeReaders:0,messages:0});
  try{
    fs.closeSync(fs.openSync(events,'wx'));eventsOwned=true;
    log=options.factory?.openSync('gui',sessionId)??new SessionEventLog(eventDir,sessionId);
    const json=fs.openSync(jsonFile,'wx'),ordinal=fs.openSync(ordinals,'wx'),runs=new HashRuns(stage,stats),checksum=createHash('sha256');
    let position=0,count=0,lastEventId='';
    const append=(text:string)=>{const bytes=Buffer.from(text);write(json,bytes);position+=bytes.length;};
    try{
      append('{"version":2,"messages":[');checksum.update('{"messages":[');
      for(const original of messages){options.assertCurrent?.();if(count===MAX_COUNT)throw new Error('GUI fork has too many messages');
        const message=options.liveThinkingOnly?withoutDisplayThinking([original])[0]:original;
        if(!message||typeof message.id!=='string'||!message.id)throw new Error('Invalid GUI fork message ID');
        const text=JSON.stringify(message),bytes=Buffer.from(text);if(count){append(',');checksum.update(',');}
        const row=Buffer.alloc(ORDINAL),hash=createHash('sha256').update(message.id).digest();
        if(!Number.isSafeInteger(position+bytes.length))throw new Error('GUI fork checkpoint exceeds safe byte offsets');
        row.writeDoubleLE(position,0);row.writeDoubleLE(bytes.length,8);hash.copy(row,16);write(ordinal,row);runs.add(hash,count);
        write(json,bytes);position+=bytes.length;checksum.update(bytes);
        lastEventId=randomUUID();
        const event:EventEnvelope={eventId:lastEventId,sessionId,seq:0,type:'gui-session.messages',schemaVersion:1,createdAt:Date.now(),
          payload:{kind:'messages',upsert:[JSON.parse(text)],metadata},causationId:message.id,correlationId:`${sessionId}:${message.id}`};
        log.appendSync(event);count++;stats.messages=count;
        if(count%128===0)await log.flush('fork-prefix-batch');
      }
      checksum.update('],"lastUsage":null,"injections":[],"compactions":[]}');
      const digest=checksum.digest('hex');
      append('],"lastUsage":null,"injections":[],"compactions":[]'+(count?`,"checkpoint":${JSON.stringify({version:1,lastAppliedSeq:count,lastEventId,checksum:digest})}`:'')+'}');
    }finally{fs.closeSync(json);fs.closeSync(ordinal);}
    await log.flush('fork-prefix-ready');options.assertCurrent?.();
    const lookup=runs.finish();
    publish(jsonFile,checkpoint,()=>{checkpointOwned=true;});
    writeEmptyGuiMetadataRangeIndex(checkpoint,events);metadataOwned=true;
    const envelope=Buffer.from(JSON.stringify({source:stamp(checkpoint),events:stamp(events),metadata:{...metadata,guiMetadataVersion:1}}));
    const header=Buffer.alloc(HEADER);Buffer.from('MSTRRNG1').copy(header);header.writeUInt32LE(envelope.length,8);header.writeUInt32LE(stats.messages,12);
    const out=fs.openSync(rangeFile,'wx');try{write(out,header);write(out,envelope);copy(ordinals,out);copy(lookup,out);}finally{fs.closeSync(out);}
    publish(rangeFile,index,()=>{indexOwned=true;});
    if(options.factory)await options.factory.release(sessionId,'gui');
  }catch(error){
    try{if(log){log.deleteSync();if(options.factory)await options.factory.release(sessionId,'gui');}}catch(cleanupError){console.error('[gui-fork] writer cleanup failed',cleanupError);}
    if(eventsOwned){fs.rmSync(events,{force:true});fs.rmSync(`${events}.index.json`,{force:true});}
    if(metadataOwned)fs.rmSync(guiMetadataRangeIndexPath(checkpoint),{force:true});
    if(checkpointOwned)fs.rmSync(checkpoint,{force:true});if(indexOwned)fs.rmSync(index,{force:true});
    throw error;
  }finally{
    if(path.dirname(path.resolve(stage))!==path.resolve(checkpointDir)||!path.basename(stage).startsWith(`.${sessionId}.prefix-`))throw new Error('Unsafe GUI fork staging cleanup');
    fs.rmSync(stage,{recursive:true,force:true});
  }
}
