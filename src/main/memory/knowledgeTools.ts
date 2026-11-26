import {createHash} from 'node:crypto';
import {isSchedulerInvocation,currentAgentSessionId} from '../agent/agentScope';
import {currentMemoryTurn,currentTurnUserText,isCurrentTurnNetworkTainted,isHeadlessTurn} from '../agent/turnScope';
import {hasExplicitRememberInstruction,looksLikeUserProfileDirective} from './provenance';
import type {MemoryService} from './service';
import type {KnowledgeModelCall} from './knowledgePipeline';
import type {MemoryCorrectionInput,MemoryCuratorCandidate,MemoryCuratorReceipt} from '../../shared/memoryCurator';
import type {KnowledgeRecord} from '../../shared/knowledge';
import {redactCredentialShapes} from './redact';
import {t} from '../../shared/i18n';
import {enqueueMemoryCandidate} from './curatorRef';
import {captureMemoryEnvironment} from './environment';

export function normalizeMemorySearchKeys(raw:unknown):string[] {
  if(!Array.isArray(raw)||raw.length<1||raw.length>12||raw.some(key=>typeof key!=='string'||!key.trim()||key.length>300))
    throw new Error(t('searchKeys 必须包含1至12个非空检索词，每项最多300字符'));
  return [...new Set(raw.map(key=>redactCredentialShapes(key).text.trim()))];
}

function submitCandidate(svc:MemoryService,root:string,text:string,scope:{repoKey:string;branch?:string}|undefined,explicit:boolean,searchKeys:unknown,environmentKeys?:unknown):MemoryCuratorReceipt & {eventId:string} {
  const turn=currentMemoryTurn();
  if(!turn||isHeadlessTurn())throw new Error('当前调用缺少可追溯的交互轮次，不能写入记忆');
  const original=currentTurnUserText();
  if(explicit&&(!original||!hasExplicitRememberInstruction(original)||isCurrentTurnNetworkTainted()))throw new Error('需要本轮用户明确要求记住，并有可信的原始输入');
  const safe=redactCredentialShapes(text).text.trim();
  if(!safe||safe.length>6000)throw new Error('记忆候选需为1到6000字符');
  const keys=normalizeMemorySearchKeys(searchKeys);
  const environment=captureMemoryEnvironment(environmentKeys);
  const source=redactCredentialShapes(original??'').text;
  if(source.length>24000)throw new Error('用户原始输入超过记忆候选上限');
  const eventId=`${explicit?'remember':'note'}:${turn.eventId}`;
  const id=`${eventId}:${createHash('sha256').update(JSON.stringify([safe,keys,environment])).digest('hex').slice(0,20)}`;
  const namespace=explicit&&looksLikeUserProfileDirective(source)?'profile':isSchedulerInvocation()?'scheduler':'worker';
  const candidate:MemoryCuratorCandidate={id,eventId,namespace,
    origin:isCurrentTurnNetworkTainted()?'untrusted':explicit?'user':isSchedulerInvocation()?'scheduler':'worker',
    text:safe,searchKeys:keys,environment,sourceText:source,explicit,createdAt:turn.startedAt,
    repoKey:namespace==='profile'?undefined:scope?.repoKey??root,branch:namespace==='profile'?undefined:scope?.branch,
    evidence:[{id:eventId,source:explicit?'user-explicit':'memory.note',eventTime:turn.startedAt,
      sessionId:turn.sessionId??currentAgentSessionId(),verification:explicit?'user_confirmed':'unverified'}]};
  return {...enqueueMemoryCandidate(svc,root,candidate),eventId};
}
/** Optional, low-frequency producer. Only the dedicated Pi session decides what is retained. */
export function noteKnowledge(svc:MemoryService,root:string,text:string,scope:{repoKey:string;branch?:string}|undefined,searchKeys:unknown,environmentKeys?:unknown):MemoryCuratorReceipt & {eventId:string} {
  return submitCandidate(svc,root,text,scope,false,searchKeys,environmentKeys);
}
/** Original-user authority remains host-owned; acceptance is not a completed write. */
export async function rememberKnowledge(svc:MemoryService,root:string,text:string,_legacyModel:KnowledgeModelCall|undefined,scope:{repoKey:string;branch?:string}|undefined,searchKeys:unknown):Promise<MemoryCuratorReceipt & {eventId:string}> {
  return submitCandidate(svc,root,text,scope,true,searchKeys);
}

/** A report proposes review of one current version; model hints never become source evidence. */
export function correctKnowledge(svc:MemoryService,root:string,input:MemoryCorrectionInput,target:KnowledgeRecord,requesterSessionId:string):MemoryCuratorReceipt & {requestId:string;eventId:string} {
  const turn=currentMemoryTurn();
  if(!turn||isHeadlessTurn()||isCurrentTurnNetworkTainted()!==false)throw new Error('纠错需要可追溯、可信的宿主轮次');
  const actor=currentAgentSessionId();
  if(!requesterSessionId||(!isSchedulerInvocation()&&actor!==requesterSessionId)||turn.sessionId&&turn.sessionId!==requesterSessionId)throw new Error('纠错来源会话不匹配');
  if(input.memoryId!==target.id||input.revision!==target.revision)throw new Error('目标知识版本已变化，请重新检索');
  const field=(value:unknown,name:string,max:number,optional=false)=>{
    if(optional&&value===undefined)return undefined;
    if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${name} 需为1到${max}字符`);
    return redactCredentialShapes(value).text.trim();
  };
  const correction:MemoryCorrectionInput={memoryId:target.id,revision:target.revision,
    problem:field(input.problem,'problem',1500)!,evidence:field(input.evidence,'evidence',2500)!,suggestion:field(input.suggestion,'suggestion',1500,true)};
  const original=redactCredentialShapes(currentTurnUserText()??'').text;
  if(original.length>24000)throw new Error('用户原始输入超过记忆候选上限');
  const text=JSON.stringify(correction),eventId=`correct:${turn.eventId}`;
  const id=`${eventId}:${createHash('sha256').update(text).digest('hex').slice(0,20)}`;
  const candidate:MemoryCuratorCandidate={id,eventId,namespace:target.namespace,
    origin:isSchedulerInvocation()?'scheduler':'worker',text,sourceText:original,explicit:false,createdAt:turn.startedAt,
    repoKey:target.repoKey,branch:target.branch,correction,requesterSessionId,
    evidence:[{id:eventId,source:'memory.correct',eventTime:turn.startedAt,sessionId:requesterSessionId,verification:'unverified'}]};
  const receipt=enqueueMemoryCandidate(svc,root,candidate);
  return {...receipt,requestId:receipt.candidateId,eventId};
}
