import {findSourceQuotes} from './sourceQuote';
import {CURATOR_EVIDENCE_LIMITS} from './budget';

export interface EvidenceSnippet {text:string;offset:number;end:number;queries:string[]}
/** Bounded literal locating. It neither scores meaning nor grants trust to a source. */
export function locateEvidenceSnippets(source:string,queries:string[],budget:number):{snippets:EvidenceSnippet[];unmatchedQueries:string[]} {
  if(source.length>CURATOR_EVIDENCE_LIMITS.source)throw new Error(`原始依据超过${CURATOR_EVIDENCE_LIMITS.source}字符的只读定位上限`);
  const windows:Array<{offset:number;end:number;query:string}>=[],unmatchedQueries:string[]=[];
  const perQuery=Math.max(1,Math.floor(budget/queries.length));
  for(const query of queries){
    const exact=source.indexOf(query),match=exact<0?findSourceQuotes(source,query,1)[0]:{offset:exact,end:exact+query.length};
    if(!match){unmatchedQueries.push(query);continue;}
    // Queries are capped at 300 characters; reserve their complete raw span when possible.
    const length=Math.min(perQuery,source.length),leading=Math.max(0,Math.floor((length-(match.end-match.offset))/2));
    const offset=Math.max(0,Math.min(match.offset-leading,source.length-length));
    windows.push({offset,end:Math.min(source.length,offset+length),query});
  }
  const snippets:EvidenceSnippet[]=[];
  for(const window of windows.sort((a,b)=>a.offset-b.offset)){
    const previous=snippets.at(-1);
    if(previous&&window.offset<=previous.end){
      previous.end=Math.max(previous.end,window.end);previous.text=source.slice(previous.offset,previous.end);previous.queries.push(window.query);
    }else snippets.push({text:source.slice(window.offset,window.end),offset:window.offset,end:window.end,queries:[window.query]});
  }
  return {snippets,unmatchedQueries};
}
