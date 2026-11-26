import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gitlab-webhook-'));
const compile=createSharedCompiler(process.cwd(),tmp);
const { handleHookRequest }=await import(pathToFileURL(compile('main/webAccess/hookRoute.ts')).href);
const events=[]; let secret='shared-secret';
const server=http.createServer((req,res)=>void handleHookRequest(req,res,{
 getHookToken:()=> 'path-token', getHookSecret:()=>secret,
 ingestWebhook:async input=>{events.push(input);return {triggered:0,skipped:0,queued:true};}
}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/hook/path-token`;
const issue=(id=6528,action='open')=>({object_kind:'issue',project:{id},object_attributes:{project_id:id,iid:42,action,title:'Issue title'}});
const note=()=>({object_kind:'note',project_id:6528,project:{id:6528},object_attributes:{project_id:6528,noteable_type:'Issue',system:false,note:'A comment',action:'create'},issue:{iid:42,title:'Issue title'}});
const headers={'x-gitlab-event':'Issue Hook','x-gitlab-token':'shared-secret'};
const send=async (h,p)=>{const r=await fetch(url,{method:'POST',headers:h,body:JSON.stringify(p)});return {status:r.status,body:await r.json()};};
try {
 for(const action of ['open','close','reopen']) {const r=await send(headers,issue(6528,action));assert.equal(r.status,200);assert.equal(r.body.queued,true);assert.equal(events.at(-1).type,'issue');assert.equal(events.at(-1).scope,'6528');assert.equal(JSON.parse(events.at(-1).payload).object_attributes.action,action);}
 assert.equal((await send({...headers,'x-gitlab-token':'wrong'},issue())).status,401);
 secret='';assert.equal((await send(headers,issue())).status,401);secret='shared-secret';
 assert.equal((await send({'x-gitlab-token':secret},issue())).status,400);
 assert.equal((await send({...headers,'x-github-event':'issues'},issue())).status,400);
 assert.equal((await send({...headers,'x-gitlab-event':'Note Hook'},note())).body.queued,true);
 assert.equal(events.at(-1).type,'comment');
 const other=note();other.object_attributes.noteable_type='MergeRequest';assert.equal((await send({...headers,'x-gitlab-event':'Note Hook'},other)).body.ignored,true);
 const invalid=issue();invalid.object_attributes.project_id=99;assert.equal((await send(headers,invalid)).body.ignored,true);
 assert.equal((await send({...headers,'x-gitlab-event':'Push Hook'},issue())).body.ignored,true);
 assert.equal(events.length,4);
} finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
console.log('gitlab-webhook: authentication, normalization and event ingestion passed');
