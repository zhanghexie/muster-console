import type {HostCore} from './internal';
const archives=new WeakMap<HostCore,Map<string,Promise<void>>>();
export function archiveOperationFor(host:HostCore,id:string):Promise<void>|undefined{return archives.get(host)?.get(id);}
export function archiveSessionIds(host:HostCore):Iterable<string>{return archives.get(host)?.keys()??[];}
export function ownArchiveOperation(host:HostCore,id:string,operation:()=>Promise<void>):Promise<void>{
  let map=archives.get(host);if(!map){map=new Map();archives.set(host,map);}
  const existing=map.get(id);if(existing)return existing;
  let resolve!:()=>void,reject!:(error:unknown)=>void;
  const pending=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});
  map.set(id,pending);
  try{Promise.resolve(operation()).then(resolve,reject);}catch(error){reject(error);}
  void pending.finally(()=>{if(map?.get(id)===pending)map.delete(id);}).catch(()=>{});
  return pending;
}
