import type {GuiChatMessage} from '../../shared/guiWorker';
import type {KnowledgeSourceEvent} from './knowledgePipeline';
import {isNetworkSourceTool} from './provenance';

/** Uses immutable message IDs, never the user's repeated wording as a version key. */
export function guiKnowledgeEvents(input:{sessionId:string;repoKey:string;taskId?:string;messages:ReadonlyArray<GuiChatMessage>;startedAt:number}):KnowledgeSourceEvent[] {
  const events:KnowledgeSourceEvent[]=[];
  let request='';
  let userTurn=false;
  for(let index=0;index<input.messages.length;index++){
    const message=input.messages[index];
    const text=message.parts.filter(p=>p.kind==='text').map(p=>'text' in p?p.text:'').join('\n').trim();
    if(message.role==='user'){request=text;userTurn=!message.host&&!message.source&&message.steering!=='host';}
    if(message.ts<input.startedAt||message.queued||message.aborted||message.error||message.turnChanges?.state==='collecting'||!text) continue;
    if(!userTurn) continue;
    const next=input.messages[index+1];
    if(message.role==='user'&&next?.role==='assistant'&&next.turnChanges?.state==='collecting')continue;
    const tainted=message.parts.some(p=>p.kind==='tool'&&isNetworkSourceTool(p.tool.name));
    const id=`gui:${input.sessionId}:${message.id}`;
    const snapshot=message.turnChanges?.state==='ready'?message.turnChanges.id:undefined;
    const repository=snapshot?message.turnChanges?.repository:message.role==='user'&&next?.role==='assistant'&&next.turnChanges?.state==='ready'?next.turnChanges.repository:undefined;
    const content=message.role==='user'?`用户原始输入：\n${text}`:`本轮用户要求（仅作背景，不从中重复提取）：\n${request}\n本轮助手结论（未核实，不能声称真实运行通过）：\n${text}`;
    // Do not silently truncate a conclusion or invent a new segmentation identity.
    if(content.length>24000) throw new Error(`记忆事件 ${message.id} 超过提取上限，需按真实片段处理`);
    events.push({id,text:content,namespace:'worker',origin:tainted?'untrusted':message.role==='user'?'user':'worker',
      repoKey:repository?.scopeStable?repository.root:input.repoKey,branch:repository?.scopeStable?repository.branch??undefined:undefined,taskId:input.taskId,
      evidence:{id,source:'gui-session',eventTime:message.ts,sessionId:input.sessionId,turnId:message.id,
        snapshotId:snapshot,repoKey:repository?.root,branch:repository?.branch??undefined,verification:'unverified'}});
  }
  return events;
}
