import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {build} from 'esbuild';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-exit-'));
try{
 const bundle=path.join(dir,'exit.cjs');
 await build({stdin:{contents:"export {maybeWriteExitSummary} from './src/main/metaAgent/journalExitSummary';export * from './src/main/memory/journal';",resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',plugins:[{name:'summary-fixture',setup(b){
  b.onResolve({filter:/textTools\/runTextTool$/},()=>({path:'summary',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:"export async function runTextTool(){globalThis.summaryCalls++;return {text:'## [退出摘要] 已完成\\n- 问题：记录会话结果\\n- 要点：验证完成'};}"}));
 }}]});
 const api=createRequire(import.meta.url)(bundle);globalThis.summaryCalls=0;
 const root=path.join(dir,'control'),notifications=[],ctx={config:{get:()=>({journalExitSummaryEnabled:true})},notify:{push:n=>notifications.push(n)}};
 const input={sessionId:'s',sessionName:'test',workspaceId:'w',workspaceRoot:root,messages:Array.from({length:4},(_,i)=>({id:String(i),role:i%2?'assistant':'user',parts:[{kind:'text',text:'substantive turn'}]}))};
 api.maybeWriteExitSummary(ctx,input);
 for(let i=0;i<20&&!api.hasJournalForActor(root,'s');i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(api.hasJournalForActor(root,'s'),true);assert.equal(globalThis.summaryCalls,1);assert.equal(notifications.length,0);
 assert.ok(api.searchJournal(root,'退出摘要').hits.length===1);
 api.writeJournal(root,'already',{topic:'主动日志',status:'已完成',problem:'已记录',points:['无需重复摘要']});
 api.maybeWriteExitSummary(ctx,{...input,sessionId:'already'});await new Promise(r=>setTimeout(r,10));assert.equal(globalThis.summaryCalls,1);
 assert.ok(!fs.existsSync(path.join(root,'docs/journal')));
 console.log('memory-journal-exit: optional exit summary shares transactional writer and skips existing session logs');
}finally{delete globalThis.summaryCalls;fs.rmSync(dir,{recursive:true,force:true});}
