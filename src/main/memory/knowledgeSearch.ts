import type {KnowledgeHit,KnowledgeQuery,KnowledgeRecord} from '../../shared/knowledge';
import {KnowledgeStore} from './knowledgeStore';
import {knowledgeRepoKey} from './knowledgePolicy';
import type {CuratorReferences,CuratorScope} from './curator/storageTypes';

/** Branch is provenance for recall, not an authorization boundary. */
export function knowledgeVisible(record:KnowledgeRecord,input:KnowledgeQuery):boolean {
  return record.namespace===(input.namespace??'worker')
    &&(record.status==='active'||(input.mode==='history'&&record.kind==='task_fact'&&record.status==='archived'))
    &&(record.kind!=='task_fact'||input.mode==='history')
    &&(!record.repoKey||record.repoKey===knowledgeRepoKey(input.repoKey))
    &&(record.expiresAt==null||record.expiresAt>(input.now??Date.now()))
    &&(!input.taskId||record.kind!=='task_fact'||record.taskId===input.taskId)
    &&(!input.sources?.length||record.evidence.every(e=>input.sources!.includes(e.source)));
}

export class KnowledgeSearch {
  private stopped=false;
  constructor(readonly store:KnowledgeStore){}

  /** Revalidate the latest revision and policy before returning any hit. */
  current(hits:KnowledgeHit[],input:KnowledgeQuery):KnowledgeHit[] {
    if(this.stopped)return [];
    const records=new Map(this.store.list().records.map(record=>[record.id,record]));
    return hits.flatMap(hit=>{
      const record=records.get(hit.record.id);
      return record&&record.revision===hit.record.revision&&knowledgeVisible(record,input)&&this.store.policyAllows(record)?[{...hit,record}]:[];
    });
  }

  async search(input:KnowledgeQuery):Promise<KnowledgeHit[]> {
    const limit=Math.max(1,Math.min(input.limit??5,20));
    const hits=this.current(this.store.search({...input,limit}),input);
    if(this.stopped||!hits.length)return [];
    const records=this.store.list().records,seen=new Set(hits.map(h=>h.record.id));
    const additions:KnowledgeHit[]=[];
    // Relationships are one hop only and retain the same repository and policy checks.
    for(const hit of hits){
      for(const relation of hit.record.relations??[]){
        if(additions.length>=5)break;
        const record=records.find(r=>r.id===relation.targetId&&r.revision===relation.targetRevision);
        if(!record||seen.has(record.id)||!knowledgeVisible(record,input))continue;
        seen.add(record.id);
        additions.push({record,score:0,applicability:record.applicability.every(c=>(input.conditions??[]).includes(c))?'matched':'needs_check',reason:`关联依据：${hit.record.summary}（${relation.kind}，仅一跳）`});
      }
    }
    // The public API is async: revalidate after its promise boundary as well.
    await Promise.resolve();
    return this.current([...hits,...additions],input);
  }

  /** Comparison remains bound to the curator's write scope. */
  async references(query:string,scope:CuratorScope):Promise<CuratorReferences> {
    return this.stopped?{records:[],deleted:[]}:this.store.curatorReferences(query,scope);
  }
  close():void{this.stopped=true;}
}
