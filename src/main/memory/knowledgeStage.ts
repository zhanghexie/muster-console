export interface KnowledgeStagePolicy {timeoutMs:number;maxAttempts:number;backoffMs:number}
export const KNOWLEDGE_STAGE_POLICY:KnowledgeStagePolicy={timeoutMs:90_000,maxAttempts:2,backoffMs:1_000};
export interface KnowledgeStageTiming {stage:string;attempt:number;elapsedMs:number;outcome:'success'|'failed';error?:string}
class StageTimeout extends Error {}
function transient(error:unknown):boolean {
  return error instanceof StageTimeout || /^(?:巩固 LLM (?:408|429|5\d\d)\b|fetch failed$|(?:Error: )?(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|network error$)/i.test(String((error as Error)?.message??error));
}
/** Each attempt owns its abort signal; late results cannot escape the race. */
export async function runKnowledgeStage<T>(stage:string,operation:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal,
  report:(timing:KnowledgeStageTiming)=>void,policy:KnowledgeStagePolicy=KNOWLEDGE_STAGE_POLICY):Promise<T> {
  for(let attempt=1;attempt<=policy.maxAttempts;attempt++){
    signal.throwIfAborted();
    const controller=new AbortController(),started=Date.now();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let cancel=()=>{};
    try{
      const interrupted=new Promise<never>((_,reject)=>{
        cancel=()=>{reject(signal.reason??new Error('记忆处理已停止'));controller.abort();};
        signal.addEventListener('abort',cancel,{once:true});
        timer=setTimeout(()=>{reject(new StageTimeout(`${stage}超时（单次上限 ${policy.timeoutMs/1000} 秒）`));controller.abort();},policy.timeoutMs);
      });
      const result=await Promise.race([interrupted,Promise.resolve().then(()=>{controller.signal.throwIfAborted();return operation(controller.signal);})]);
      signal.throwIfAborted();
      report({stage,attempt,elapsedMs:Date.now()-started,outcome:'success'});
      return result;
    }catch(error){
      if(signal.aborted)throw error;
      const message=String((error as Error)?.message??error);
      report({stage,attempt,elapsedMs:Date.now()-started,outcome:'failed',error:message});
      if(attempt===policy.maxAttempts||!transient(error))throw new Error(`${stage}失败（尝试 ${attempt} 次，本次 ${Date.now()-started}ms）：${message}`);
    }finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',cancel);controller.abort();}
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(wait);reject(signal.reason);};
      const wait=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},policy.backoffMs*attempt);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    });
  }
  throw new Error('无效记忆重试配置');
}
