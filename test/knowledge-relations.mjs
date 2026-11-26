import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});const tmp=fs.mkdtempSync(path.resolve('.tmp/knowledge-relations-')),compile=createSharedCompiler(process.cwd(),tmp);
const {KnowledgeStore}=await import(pathToFileURL(compile('main/memory/knowledgeStore.ts'))),{KnowledgeSearch}=await import(pathToFileURL(compile('main/memory/knowledgeSearch.ts')));
const store=new KnowledgeStore(path.join(tmp,'assets')),search=new KnowledgeSearch(store);
try{
 const create=(summary,repoKey='repo')=>store.submit({kind:'stable_constraint',summary,applicability:[],repoKey},{namespace:'worker',origin:'user',explicit:true,evidence:[{id:summary,source:'fixture',eventTime:1,verification:'user_confirmed'}]}).record;
 const seed=create('蓝鹭发布验收'),related=create('环境代号 cobalt'),foreign=create('私有环境 secret','other'),stale=create('旧版条件');
 const payload={...seed,relations:[related,foreign,stale].map(r=>({targetId:r.id,targetRevision:r.revision,kind:'derived_from',inferred:true}))};
 // Seed the persisted relation graph; production writes it in the same candidate transaction.
 store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify(payload),seed.id);
 store.revise(stale.id,stale.revision,{...stale,summary:'已修订条件'});
 const hits=await search.search({query:'蓝鹭发布验收',repoKey:'repo',limit:1});
 assert.ok(hits.some(h=>h.record.id===related.id&&h.reason.includes('关联依据')));
 assert.ok(!hits.some(h=>h.record.id===foreign.id||h.record.id===stale.id));
 assert.ok(hits.length<=6);
 console.log('knowledge-relations: one-hop scope and exact revision checks passed');
}finally{search.close();store.close();fs.rmSync(tmp,{recursive:true,force:true});}
