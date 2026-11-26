import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeTextAtomicSync} from '../atomicJson';
import type {GuiNativeForkPoint} from './types';
function directoryFor(root:string,sessionId:string):string{
  if(!/^[a-zA-Z0-9_-]+$/.test(sessionId)||sessionId.length>160)throw new Error('Invalid native fork owner');
  const directory=path.join(root,sessionId);
  if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw new Error('Invalid native fork directory');
  return directory;
}
function fileFor(root:string,sessionId:string,messageId:string):string{
  if(!messageId||messageId.length>512||/[\x00-\x1f]/.test(messageId))throw new Error('Invalid native fork message ID');
  return path.join(directoryFor(root,sessionId),`${createHash('sha256').update(messageId).digest('hex')}.json`);
}
function validPoint(point:GuiNativeForkPoint):boolean{
  const valid=(value:unknown)=>typeof value==='string'&&!!value&&value.length<=512&&!/[\x00-\x1f]/.test(value);
  return !!point&&['pi','pi-external','omp','claude','codex','opencode'].includes(point.engine)&&['user','assistant'].includes(point.role)&&valid(point.sessionToken)&&valid(point.entryId);
}
export function saveNativeForkPoint(root:string,sessionId:string,messageId:string,point:GuiNativeForkPoint):void{
  const file=fileFor(root,sessionId,messageId);if(!validPoint(point))throw new Error('Invalid native fork point');
  writeTextAtomicSync(file,JSON.stringify({version:1,sessionId,messageId,point}),{mode:0o600});
}
export function loadNativeForkPoint(root:string,sessionId:string,messageId:string):GuiNativeForkPoint|undefined{
  const file=fileFor(root,sessionId,messageId);let fd:number;
  try{const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('Invalid native fork point file');fd=fs.openSync(file,'r');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  try{const size=fs.fstatSync(fd).size;if(size<1||size>4096)throw new Error('Invalid native fork point size');
    const bytes=Buffer.alloc(size);let offset=0;while(offset<size){const count=fs.readSync(fd,bytes,offset,size-offset,offset);if(!count)throw new Error('Truncated native fork point');offset+=count;}
    const value=JSON.parse(bytes.toString('utf8')) as {version:number;sessionId:string;messageId:string;point:GuiNativeForkPoint};
    if(value.version!==1||value.sessionId!==sessionId||value.messageId!==messageId||!validPoint(value.point))throw new Error('Invalid native fork point');return value.point;
  }finally{fs.closeSync(fd);}
}
export function removeNativeForkPoints(root:string,sessionId:string):void{
  const directory=directoryFor(root,sessionId);
  if(path.dirname(path.resolve(directory))!==path.resolve(root))throw new Error('Unsafe native fork cleanup');
  fs.rmSync(directory,{recursive:true,force:true});
}
