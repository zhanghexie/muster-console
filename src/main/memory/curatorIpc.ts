import type {AppContext} from '../context';
import {handle as registerIpc,type IpcHandler} from '../ipc/handle';
import {memoryCurator,bindMemoryCurator} from './curatorBindings';
import {localizeKnowledgeUserError} from './knowledgeUserErrors';

function handle<T extends IpcHandler>(channel:string,fn:T):void{
  registerIpc(channel,(event,...args)=>{
    try{const result=fn(event,...args);return result instanceof Promise?result.catch(localizeKnowledgeUserError):result;}
    catch(error){return localizeKnowledgeUserError(error);}
  });
}

export function registerMemoryCuratorIpc(ctx:AppContext):void{
  bindMemoryCurator(ctx);
  handle('memoryCurator:state',(_event,workspaceId:string)=>memoryCurator(ctx,workspaceId).snapshot());
  handle('memoryCurator:inspect',(_event,workspaceId:string,input?:import('../../shared/memoryCurator').MemoryCuratorQueueQuery)=>memoryCurator(ctx,workspaceId).inspect(input));
  handle('memoryCurator:setArchived',(_event,workspaceId:string,candidateId:string,archived:boolean)=>{
    if(typeof candidateId!=='string'||!candidateId.trim()||candidateId.length>500)throw new Error('无效整理记录ID');
    if(typeof archived!=='boolean')throw new Error('无效整理记录归档状态');
    return memoryCurator(ctx,workspaceId).setArchived(candidateId,archived);
  });
  handle('memoryCurator:send',(_event,workspaceId:string,text:string)=>{
    if(typeof text!=='string'||!text.trim()||text.length>6000)throw new Error('记忆消息需为1到6000字符');
    return memoryCurator(ctx,workspaceId).send(text);
  });
  handle('memoryCurator:setPaused',(_event,workspaceId:string,paused:boolean)=>{
    if(typeof paused!=='boolean')throw new Error('无效暂停状态');return memoryCurator(ctx,workspaceId).setPaused(paused);
  });
  handle('memoryCurator:clear',(_event,workspaceId:string)=>memoryCurator(ctx,workspaceId).clear());
}
