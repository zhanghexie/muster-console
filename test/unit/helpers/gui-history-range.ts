import type {ApiMock} from './api-mock';
import {resolveChatHistoryWindow} from '../../../src/shared/chatHistory';
import type {GuiWorkerHistory} from '../../../src/shared/guiWorker';

/** Small test snapshots model a backend; the component receives only its
 * requested page. This does not install or call the retired full-history API. */
export function overrideGuiHistory(api:ApiMock,read:(id:string)=>unknown):void{
  api.override('agentSession.historyRange',async(id:string,before?:number,limit=120,target?:string)=>{
    const value=await read(id) as GuiWorkerHistory|null|undefined;
    if(!value||!Array.isArray(value.messages))return value;
    const {start,end}=resolveChatHistoryWindow(value.messages,before,limit,target);
    return {...value,messages:value.messages.slice(start,end),before:start,total:value.messages.length,hasEarlier:start>0};
  });
}
