import type {GuiChatMessage} from '../../../shared/guiWorker';
import type {HostCore} from './internal';

/** Retain only a requested page when a visible session has no execution entry. */
export function* historyNewestFirst(host:HostCore,sessionId:string):IterableIterator<GuiChatMessage> {
  const entry=host.entries.get(sessionId);
  if(entry){for(let index=entry.messages.length-1;index>=0;index--)yield entry.messages[index];return;}
  let before:number|undefined;
  for(;;){
    const page=host.store.loadRangeSnapshot(sessionId,before,120);
    for(let index=page.messages.length-1;index>=0;index--)yield page.messages[index];
    if(!page.hasEarlier)return;
    if(!Number.isSafeInteger(page.before)||page.before<0||(before!==undefined&&page.before>=before))throw new Error('GUI history cursor did not advance');
    before=page.before;
  }
}
