import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-user-actions-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const {KnowledgeStore}=await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const stores=[];let sequence=0;
const context=text=>({namespace:'worker',origin:'user',sourceText:text,userText:text,evidence:[{id:`user:${++sequence}`,source:'memory-curator-user',eventTime:1,verification:'user_confirmed'}]});
try{
  const cases=[
    {decision:'delete',text:'删除B，不要删除A',quote:'删除B',allowed:true},
    {decision:'delete',text:'不要删除A，但删除B',quote:'删除B',allowed:true},
    {decision:'delete',text:'不要删除A但是删除B',quote:'删除B',allowed:true},
    {decision:'delete',text:'delete B, do not delete A',quote:'delete B',allowed:true},
    {decision:'delete',text:"don't delete A but delete B",quote:'delete B',allowed:true},
    {decision:'delete',text:'不要删除B',quote:'删除B',allowed:false},
    {decision:'delete',text:'请不要删除B，但删除A',quote:'删除B',allowed:false},
    {decision:'delete',text:'do not delete B; delete A',quote:'delete B',allowed:false},
    {decision:'delete',text:'不要删除B，勿删除B',quote:'删除B',allowed:false},
    {decision:'delete',text:'取消删除B',quote:'删除B',allowed:false},
    {decision:'delete',text:'不再删除B',quote:'删除B',allowed:false},
    {decision:'restore',text:'恢复B，不要恢复其他条目',quote:'恢复B',allowed:true},
    {decision:'restore',text:'取消删除B，不要恢复A',quote:'取消删除B',allowed:true},
    {decision:'restore',text:'不要恢复A但是恢复B',quote:'恢复B',allowed:true},
    {decision:'restore',text:"don't restore A but restore B",quote:'restore B',allowed:true},
    {decision:'restore',text:'不要恢复B，恢复A',quote:'恢复B',allowed:false},
    {decision:'restore',text:'do not restore B; restore A',quote:'restore B',allowed:false}
  ];
  for(const item of cases){
    const store=new KnowledgeStore(path.join(temp,`case-${stores.length}`));stores.push(store);
    let record=store.submit({kind:'stable_constraint',summary:'B：保留验证边界',applicability:[]},{...context('以后保留验证边界'),explicit:true}).record;
    if(item.decision==='restore')record=store.deleteKnowledge(record.id,record.revision);
    const id=`action:${sequence}`,deletions=store.deletedKnowledge({namespace:'worker'});
    const invoke=()=>store.commitCuratorDecision({operationId:id,candidateId:id,policyVersion:'fixture',decision:item.decision,sourceQuote:item.quote,reason:'用户明确的局部指令',targetId:record.id,targetRevision:record.revision,
      reviewedDeletionIds:deletions.map(deleted=>deleted.id),deletionComparisons:deletions.map(deleted=>({id:deleted.id,equivalent:true}))},context(item.text));
    if(item.allowed){const receipt=invoke();assert.equal(receipt.decision,item.decision);assert.equal(store.list().records[0].status,item.decision==='restore'?'active':'rejected',item.text);}
    else{assert.throws(invoke,/只有用户原文明确要求/,item.text);assert.equal(store.list().records[0].revision,record.revision,'a trimmed negative instruction cannot mutate the record');}
  }
  console.log('memory-curator-user-actions: mixed positive/negative clauses work while trimmed negations remain unauthorized');
}finally{
  for(const store of stores)store.close();
  const relative=path.relative(scratch,temp);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(temp,{recursive:true,force:true});
}
