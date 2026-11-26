import type {KnowledgeDraft} from '../../../shared/knowledge';
import {validateKnowledgeDraft} from '../knowledgePolicy';
import type {CuratorDecisionInput} from './storageTypes';

const lessonFields=['problem','action','rationale','expectedFutureUse'] as const;
export const CURATOR_LESSON_REQUIRED=['kind','summary','problem','action','rationale','applicability','exceptions','expectedFutureUse'];
export function validateCuratorDraft(raw:unknown,decision:CuratorDecisionInput['decision']):KnowledgeDraft {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('draft: 必须提供结构化记忆对象');
  const value=raw as Record<string,unknown>,errors:string[]=[];
  const longTerm=['save','duplicate','suspend','supersede'].includes(decision)&&value.kind==='reusable_lesson';
  if(!['task_fact','stable_constraint','user_preference','user_profile','reusable_lesson'].includes(String(value.kind)))errors.push('draft.kind: 必须为 task_fact、stable_constraint、user_preference、user_profile 或 reusable_lesson');
  for(const field of ['summary',...lessonFields]){
    const required=field==='summary'||longTerm,entry=value[field];
    if(entry==null){if(required)errors.push(`draft.${field}: 必须提供非空文本（最多1500字符）`);}
    else if(typeof entry!=='string'||entry.length>1500||required&&!entry.trim())errors.push(`draft.${field}: 必须为${required?'非空':''}文本，最多1500字符`);
  }
  for(const field of ['applicability','exceptions','searchKeys']){
    const entry=value[field],required=field==='applicability'||longTerm&&field==='exceptions';
    if(entry==null){if(required)errors.push(`draft.${field}: 必须提供字符串数组${field==='exceptions'?'（无已知例外时使用[]）':''}`);continue;}
    if(!Array.isArray(entry)){errors.push(`draft.${field}: 必须为字符串数组，最多12项`);continue;}
    if(entry.length>12)errors.push(`draft.${field}: 最多12项`);
    entry.forEach((item,index)=>{if(typeof item!=='string'||item.length>300||!item.trim())errors.push(`draft.${field}[${index}]: 必须为非空文本，最多300字符`);});
    if(longTerm&&field==='applicability'&&!entry.length)errors.push('draft.applicability: 可复用经验至少需要一条明确适用条件');
  }
  for(const [field,cap] of [['repoKey',500],['branch',300],['taskId',300]] as const){
    if(value[field]!=null&&(typeof value[field]!=='string'||value[field].length>cap))errors.push(`draft.${field}: 必须为文本，最多${cap}字符；实际写入范围仍由宿主绑定`);
  }
  if(value.expiresAt!=null&&(typeof value.expiresAt!=='number'||!Number.isFinite(value.expiresAt)))errors.push('draft.expiresAt: 必须为有限数值时间戳');
  if(errors.length)throw new Error(errors.join('\n'));
  try{return validateKnowledgeDraft(raw);}catch(error){throw new Error(`draft.${error instanceof Error?error.message:String(error)}`);}
}
