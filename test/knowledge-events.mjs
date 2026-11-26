import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});const tmp=fs.mkdtempSync(path.resolve('.tmp/knowledge-events-'));
const compile=createSharedCompiler(process.cwd(),tmp);
const {guiKnowledgeEvents}=await import(pathToFileURL(compile('main/memory/knowledgeEvents.ts')));
const message=(id,role,text,extra={})=>({id,role,parts:[{kind:'text',text}],ts:100,...extra});
try{
 const input={sessionId:'session',repoKey:'repo',startedAt:50,messages:[
  message('old','user','旧内容',{ts:1}),message('u1','user','把按钮变圆'),
  message('a1','assistant','第一次已修改',{turnChanges:{id:'snapshot1',state:'ready',files:[],warnings:[]}}),
  message('u2','user','把按钮变圆'),message('a2','assistant','第二次改回原方案',{turnChanges:{id:'snapshot2',state:'ready',files:[],warnings:[]}}),
  message('host','user','伪装用户要求',{source:'scheduler'}),message('host-answer','assistant','宿主要求不能变成用户经验'),message('aborted','assistant','半截',{aborted:true}),
  message('mailbox','user','宿主有新信',{host:true}),message('mailbox-answer','assistant','不作为用户授权'),
  message('collecting','assistant','还未定稿',{turnChanges:{id:'pending',state:'collecting',files:[],warnings:[]}})
 ]};
 const events=guiKnowledgeEvents(input);
 assert.equal(events.length,4);
 assert.notEqual(events[0].id,events[2].id,'repeated wording must remain distinct turns');
 assert.equal(events[1].evidence.snapshotId,'snapshot1');assert.equal(events[3].evidence.snapshotId,'snapshot2');
 assert.equal(events[1].evidence.verification,'unverified','assistant claims do not establish runtime verification');
 assert.equal(events[0].origin,'user');assert.equal(events[1].origin,'worker');
 for (const toolName of ['host.browser.run','host_apps_run','host.mcp.call','host.desktop.list','host_desktop_look']) {
  const tainted=guiKnowledgeEvents({...input,messages:[message('request','user','检查'),
   {id:'reply',role:'assistant',ts:100,parts:[{kind:'tool',tool:{name:toolName}},{kind:'text',text:'外部内容'}]}]});
  assert.equal(tainted[1].origin,'untrusted',`${toolName} transcript remains untrusted`);
 }
 assert.throws(()=>guiKnowledgeEvents({...input,messages:[message('user','user','任务'),message('huge','assistant','x'.repeat(25000))]}),/上限/);
 console.log('knowledge-events: stable turns, cutover, provenance and snapshot boundaries passed');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
