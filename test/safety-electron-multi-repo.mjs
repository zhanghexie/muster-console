/** Real isolated Electron main process + real Pi SDK, with a local model fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { execute } from './helpers/execute.mjs';

const root=process.cwd(), tmpRoot=path.join(root,'.tmp');fs.mkdirSync(tmpRoot,{recursive:true});
const directory=fs.mkdtempSync(path.join(tmpRoot,'safety-electron-multi-'));
const require=createRequire(import.meta.url);
let step=0, serverError;
const calls=[];
const findPayload = value => {
  if(typeof value==='string'){try{return findPayload(JSON.parse(value));}catch{return undefined;}}
  if(!value||typeof value!=='object')return undefined;
  if(value.turnSource==='system_approval'&&value.gitEvidence)return value;
  return Object.values(value).map(findPayload).find(Boolean);
};
const server=http.createServer((req,res)=>{void (async()=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());const payload=findPayload(body);
  assert.ok(payload);assert.equal(payload.gitEvidence.repositoryCount,2);
  const index=step++;
  const args=index===0?{requestId:payload.requestId,action:'files'}
    :index===1?{requestId:payload.requestId,action:'read',fileId:0}
    :{requestId:payload.requestId,fingerprint:payload.fingerprint,generation:payload.generation,verdict:'allow',reason:'fixture inspected the captured diff'};
  calls.push(args);
  res.writeHead(200,{'content-type':'text/event-stream'});
  const write=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  write({role:'assistant',content:''});
  if(index<3){write({tool_calls:[{index:0,id:`call-${index}`,type:'function',function:{name:index<2?'safety_evidence':'safety_decide',arguments:JSON.stringify(args)}}]});write({},'tool_calls');}
  else{write({content:'Done'});write({},'stop');}
  res.end('data: [DONE]\n\n');
})().catch(error=>{serverError=error;res.writeHead(500);res.end('fixture error');});});
try {
  const main=path.join(directory,'main.cjs');
  await build({entryPoints:[path.join(root,'test/fixtures/safety-electron-multi-repo.ts')],outfile:main,bundle:true,
    platform:'node',format:'cjs',packages:'external',external:['electron'],logLevel:'silent'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const env={...process.env,SAFETY_ELECTRON_FIXTURE_DIR:directory,SAFETY_ELECTRON_FIXTURE_PORT:String(server.address().port)};
  for(const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','NODE_OPTIONS','MUSTER_NO_SANDBOX'])delete env[name];
  const result=await execute(require('electron'),[main],{cwd:directory,env,timeoutMs:45000});
  if(serverError)throw serverError;
  assert.equal(result.timedOut,false,result.out);
  assert.equal(result.code,0,result.out);
  const match=/SAFETY_FIXTURE_RESULT=(\{[^\n]+\})/.exec(result.out);assert.ok(match,result.out);
  assert.deepEqual(JSON.parse(match[1]),{allowed:true,reason:'fixture inspected the captured diff',humanCalls:0,status:'allowed'});
  assert.equal(calls[0].action,'files');assert.equal(calls[0].repositoryId,undefined);
  assert.equal(calls[1].action,'read');assert.equal(calls[1].repositoryId,undefined);
  console.log('real isolated Electron + Pi SDK handles omitted multi-repository ids');
} finally {
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  assert.ok(path.resolve(directory).startsWith(`${path.resolve(tmpRoot)}${path.sep}safety-electron-multi-`));
  fs.rmSync(directory,{recursive:true,force:true});
}
