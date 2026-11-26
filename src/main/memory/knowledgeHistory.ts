import { iterateSchedulerHistoryNewestFirst } from '../agent/schedulerHistoryRead';
import type {AppContext} from '../context';
import type {KnowledgeHistoryMessage,KnowledgeHistorySource} from '../../shared/knowledge';
import {KNOWLEDGE_HISTORY_TRUNCATION_NOTE} from '../../shared/knowledge';
import {redactCredentialShapes} from './redact';

/** Explicit read of original transcripts; never enqueues extraction or writes knowledge. */
export function knowledgeHistorySources(ctx:AppContext,workspaceId:string):KnowledgeHistorySource[] {
  if(!ctx.config.get().workspaces.some(w=>w.id===workspaceId))throw new Error('工作区不存在');
  const gui=ctx.sessions?.list().filter(s=>s.workspaceId===workspaceId&&s.runtime&&ctx.sessions.isChatRuntime(s.runtime))??[];
  return [...gui.map(s=>({id:s.id,name:s.name,namespace:'worker' as const})),...(ctx.orchestrator?[{id:'scheduler',name:'调度原始会话',namespace:'scheduler' as const}]:[])];
}
function* originalMessagesNewestFirst(ctx:AppContext,workspaceId:string,sessionId:string):IterableIterator<KnowledgeHistoryMessage> {
  if(sessionId==='scheduler') {
    if(ctx.orchestrator)for(const m of iterateSchedulerHistoryNewestFirst(ctx.orchestrator,workspaceId)) yield {
      id:m.id,role:m.role,text:m.content,at:m.createdAt,snapshotId:m.turnChanges?.state==='ready'?m.turnChanges.id:undefined,
      state:m.aborted?'已中止':m.error?'失败':'原始记录'};
    return;
  }
  let before:number|undefined;
  for(;;) {
    const page=ctx.agentSessions?.getHistoryRange(sessionId,before,120);
    if(!page)return;
    for(let index=page.messages.length-1;index>=0;index--) {
      const m=page.messages[index];
      yield {id:m.id,role:m.role,text:m.parts.filter(p=>p.kind==='text').map(p=>'text' in p?p.text:'').join('\n'),at:m.ts,
        snapshotId:m.turnChanges?.state==='ready'?m.turnChanges.id:undefined,state:m.aborted?'已中止':m.error?'失败':'原始记录'};
    }
    if(!page.hasEarlier)return;
    if(!Number.isSafeInteger(page.before)||page.before<0||(before!==undefined&&page.before>=before))throw new Error('GUI history cursor did not advance');
    before=page.before;
  }
}

export function readKnowledgeHistory(ctx:AppContext,workspaceId:string,input:{sessionId:string;query:string}):{messages:KnowledgeHistoryMessage[];truncated:boolean} {
  if(!input||typeof input.query!=='string'||input.query.length>500||!knowledgeHistorySources(ctx,workspaceId).some(s=>s.id===input.sessionId))throw new Error('历史来源不属于此工作区或查询无效');
  const query=input.query.trim().toLowerCase();
  const newest:KnowledgeHistoryMessage[]=[];
  let truncated=false;
  for(const message of originalMessagesNewestFirst(ctx,workspaceId,input.sessionId)) {
    if(query&&!message.text.toLowerCase().includes(query))continue;
    if(newest.length===50){truncated=true;break;}
    newest.push({...message,text:redactCredentialShapes(message.text.slice(0,4000)).text+(message.text.length>4000?`\n${KNOWLEDGE_HISTORY_TRUNCATION_NOTE}`:''),
      ...(message.text.length>4000?{textTruncated:true}:{})});
  }
  return {messages:newest.reverse(),truncated};
}
