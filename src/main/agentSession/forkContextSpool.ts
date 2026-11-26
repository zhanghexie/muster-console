import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {GuiSeedMessage} from './types';

export type ForkContextSpool={version:1;ownerSessionId:string;name:string;count:number;sha256:string};
const ownerPattern=/^[a-zA-Z0-9_-]+$/;
function fileFor(directory:string,owner:string):string{
  if(!ownerPattern.test(owner)||owner.length>160)throw new Error('Invalid fork context owner');
  return path.join(directory,`${owner}.seeds.ndjson`);
}
function validateSeed(value:unknown):asserts value is GuiSeedMessage{
  const seed=value as GuiSeedMessage;
  if(!seed||!['user','assistant'].includes(seed.role)||typeof seed.text!=='string'||!Number.isFinite(seed.ts))throw new Error('Invalid fork context seed');
}
function write(fd:number,bytes:Buffer):void{let offset=0;while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset);}

/** A small durable marker refers to this immutable body, rather than copying
 * every seed into each preparing/sending/unknown state transition. */
export function createForkContextSpool(directory:string,owner:string,seeds:Iterable<GuiSeedMessage>):ForkContextSpool{
  const file=fileFor(directory,owner);fs.mkdirSync(directory,{recursive:true});
  const temporary=`${file}.${randomUUID()}.tmp`;
  const fd=fs.openSync(temporary,'wx',0o600);let count=0;
  const hash=createHash('sha256');
  try{
    try{for(const seed of seeds){validateSeed(seed);if(++count>0xffffffff)throw new Error('Fork context has too many seeds');
      const bytes=Buffer.from(JSON.stringify(seed)+'\n');write(fd,bytes);hash.update(bytes);}}
    finally{fs.closeSync(fd);}
    // Same-directory hard-link publication is atomic and refuses replacement.
    // Never rename over another operation's immutable context body.
    fs.linkSync(temporary,file);
    return {version:1,ownerSessionId:owner,name:path.basename(file),count,sha256:hash.digest('hex')};
  }finally{fs.rmSync(temporary,{force:true});}
}

/** Verification completes before the consumer may publish a native archive or
 * send a transcript. Retained memory is one UTF-8 record, never all seeds. */
export function* readForkContextSpool(directory:string,owner:string,descriptor:ForkContextSpool):IterableIterator<GuiSeedMessage>{
  validateForkContextSpool(directory,owner,descriptor);
  const file=fileFor(directory,owner);
  const fd=fs.openSync(file,'r'),chunk=Buffer.allocUnsafe(64*1024),hash=createHash('sha256');
  let pending:Buffer<ArrayBufferLike>=Buffer.alloc(0),count=0;
  try{
    let size:number;
    while((size=fs.readSync(fd,chunk,0,chunk.length,null))>0){
      const bytes=chunk.subarray(0,size);hash.update(bytes);
      pending=(pending.length?Buffer.concat([pending,bytes]):Buffer.from(bytes)) as Buffer<ArrayBufferLike>;
      let newline:number;
      while((newline=pending.indexOf(10))>=0){
        const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);
        if(!line.length)throw new Error('Empty fork context record');
        const seed:unknown=JSON.parse(line.toString('utf8'));validateSeed(seed);
        if(++count>descriptor.count)throw new Error('Fork context count mismatch');
        yield seed;
      }
    }
    if(pending.length||count!==descriptor.count||hash.digest('hex')!==descriptor.sha256)throw new Error('Fork context integrity mismatch');
  }finally{fs.closeSync(fd);}
}

export function validateForkContextSpool(directory:string,owner:string,descriptor:ForkContextSpool):void{
  const file=fileFor(directory,owner);
  if(descriptor.version!==1||descriptor.ownerSessionId!==owner||descriptor.name!==path.basename(file)||
    !Number.isSafeInteger(descriptor.count)||descriptor.count<0||descriptor.count>0xffffffff||!/^[a-f0-9]{64}$/.test(descriptor.sha256))throw new Error('Invalid fork context descriptor');
  const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('Fork context is not a regular private file');
}

export function removeForkContextSpool(directory:string,owner:string):void{fs.rmSync(fileFor(directory,owner),{force:true});}
