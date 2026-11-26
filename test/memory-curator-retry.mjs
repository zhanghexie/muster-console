import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-retry-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const load=async file=>import(pathToFileURL(compile(file)));
const {CuratorRequestError,parseCuratorResponse,curatorRequestError,curatorRetryDecision}=await load('main/memory/curator/retry.ts');
const {CuratorQueue}=await load('main/memory/curator/queue.ts');
const {MemoryCuratorRuntime}=await load('main/memory/curator/runtime.ts');
const {curatorResponseOptions,createMemoryCuratorPiFactory}=await load('main/memory/curator/pi.ts');
const fixed=1_800_000_000_000;
const candidate=id=>({id,eventId:id,namespace:'worker',origin:'worker',text:'有用候选',sourceText:'原始任务依据',createdAt:1,evidence:[{id,source:'fixture',eventTime:1,verification:'unverified'}]});
const waitFor=async(predicate,label)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error(`timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,5));}};
const runtimes=[];let session,server,sdkReset;
try{
  assert.equal(parseCuratorResponse({status:429,headers:{'Retry-After':'120'}},fixed).retryAt,fixed+120_000);
  assert.equal(parseCuratorResponse({status:503,headers:{'retry-after':new Date(fixed+60_000).toUTCString()}},fixed).retryAt,fixed+60_000);
  assert.equal(parseCuratorResponse({status:429,resetAt:(fixed+120_000)/1000},fixed).retryAt,fixed+120_000);
  assert.equal(parseCuratorResponse({status:429,resetAt:fixed+180_000},fixed).retryAt,fixed+180_000);
  assert.equal(parseCuratorResponse({status:429,headers:{'x-ratelimit-reset':String((fixed+240_000)/1000)}},fixed).retryAt,fixed+240_000);
  assert.equal(parseCuratorResponse({status:429,headers:{'x-ratelimit-reset-at':String(fixed+300_000)}},fixed).retryAt,fixed+300_000);
  assert.equal(parseCuratorResponse({status:429,headers:{'ratelimit-reset':'90'}},fixed).retryAt,fixed+90_000);
  assert.equal(parseCuratorResponse({status:429,headers:{'x-ratelimit-reset-requests':'1m2s','x-ratelimit-reset-tokens':'3m','retry-after':'10'}},fixed).retryAt,fixed+180_000,'all supplied constraints are honored');
  assert.equal(parseCuratorResponse({status:429,headers:{'retry-after':'invalid'},resetAt:fixed-1000},fixed).retryAt,undefined,'invalid or past reset values do not invent a quota window');
  const sanitized=parseCuratorResponse({status:429,headers:{authorization:'secret-credential','set-cookie':'private-cookie','retry-after':'30'}},fixed);
  assert.deepEqual(Object.keys(sanitized).sort(),['retryAt','status']);assert.doesNotMatch(JSON.stringify(sanitized),/secret|cookie|authorization/);
  const signal=new AbortController().signal,request=new Request('https://fixture.invalid/memory'),init={signal,method:'POST',body:'original body'};
  const response=new Response('opaque provider error',{status:429,headers:{'retry-after':'120','set-cookie':'do-not-persist'}});
  let fetchCalls=0,callbackCalls=0;const observed=[];
  const customFetch=async(...args)=>{fetchCalls++;assert.equal(args[0],request);assert.equal(args[1],init);assert.equal(args[1].signal,signal);return response;};
  const observedOptions=curatorResponseOptions('openai-completions',{fetch:customFetch,signal,onResponse:async(value,model)=>{callbackCalls++;assert.equal(value.status,429);assert.equal(model.id,'fixture');}},value=>observed.push(value));
  assert.equal(observedOptions.signal,signal);assert.notEqual(observedOptions.fetch,customFetch);
  assert.equal(await observedOptions.fetch(request,init),response,'the provider receives its original Response object');
  assert.equal(response.bodyUsed,false,'error observation never consumes the provider response body');assert.equal(fetchCalls,1);
  assert.equal(observed[0].status,429);assert.ok(observed[0].retryAt>=Date.now()+119_000);
  assert.doesNotMatch(JSON.stringify(observed),/cookie|do-not-persist/i,'only status and retry time cross the transport boundary');
  await observedOptions.onResponse({status:429,headers:{'retry-after':'120'}},{id:'fixture'});assert.equal(callbackCalls,1,'the caller response callback remains chained');
  for(const api of ['google-generative-ai','google-vertex','bedrock-converse-stream','unknown-future-api']){
    let callbacks=0,metadata;const original={signal,onResponse:async()=>{callbacks++;}};
    const untouched=curatorResponseOptions(api,original,value=>{metadata=value;});
    assert.equal(Object.hasOwn(untouched,'fetch'),false,`${api} must not receive an unsupported custom fetch`);
    assert.equal(untouched.signal,signal);await untouched.onResponse({status:429,headers:{'retry-after':'120'}},{id:'fixture'});
    assert.equal(callbacks,1);assert.equal(metadata.status,429,'structured callbacks remain usable when the adapter supplies them');
    assert.equal(curatorResponseOptions(api,{fetch:globalThis.fetch},()=>{}).fetch,globalThis.fetch,'an existing supported global fetch identity is preserved');
  }
  for(const api of ['openai-completions','openai-responses','openai-codex-responses','azure-openai-responses','anthropic-messages','mistral-conversations','pi-messages']){
    const defaults=curatorResponseOptions(api,undefined,()=>{});assert.equal(typeof defaults.fetch,'function');assert.notEqual(defaults.fetch,globalThis.fetch);
  }
  const rate=new CuratorRequestError('quota exceeded',{status:429});
  assert.equal(curatorRetryDecision(rate,1,fixed).retryAt,fixed+30_000);assert.equal(curatorRetryDecision(rate,2,fixed).retryAt,fixed+60_000);assert.equal(curatorRetryDecision(rate,3,fixed).retry,false);
  assert.equal(curatorRetryDecision(new CuratorRequestError('quota exceeded',{status:429,retryAt:fixed+18_000_000}),1,fixed).retryAt,fixed+18_000_000,'a supplied long reset is not shortened to a guessed probe time');
  assert.equal(curatorRetryDecision(new CuratorRequestError('unavailable',{status:503}),1,fixed).retryAt,fixed+1000);
  assert.equal(curatorRetryDecision(curatorRequestError(Object.assign(new Error('socket reset'),{code:'ECONNRESET'})),1,fixed).retry,true);
  assert.equal(curatorRetryDecision(new Error('本轮记忆处理时间预算已用尽'),1,fixed).retry,false,'budget prose is not a trusted timeout signal');
  assert.equal(curatorRetryDecision(new CuratorRequestError('本轮记忆处理时间预算已用尽'),1,fixed).retry,false,'a provider error wrapper cannot mint a host time-budget signal');
  for(const error of [new CuratorRequestError('network error',{status:401}),new CuratorRequestError('network error',{status:403}),new CuratorRequestError('invalid',{status:400}),new Error('记忆模型调用预算已用尽'),new Error('对照记忆已变化，请重新检索'),new Error('缺少模型配置'),new Error('429 is only model text')])assert.equal(curatorRetryDecision(error,1,fixed).retry,false,error.message);

  let now=fixed,queue=new CuratorQueue(temp,path.join(temp,'queue'),()=>now);queue.enqueue(candidate('queue-reset'));
  let claim=queue.claim(1,1000)[0];queue.defer(claim,'quota',fixed+3_600_000);queue.close();now+=30_000;
  queue=new CuratorQueue(temp,path.join(temp,'queue'),()=>now);assert.deepEqual(queue.claim(1,1000),[]);assert.equal(queue.nextWakeAt(),fixed+3_600_000,'reset time survives restart');
  now=fixed+3_600_001;claim=queue.claim(1,1000)[0];assert.equal(claim.attempts,2);queue.defer(claim,'unknown quota');assert.equal(queue.nextWakeAt(),now+60_000);
  now+=60_001;claim=queue.claim(1,1000)[0];queue.defer(claim,'third failure',now+1000);assert.equal(queue.counts().failed,1);assert.equal(queue.nextWakeAt(),undefined);
  queue.retryFailed();assert.deepEqual(queue.claim(1,1000),[],'explicit retry cannot bypass a known future provider reset');assert.equal(queue.nextWakeAt(),now+1000);queue.close();

  now=fixed;let calls=0;
  const directory=path.join(temp,'runtime'),options={workspaceId:'w',root:temp,directory,now:()=>now,references:()=>({records:[],deleted:[]}),commit(){throw new Error('unexpected commit');},
    createSession:async()=>{calls++;throw new CuratorRequestError('quota',{status:429,retryAt:calls===1?fixed+3_600_000:undefined});}};
  let runtime=new MemoryCuratorRuntime(options);runtimes.push(runtime);runtime.enqueue(candidate('runtime-reset'));await waitFor(()=>!runtime.snapshot().running,'first limited request');
  assert.equal(calls,1);assert.equal(runtime.withMaintenance(db=>db.prepare('SELECT available_at FROM candidates').get().available_at),fixed+3_600_000);
  await runtime.stop();runtimes.pop();now=fixed+30_000;runtime=new MemoryCuratorRuntime(options);runtimes.push(runtime);runtime.requestDrain();await waitFor(()=>!runtime.snapshot().running,'restart before reset');assert.equal(calls,1);
  now=fixed+3_600_001;runtime.requestDrain();await waitFor(()=>!runtime.snapshot().running,'second limited request');assert.equal(calls,2);
  assert.equal(runtime.withMaintenance(db=>db.prepare('SELECT available_at FROM candidates').get().available_at),now+60_000);
  now+=60_001;runtime.requestDrain();await waitFor(()=>!runtime.snapshot().running,'finite final request');assert.equal(calls,3);assert.equal(runtime.snapshot().failed,1);
  runtime.requestDrain();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,3);
  for(const status of [400,401,403]){
    let count=0;const terminal=new MemoryCuratorRuntime({...options,directory:path.join(temp,`terminal-${status}`),createSession:async()=>{count++;throw new CuratorRequestError('network failure text does not override status',{status});}});runtimes.push(terminal);
    terminal.enqueue(candidate(`terminal-${status}`));await waitFor(()=>!terminal.snapshot().running,`terminal ${status}`);assert.equal(terminal.snapshot().failed,1);assert.equal(count,1);
  }

  // Actual Pi SDK: OpenAI throws before onResponse, so the HTTP boundary must preserve metadata.
  const {__setPiSdkForTests}=await load('main/agentSession/drivers/pi/piSdk.ts');sdkReset=()=>__setPiSdkForTests(null);__setPiSdkForTests(await import('@earendil-works/pi-coding-agent'));
  const {MEMORY_CURATOR_TOOL_NAMES}=await load('main/memory/curator/tools.ts');let httpCalls=0;
  server=http.createServer(async(req,res)=>{for await(const chunk of req){}httpCalls++;res.writeHead(429,{'content-type':'application/json','retry-after':'120','set-cookie':'do-not-persist'});res.end(JSON.stringify({error:{message:'controlled quota',type:'rate_limit_error'}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  const config={llm:{activeProviderId:'retry-fixture',activeModelId:'fixture',providers:[{id:'retry-fixture',name:'retry fixture',apiKey:'fixture-only',baseUrl:`http://127.0.0.1:${port}`,api:'openai-completions',models:[{id:'fixture',contextWindow:32000,maxTokens:1024}]}]}};
  const factory=createMemoryCuratorPiFactory({config:()=>config});const events=[];
  session=await factory({root:temp,directory:path.join(temp,'pi'),maxModelRequests:8,onEvent:event=>events.push(event),tools:MEMORY_CURATOR_TOOL_NAMES.map(name=>({name,description:'fixture',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){return {};}}))});
  const before=Date.now();let failure;try{await session.run({kind:'candidate',text:'fixture'},new AbortController().signal);}catch(error){failure=error;}
  assert.ok(failure instanceof CuratorRequestError);assert.equal(failure.status,429);assert.ok(failure.retryAt>=before+119_000);assert.ok(failure.retryAt<=Date.now()+121_000);
  assert.equal(httpCalls,1,'provider retries remain zero');assert.equal(events.filter(event=>event.type==='model-start').length,1,'each real HTTP request still consumes the strict budget');
  assert.doesNotMatch(JSON.stringify({failure,events}),/do-not-persist|set-cookie/i,'response headers are not retained as transcript metadata');
  console.log('memory-curator-retry: structured headers/resetAt, durable delay, terminal errors, finite recovery and actual Pi response metadata passed');
}finally{
  session?.dispose();sdkReset?.();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  for(const runtime of runtimes)await runtime.stop();const relative=path.relative(scratch,temp);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(temp,{recursive:true,force:true});
}
