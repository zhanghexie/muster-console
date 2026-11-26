import type {HostCore} from './internal';
const locks=new WeakMap<HostCore,Set<string>>();
export function assertNoColdFork(host:HostCore,sessionId:string):void{if(locks.get(host)?.has(sessionId))throw new Error('会话正在分叉，请稍后再试');}
export function lockForkSource(host:HostCore,sessionId:string):()=>void{
  let set=locks.get(host);if(!set){set=new Set();locks.set(host,set);}if(set.has(sessionId))throw new Error('会话正在分叉，请稍后再试');
  set.add(sessionId);return()=>{set?.delete(sessionId);};
}
