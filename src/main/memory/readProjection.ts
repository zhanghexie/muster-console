import type {KnowledgeRecord} from '../../shared/knowledge';
import {checkMemoryEnvironment} from './environment';

// Budget the actual executor envelope, including JSON escaping, rather than raw field lengths.
const ENVELOPE_BUDGET = 9000;
const length = (result:unknown):number => JSON.stringify({ok:true,result}).length;
const clip = (text:string, max:number):string => text.length > max ? `${text.slice(0,max)}…` : text;

export function evidenceSummary(record:KnowledgeRecord) {
  return {count:record.evidence.length,verification:[...new Set(record.evidence.map(item=>item.verification))],
    sources:[...new Set(record.evidence.map(item=>item.observation??item.source))].slice(0,8)};
}

export function compactKnowledge(record:KnowledgeRecord, branchNotice?:string, reason?:string) {
  const preview={id:record.id,namespace:record.namespace,revision:record.revision,userManaged:!!record.userManaged,
    kind:record.kind,summary:clip(record.summary,500),summaryTruncated:record.summary.length>500,branch:record.branch,branchNotice,
    applicability:record.applicability.slice(0,2).map(item=>clip(item,160)),
    exceptions:(record.exceptions??[]).slice(0,2).map(item=>clip(item,160)),
    conditionsTruncated:record.applicability.length>2||record.applicability.some(item=>item.length>160)
      ||(record.exceptions??[]).length>2||(record.exceptions??[]).some(item=>item.length>160),
    reason:reason?clip(reason,200):undefined,evidence:evidenceSummary(record),environmentCheck:checkMemoryEnvironment(record),detailAvailable:true};
  if(length(preview)<=3500)return preview;
  // Rare escape-heavy source names or conditions must not discard the entire page.
  return {id:record.id,namespace:record.namespace,revision:record.revision,userManaged:!!record.userManaged,kind:record.kind,
    summary:clip(record.summary,160),summaryTruncated:record.summary.length>160,conditionsTruncated:true,branchNoticeOmitted:!!branchNotice,
    evidence:{count:record.evidence.length,verification:[...new Set(record.evidence.map(item=>item.verification))],sourcesOmitted:true},
    environmentCheck:checkMemoryEnvironment(record),detailAvailable:true};
}

/** A page never skips an item merely because its metadata was too large. */
export function boundedPage<T,E extends Record<string,unknown>>(items:readonly T[], offset:number, limit:number, extra:E) {
  const entries:T[]=[];
  let index=offset;
  while(index<items.length && entries.length<limit){
    const candidate={...extra,entries:[...entries,items[index]],nextOffset:index+1<items.length?index+1:null};
    if(length(candidate)>ENVELOPE_BUDGET)break;
    entries.push(items[index]!);index++;
  }
  if(index===offset&&index<items.length)throw new Error('单条摘要超出结果预算，请通过精确 ID 读取');
  return {...extra,entries,nextOffset:index<items.length?index:null,truncated:index<items.length};
}

/** The original JSON can be reconstructed by concatenating pages of text in order. */
export function boundedTextPage(record:KnowledgeRecord, section:'details'|'evidence', offset:number, maxChars:number) {
  const {evidence,history,...details}=record;
  const content=JSON.stringify(section==='evidence'?evidence:{...details,history,environmentCheck:checkMemoryEnvironment(record)});
  return boundedRawTextPage(content,{id:record.id,namespace:record.namespace,revision:record.revision,section},offset,maxChars);
}

export function boundedRawTextPage(content:string, identity:Record<string,unknown>, offset:number, maxChars:number) {
  if(offset>content.length)throw new Error('offset 超出内容长度');
  const base={...identity,offset,totalChars:content.length};
  let lo=0,hi=Math.min(maxChars,content.length-offset);
  while(lo<hi){
    const mid=Math.ceil((lo+hi)/2);
    if(length({...base,text:content.slice(offset,offset+mid),nextOffset:offset+mid<content.length?offset+mid:null})<=ENVELOPE_BUDGET)lo=mid;
    else hi=mid-1;
  }
  if(lo===0&&offset<content.length)throw new Error('maxChars 不足以返回详情');
  return {...base,text:content.slice(offset,offset+lo),nextOffset:offset+lo<content.length?offset+lo:null};
}

export function pageInteger(value:unknown, fallback:number, max:number):number {
  if(value===undefined)return fallback;
  if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>max)throw new Error(`分页参数必须为0到${max}的整数`);
  return Number(value);
}
