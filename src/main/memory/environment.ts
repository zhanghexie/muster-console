import type {KnowledgeEnvironmentCheck,KnowledgeEnvironmentDependency,KnowledgeEnvironmentKey,KnowledgeRecord} from '../../shared/knowledge';

export const MEMORY_ENVIRONMENT_KEYS:readonly KnowledgeEnvironmentKey[]=['appVersion','executorResultMaxChars','mcpCallResultMaxChars','mcpHubMaxChars'];
let provider:(()=>Partial<Record<KnowledgeEnvironmentKey,string>>)|undefined;
/** Installed by the host at boot; no dependency value is accepted from a model. */
export function setMemoryEnvironmentProvider(value:(()=>Partial<Record<KnowledgeEnvironmentKey,string>>)|undefined):void {provider=value;}
export function captureMemoryEnvironment(keys:unknown):KnowledgeEnvironmentDependency[]|undefined {
  if(keys===undefined)return undefined;
  if(!Array.isArray(keys)||keys.length>MEMORY_ENVIRONMENT_KEYS.length||keys.some(key=>typeof key!=='string'||!MEMORY_ENVIRONMENT_KEYS.includes(key as KnowledgeEnvironmentKey)))throw new Error('未知环境依赖，必须选择宿主支持的参数');
  const values=provider?.()??{};
  return [...new Set(keys as KnowledgeEnvironmentKey[])].sort().map(key=>{
    const value=values[key];if(typeof value!=='string'||!value||value.length>200)throw new Error(`当前环境参数不可用：${key}`);
    return {key,value};
  });
}
export function checkMemoryEnvironment(record:Pick<KnowledgeRecord,'environment'|'summary'|'problem'|'action'|'rationale'|'applicability'|'exceptions'|'expectedFutureUse'|'searchKeys'>):KnowledgeEnvironmentCheck|undefined {
  if(!record.environment?.length){
    const text=[record.summary,record.problem,record.action,record.rationale,record.expectedFutureUse,...record.applicability,...(record.exceptions??[]),...(record.searchKeys??[])].join(' ');
    return /MCP_CALL_RESULT_MAX_CHARS|MCP_RESULT_MAX_CHARS|RESULT_MAX_CHARS|executor\s*12000|hub\s*20k/i.test(text)?{state:'untracked',dependencies:[]}:undefined;
  }
  const current=provider?.()??{};
  const dependencies=record.environment.map(({key,value})=>({key,recorded:value,current:current[key]}));
  const state=dependencies.some(item=>item.current!==undefined&&item.current!==item.recorded)?'stale':dependencies.some(item=>item.current===undefined)?'unknown':'current';
  return {state,dependencies};
}
