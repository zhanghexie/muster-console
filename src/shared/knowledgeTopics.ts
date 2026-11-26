import type {KnowledgeRecord} from './knowledge';

/** Suggestions only: topic proximity never authorizes a merge or an approval. */
export function knowledgeTopicRelated(a:KnowledgeRecord,b:KnowledgeRecord):boolean {
  if(a.id===b.id||a.namespace!==b.namespace||a.kind!==b.kind||a.repoKey!==b.repoKey||a.branch!==b.branch)return false;
  const tokens=(r:KnowledgeRecord)=>{
    const text=[r.problem,r.summary,...(r.searchKeys??[])].join(' ').toLowerCase();
    const set=new Set(text.match(/[a-z0-9_]{2,}/g)??[]);
    for(const run of text.match(/[\u4e00-\u9fff]+/g)??[])for(let i=0;i<run.length-1;i++)set.add(run.slice(i,i+2));
    return set;
  };
  const x=tokens(a),y=tokens(b),common=[...x].filter(t=>y.has(t)).length;
  return common>=2&&common/Math.max(1,Math.min(x.size,y.size))>=0.45;
}

export function knowledgeTopicGroups(records:KnowledgeRecord[]):KnowledgeRecord[][] {
  const groups:KnowledgeRecord[][]=[];
  for(const record of records){const group=groups.find(g=>knowledgeTopicRelated(g[0],record));if(group)group.push(record);else groups.push([record]);}
  return groups;
}
