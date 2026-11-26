/** Host-only signals. Provider messages or model prose cannot create this retry capability. */
export class CuratorBudgetError extends Error {
  constructor(readonly kind:'requests'|'context'|'time') {
    super(kind==='requests'?'记忆会话模型调用预算已用尽':kind==='context'?'记忆会话上下文预算已用尽':'本轮记忆处理时间预算已用尽');
    this.name='CuratorBudgetError';
  }
}
export const curatorRequestLimit=(value:number|undefined):number=>Number.isFinite(value)?Math.max(1,Math.min(64,Math.floor(value!))):32;
export const CURATOR_EVIDENCE_LIMITS={reads:24,perRead:8192,total:131072,source:1_048_576} as const;
/** One conservative character per token, with explicit output/protocol reserves. */
export function curatorContextBudget(model?:{contextWindow?:number;maxTokens?:number}):{
  contextWindow:number;outputTokens:number;inputCharacters:number;rotateCharacters:number
} {
  const contextWindow=Number.isSafeInteger(model?.contextWindow)&&model!.contextWindow!>0?model!.contextWindow!:128_000;
  const requestedOutput=Number.isSafeInteger(model?.maxTokens)&&model!.maxTokens!>0?model!.maxTokens!:8192;
  const outputTokens=Math.max(1,Math.min(8192,requestedOutput,Math.floor(contextWindow*0.25)));
  const protocolTokens=Math.max(1,Math.min(2048,Math.floor(contextWindow*0.05)));
  const inputCharacters=Math.max(1,Math.floor(Math.max(1,contextWindow-outputTokens-protocolTokens)*0.75));
  return {contextWindow,outputTokens,inputCharacters,rotateCharacters:Math.max(1,Math.floor(inputCharacters*0.8))};
}
