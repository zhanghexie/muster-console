import {describe,expect,it,vi} from 'vitest';
import {findLatestSchedulerMessage,iterateSchedulerHistoryNewestFirst} from '../../src/main/agent/schedulerHistoryRead';
import {resolveChatHistoryWindow} from '../../src/shared/chatHistory';
import type {ChatMessage} from '../../src/shared/types';

describe('bounded scheduler tail consumers',()=>{
  it('finds the exact latest matching message across pages without full history',()=>{
    const messages:ChatMessage[]=Array.from({length:1000},(_,i)=>({id:String(i),role:i===5?'assistant':'user',content:i===5?'actual latest assistant':' ',createdAt:i}));
    const getHistoryRange=vi.fn((_workspaceId:string,before?:number,limit?:number)=>{
      expect(limit).toBeLessThanOrEqual(120);
      const {start,end}=resolveChatHistoryWindow(messages,before,limit);
      return {messages:messages.slice(start,end),before:start,total:messages.length,hasEarlier:start>0};
    });
    expect(findLatestSchedulerMessage({getHistoryRange},'workspace',message=>message.role==='assistant')?.id).toBe('5');
    expect(getHistoryRange).toHaveBeenCalledTimes(9);
    getHistoryRange.mockClear();
    expect(findLatestSchedulerMessage({getHistoryRange},'workspace',()=>true)?.id).toBe('999');
    expect(getHistoryRange).toHaveBeenCalledTimes(1);
  });
  it('rejects a nonadvancing cursor instead of hanging on corrupt range metadata',()=>{
    const getHistoryRange=()=>({messages:[],before:3,total:10,hasEarlier:true});
    expect(()=>Array.from(iterateSchedulerHistoryNewestFirst({getHistoryRange},'workspace'))).toThrow('cursor did not advance');
  });
});
