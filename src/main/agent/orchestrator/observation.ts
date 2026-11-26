import type { OrchestratorHost } from './internal';
import type { ChatMessage } from '../../../shared/types';
import { observeSchedulerReply } from '../../../shared/sessionObservation';
import { iterateSchedulerHistoryNewestFirst } from '../schedulerHistoryRead';
import { getColdHistoryRange } from './buckets';

function* newestFirst(messages: readonly ChatMessage[]): IterableIterator<ChatMessage> {
  for(let index=messages.length-1;index>=0;index--)yield messages[index];
}

/** Preserve the shared contract: prefer the latest settled reply, with the
 * latest legacy fragment only as a fallback if no settled reply exists. */
function latestReply(messages:Iterable<ChatMessage>,activeMessageId?:string):ReturnType<typeof observeSchedulerReply> {
  let legacy:ReturnType<typeof observeSchedulerReply>=null;
  for(const message of messages) {
    if(message.local||message.role!=='assistant'||message.id===activeMessageId)continue;
    const reply=observeSchedulerReply([message],activeMessageId);
    if(typeof message.finishedAt==='number'&&Number.isFinite(message.finishedAt))return reply;
    if(!legacy&&reply)legacy=reply;
  }
  return legacy;
}

/** Never ensure a bucket, restore a queue or create a provider connection. */
export function observeScheduler(o: Pick<OrchestratorHost, 'ctx' | 'buckets'>, workspaceId: string, includeReply: boolean) {
  const bucket=o.buckets.get(workspaceId);
  if(bucket) {
    const lastReply=includeReply?latestReply(newestFirst(bucket.display),bucket.streamingAssistant?.id):null;
    return {busy:bucket.busy,createdAt:bucket.display[0]?.createdAt??0,
      updatedAt:Math.max(bucket.display.at(-1)?.createdAt??0,lastReply?.finishedAt??0),lastReply};
  }
  if(!includeReply)return {busy:false,createdAt:0,updatedAt:0,lastReply:null};
  const tail=getColdHistoryRange(o,workspaceId);
  const reader={getHistoryRange:(_workspaceId:string,before?:number,limit?:number)=>
    before===undefined?tail:getColdHistoryRange(o,workspaceId,before,limit)};
  const lastReply=latestReply(iterateSchedulerHistoryNewestFirst(reader,workspaceId));
  const first=tail.hasEarlier?getColdHistoryRange(o,workspaceId,1,1).messages[0]:tail.messages[0];
  return {busy:false,createdAt:first?.createdAt??0,
    updatedAt:Math.max(tail.messages.at(-1)?.createdAt??0,lastReply?.finishedAt??0),lastReply};
}
