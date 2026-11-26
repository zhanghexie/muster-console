import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-curator-shared-ledger-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const {MemoryCuratorRuntime}=await import(pathToFileURL(compile('main/memory/curator/runtime.ts')));
const {CuratorQueue}=await import(pathToFileURL(compile('main/memory/curator/queue.ts')));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const waitFor=async(predicate,label)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error(`timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,5));}};
const candidate=id=>({id,eventId:id,namespace:'worker',origin:'worker',text:`候选${id}`,sourceText:`原始材料${id}`,createdAt:1,evidence:[{id,source:'fixture',verification:'unverified',eventTime:1}]});
const runtimes=[];
try{
  const q=new CuratorQueue(temp,path.join(temp,'cas')),generation=q.generation;
  assert.equal(q.acquire('owner',1000),true);
  const message={id:'old',role:'assistant',parts:[{kind:'text',text:'obsolete'}],ts:1};
  assert.equal(typeof q.saveMessages([message],generation,'owner'),'number');
  q.clearTranscript();
  assert.equal(q.saveMessages([message],generation,'owner'),undefined);
  assert.equal(q.publishSession('owner',generation,'obsolete-session','obsolete-file'),false);
  assert.equal(q.rotateSession(generation,'owner'),false);assert.deepEqual(q.messages(),[]);q.close();

  const directory=path.join(temp,'shared'),connections=[],committed=[];
  let holdFirstD=true;
  const dEntered=deferred(),dRelease=deferred();
  const options=label=>({workspaceId:'w',root:temp,directory,references:()=>({records:[],deleted:[]}),
    commit(c,d,assertCurrent){assertCurrent();committed.push(c.id);return {operationId:d.operationId,candidateId:c.id,policyVersion:d.policyVersion,decision:d.decision,disposition:'discarded',reason:'fixture',affected:[],at:1};},
    createSession:async input=>{
      connections.push({label,file:input.sessionFile});
      const id=`${label}-${connections.length}`,file=input.sessionFile??path.join(directory,`${id}.jsonl`);
      if(!fs.existsSync(file))fs.writeFileSync(file,'');
      const tools=Object.fromEntries(input.tools.map(tool=>[tool.name,tool]));
      return {id,file,async run(_job,signal){
        const items=await tools.memory_candidates.execute({},signal);
        for(const item of items){
          if(item.id==='d'&&holdFirstD){holdFirstD=false;dEntered.resolve();await dRelease.promise;input.onEvent({type:'text-delta',text:'obsolete-after-clear'});}
          await tools.memory_search.execute({candidateId:item.id,query:item.text},signal);
          await tools.memory_commit.execute({candidateId:item.id,decision:'discard',sourceQuote:'',reason:'fixture',deletionComparisons:[]},signal);
          fs.appendFileSync(file,`${item.id}\n`);input.onEvent({type:'text-delta',text:`processed ${item.id}`});
        }
      },async abort(){},dispose(){}};
    }});
  const a=new MemoryCuratorRuntime(options('A')),b=new MemoryCuratorRuntime(options('B'));runtimes.push(a,b);
  const complete=async(runtime,id)=>{runtime.enqueue(candidate(id));await waitFor(()=>!runtime.snapshot().running&&runtime.snapshot().pending===0,id);};
  await complete(a,'a');await complete(b,'b');await complete(a,'c');
  const visible=a.snapshot();assert.equal(visible.messages.length,6,'a stale process must append to the latest persisted transcript');
  for(const id of ['a','b','c'])assert.equal(JSON.stringify(visible.messages).includes(`processed ${id}`),true);
  assert.equal(connections.length,3,'returning process reopens its outdated Pi connection');
  assert.ok(connections[1].file&&connections[2].file===connections[1].file,'both processes resume the latest shared session file');
  assert.equal(fs.readFileSync(connections[1].file,'utf8'),'a\nb\nc\n');
  const idleConnections=connections.length;
  await b.setPaused(true);await b.clear();const idleGeneration=b.snapshot().generation;
  assert.deepEqual(a.snapshot().messages,[],'an idle peer reads persistent messages after external clear before acquiring any lease');
  assert.equal(a.snapshot().generation,idleGeneration);assert.equal(connections.length,idleConnections,'idle state reads never reconnect Pi');
  await b.setPaused(false);

  a.enqueue(candidate('d'));await dEntered.promise;await b.setPaused(true);await b.clear();
  const clearedGeneration=b.snapshot().generation;assert.deepEqual(b.snapshot().messages,[]);
  const inFlightConnections=connections.length;
  assert.equal(a.snapshot().running,true);assert.equal(a.snapshot().generation,clearedGeneration);
  assert.deepEqual(a.snapshot().messages,[],'an old in-flight process presents the new persistent generation without old messages');
  assert.equal(connections.length,inFlightConnections,'an in-flight state read never starts another prompt');
  dRelease.resolve();await waitFor(()=>!a.snapshot().running,'old process settles after remote clear');
  assert.deepEqual(a.snapshot().messages,[],'late finally cannot resurrect cleared messages');
  assert.equal(a.snapshot().generation,clearedGeneration);assert.equal(a.snapshot().pending,1,'clear retains the unfinished candidate');
  const afterClear=new CuratorQueue(temp,directory);assert.equal(afterClear.get('sessionId'),'');assert.equal(afterClear.get('sessionFile'),'');afterClear.close();
  assert.equal(committed.filter(id=>id==='d').length,0);
  await b.setPaused(false);await waitFor(()=>!b.snapshot().running&&b.snapshot().pending===0,'new generation resumes');
  assert.equal(committed.filter(id=>id==='d').length,1);

  const delayedDirectory=path.join(temp,'delayed'),factoryEntered=deferred(),factoryRelease=deferred();let runs=0,disposed=0;
  const c=new MemoryCuratorRuntime({...options('C'),directory:delayedDirectory,createSession:async()=>{factoryEntered.resolve();await factoryRelease.promise;return {id:'late-connection',file:'late-file',async run(){runs++;},async abort(){},dispose(){disposed++;}};}});
  const d=new MemoryCuratorRuntime({...options('D'),directory:delayedDirectory});runtimes.push(c,d);
  c.enqueue(candidate('late-factory'));await factoryEntered.promise;await d.setPaused(true);await d.clear();factoryRelease.resolve();
  await waitFor(()=>!c.snapshot().running,'late factory rejected');
  assert.equal(runs,0);assert.equal(disposed,1);assert.equal(c.snapshot().sessionId,null);assert.deepEqual(c.snapshot().messages,[]);
  const finalQueue=new CuratorQueue(temp,delayedDirectory);assert.equal(finalQueue.get('sessionId'),'');assert.equal(finalQueue.get('sessionFile'),'');finalQueue.close();
  console.log('memory-curator-multiprocess: independent SQLite connections preserve shared history, generation CAS, remote clear and late session publication');
}finally{
  for(const runtime of runtimes)await runtime.stop();
  const relative=path.relative(scratch,temp);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))fs.rmSync(temp,{recursive:true,force:true});
}
