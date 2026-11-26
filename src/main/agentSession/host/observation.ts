import type { HostCore } from './internal';
import { observeReply } from '../../../shared/sessionObservation';
import { historyNewestFirst } from './historyRead';

/** Read only: no open/connect, provider lookup, repair or state mutation. */
export function observe(host: HostCore, sessionId: string) {
  const entry=host.entries.get(sessionId);
  let lastReply:ReturnType<typeof observeReply>=null;
  let updatedAt=entry?.messages.at(-1)?.ts;
  for(const message of historyNewestFirst(host,sessionId)){
    updatedAt??=message.ts;
    if(message.role!=='assistant'||message.id===entry?.assistant?.id)continue;
    const candidate=observeReply([message],entry?.assistant?.id);
    if(typeof message.finishedAt==='number'&&Number.isFinite(message.finishedAt)){lastReply=candidate;break;}
    if(!lastReply&&candidate)lastReply=candidate;
  }
  return {busy:entry?.busy??false,lastReply,
    retry:entry?.busy&&entry.assistant?.retryHint?{attempt:entry.turnRetryAttempt,message:entry.assistant.retryHint}:null,
    updatedAt:Math.max(updatedAt??0,lastReply?.finishedAt??0)};
}
