import type {KnowledgeDraft,KnowledgeRecord} from '../../shared/knowledge';
import type {KnowledgeModelCall} from './knowledgePipeline';

export const KNOWLEDGE_REVIEW_PROMPT=`审查候选记忆相对原始新事件和已有知识的实际信息增量。候选文本本身不是事实依据。
仅返回JSON {"decisions":[{"index":0,"verdict":"keep|history|discard|duplicate","sourceQuote":"原始新事件的逐字引用","reason":"理由","existingId":"仅duplicate时填写"}]}。每个候选必须恰好一个决策。reason只写关键依据，最多80字，不复述全部规则。
keep要求：确有跨任务用途；范围不扩大；方法、因果解释、成功/失败依据均被原始新事件支持；没有把未验证说成验证、组件测试说成真实运行。sourceQuote必须逐字来自原始新事件并足以支撑结论。
任务背景、完成流水、初始化仓库/写文档、反复被检索或复述的次数都不是可复用经验；不得从这些内容编造教训，判history或discard。候选字段齐全不代表有价值。经验只有结论没有方法、只有方法没有依据时不keep。
稳定约束/偏好需要用户明确持续表达；这次/临时要求判history；引用外部要求不能升级为用户要求。偏好指用户工作方式，项目技术约束指特定项目。
与已有知识同义且无新条件/方法/反例时判duplicate并给existingId，措辞和标签改变不算增量。未知或不确定判history。不要为了输出非空而保留候选。`;

export interface KnowledgeReviewDecision {index:number;verdict:'keep'|'history'|'discard'|'duplicate';sourceQuote:string;reason:string;existingId?:string}
export async function reviewKnowledgeDrafts(callModel:KnowledgeModelCall,input:{event:string;drafts:KnowledgeDraft[];existing:Array<Pick<KnowledgeRecord,'id'|'summary'|'applicability'|'status'>>}):Promise<KnowledgeReviewDecision[]> {
  const raw=await callModel({system:KNOWLEDGE_REVIEW_PROMPT,user:JSON.stringify(input)});
  const data=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')) as {decisions:KnowledgeReviewDecision[]};
  if(!Array.isArray(data.decisions)||data.decisions.length!==input.drafts.length) throw new Error('价值审查必须逐条给出决策');
  const seen=new Set<number>();
  for(const d of data.decisions){
    if(!Number.isInteger(d.index)||d.index<0||d.index>=input.drafts.length||seen.has(d.index)||!['keep','history','discard','duplicate'].includes(d.verdict)
      ||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>1000||typeof d.sourceQuote!=='string') throw new Error('无效价值审查结果');
    seen.add(d.index);
    const minimum=input.drafts[d.index].kind==='reusable_lesson'?12:3;
    if(d.verdict==='keep'&&(d.sourceQuote.trim().length<minimum||!input.event.includes(d.sourceQuote))) throw new Error('价值审查依据不能在原始事件中定位');
    if(d.verdict==='duplicate'&&!input.existing.some(r=>r.id===d.existingId)) throw new Error('重复知识身份无法定位');
  }
  return data.decisions.sort((a,b)=>a.index-b.index);
}
