/** Ordinary MCP cancellation -> HTTP disconnect -> shared host AbortSignal; no Tasks extension. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'host-cancel-'));
const compile=createSharedCompiler(root,tmp);
const {handleInboundMcpMessage,dispatchInboundMcpTool}=await import(pathToFileURL(compile('shared/inboundMcp.ts')).href);
const {startHostToolGateway}=await import(pathToFileURL(compile('main/agentSession/drivers/acp/hostToolGateway.ts')).href);
const entry=compile('main/inboundMcp/stdioEntry.ts');
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function eventually(fn){for(let i=0;i<80;i++){if(fn())return;await delay(10);}assert.fail('cancel signal did not arrive');}

test('MCP cancellation aborts exactly its request and releases its stable request ID',async()=>{
  const pendingCalls=new Map(),signals=new Map();
  const ctx={tools:[],pendingCalls,callTool:async(name,args,signal)=>{
    signals.set(args.id,signal);
    await new Promise(r=>signal.addEventListener('abort',r,{once:true}));
    throw new Error('cancelled');
  }};
  const call=id=>handleInboundMcpMessage({jsonrpc:'2.0',id,method:'tools/call',params:{name:'sessions_readMessages',arguments:{id}}},ctx);
  const a=call(1),b=call(2);assert.equal(pendingCalls.size,2);
  const duplicate=await call(1);assert.equal(duplicate.error.code,-32600);
  await handleInboundMcpMessage({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}},ctx);
  assert.equal(await a,null);assert.equal(signals.get(1).aborted,true);assert.equal(signals.get(2).aborted,false);
  assert.equal(pendingCalls.size,1);
  await handleInboundMcpMessage({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:2}},ctx);
  await b;assert.equal(pendingCalls.size,0);
});

test('dispatch passes cancellation to every HTTP transport style',async()=>{
  const controller=new AbortController(),seen=[];
  const http={async postJson(url,body,headers,signal){seen.push(signal);return{ok:true,status:200,text:'{}'};}};
  const identity={token:'t',toolUrl:'http://unused/tool',statusUrl:'http://unused/status'};
  await dispatchInboundMcpTool('sessions_readMessages',{},identity,http,['sessions.readMessages'],controller.signal);
  await dispatchInboundMcpTool('sessions_setStatus',{},identity,http,['sessions.setStatus'],controller.signal);
  await dispatchInboundMcpTool('sessions_readMessages',{}, {...identity,invokeStyle:true},http,[],controller.signal);
  assert.equal(seen.length,3);assert.ok(seen.every(s=>s===controller.signal));
});

test('real stdio entry forwards SDK cancellation through gateway; ordinary completed request is not aborted',async()=>{
  let started=0,aborted=0,active=0;const signals=[];
  const tool={id:'sessions.readMessages',label:'read',description:'read',permissionClass:'read',parameters:{type:'object',properties:{}},
    async execute(args,exec){
      signals.push(exec.signal);assert.ok(exec.signal);
      if(!args.wait)return JSON.stringify({reason:'empty'});
      started++;active++;
      try{await new Promise((resolve,reject)=>{
        if(exec.signal.aborted)return reject(new Error('already cancelled'));
        exec.signal.addEventListener('abort',()=>{aborted++;reject(new Error('cancelled'));},{once:true});
      });}finally{active--;}
      return '{}';
    }};
  const gateway=await startHostToolGateway({sessionId:'b',cwd:tmp,hostTools:[tool],requestApproval:async()=>({approved:true}),
    getPolicyState:()=>({mode:'default',planExecuting:false}),log(){}});
  const catalog=path.join(tmp,'catalog.json');fs.writeFileSync(catalog,JSON.stringify({tools:[{name:'sessions_readMessages',description:'read',inputSchema:tool.parameters}]}));
  const transport=new StdioClientTransport({command:process.execPath,args:[entry],env:{...process.env,
    MUSTER_HOST_TOOLS_CATALOG:catalog,MUSTER_HOST_TOOLS_URL:gateway.url,MUSTER_HOST_TOOLS_TOKEN:gateway.token}});
  const client=new Client({name:'cancel-test',version:'1'});
  try{
    await client.connect(transport);
    const ordinary=await client.callTool({name:'sessions_readMessages',arguments:{}});
    assert.equal(ordinary.isError,false);assert.equal(signals[0].aborted,false,'normal request body/response close is not cancellation');
    const controller=new AbortController();
    const waiting=client.callTool({name:'sessions_readMessages',arguments:{wait:true}},undefined,{signal:controller.signal});
    // Attach rejection before aborting; no unhandled cancellation race.
    const cancelled=assert.rejects(waiting);
    await eventually(()=>started===1);controller.abort();await cancelled;
    await eventually(()=>aborted===1&&active===0);
    const after=await client.callTool({name:'sessions_readMessages',arguments:{}});assert.equal(after.isError,false);
    // Closing the common gateway must also cancel an outstanding wait.
    const outstanding=client.callTool({name:'sessions_readMessages',arguments:{wait:true}});
    await eventually(()=>started===2);gateway.close();await outstanding;assert.equal(active,0);assert.equal(aborted,2);
  }finally{await client.close();gateway.close();}
});
