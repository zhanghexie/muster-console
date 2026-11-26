import type {KnowledgeDraft} from '../../shared/knowledge';
import {findSourceQuote} from './curator/sourceQuote';

/** A profile is global: bind its source to a real user statement, not a model paraphrase. */
export function validateProfileSource(userText:string|undefined,sourceQuote:string,draft:KnowledgeDraft,verifyValues=true):void {
  if(!userText||!sourceQuote||!findSourceQuote(userText,sourceQuote))throw new Error('用户画像必须能在本轮用户原话中定位依据');
  if(/(?:不要|不用|无需|别|禁止|不许|不准|勿)(?:.{0,20}?)(?:记住|记录|记下|保存|存储|留存)|\b(?:do not|don't|never)\s+(?:remember|save|store|record)\b/i.test(userText))
    throw new Error('用户要求不记录，本轮不能自动保存画像');
  if(!verifyValues)return;
  const text=[draft.summary,draft.problem,draft.action,draft.rationale,draft.expectedFutureUse,...draft.applicability,...(draft.exceptions??[])].filter(Boolean).join('\n');
  const quote=sourceQuote.toLowerCase();
  for(const address of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)??[])
    if(!quote.includes(address.toLowerCase()))throw new Error('画像邮箱必须与用户原话中的值一致');
  if(/电话|手机|联系方式|\b(?:phone|mobile|telephone|tel)\b/i.test(text)){
    const originalDigits=sourceQuote.replace(/\D/g,'');
    for(const phone of text.match(/\+?\d[\d ()\-.]{5,}\d/g)??[]){
      const digits=phone.replace(/\D/g,'');
      if(digits.length>=7&&digits.length<=15&&!originalDigits.includes(digits))throw new Error('画像电话必须与用户原话中的号码一致');
    }
  }
}
