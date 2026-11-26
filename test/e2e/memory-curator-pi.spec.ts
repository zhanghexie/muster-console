/** Real Electron ESM Pi SDK + default factory + local SSE provider + production IPC/preload. */
import {test,expect,_electron as electron} from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

const root=path.resolve(__dirname,'../..'),requireNode=createRequire(__filename);
const {buildSync}=requireNode('esbuild') as typeof import('esbuild');
const electronPath=requireNode('electron') as string;
const toolNames=['memory_candidates','memory_commit','memory_defer','memory_evidence','memory_search'];
const marker='ELECTRON_PI_UNRELATED_RESOURCE_MUST_NOT_LOAD';
const privateThought='ELECTRON_PI_PRIVATE_REASONING_MUST_NOT_RENDER';
const quote='原始挂载卸载观察：取消订阅后监听器数量恢复初始值，没有重复回调。';
const lesson={kind:'reusable_lesson',summary:'真实SDK：卸载组件时清理订阅',problem:'多次挂载导致监听器累计',action:'卸载时调用unsubscribe',
  rationale:quote,applicability:['React组件订阅'],exceptions:['独立后台服务管理自身生命周期'],expectedFutureUse:'避免重复事件响应'};
const queryText='请查询当前订阅清理记忆，不新增或修改任何知识。';
const deleteText=`请删除这条记忆：${lesson.summary}`;

test('真实Pi SDK在Electron中按需加载、闭合工具并持久提交',async()=>{
  test.setTimeout(110000);
  const directory=path.join(root,'.tmp',`memory-curator-pi-electron-${randomUUID()}`),profile=path.join(directory,'profile');
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(profile,{recursive:true});
  const source=(file:string)=>JSON.stringify(path.join(root,file).replace(/\\/g,'/'));
  const requests:any[]=[],serverErrors:string[]=[];
  let phase:'save'|'query'|'delete'='save',step=0;
  const textOf=(value:any):string=>typeof value==='string'?value:Array.isArray(value)?value.map(part=>part.text??'').join('\n'):'';
  const lastToolResult=(body:any,name:string):any=>{
    const names=new Map<string,string>();
    for(const message of body.messages??[])for(const call of message.tool_calls??[])names.set(call.id,call.function?.name);
    const message=[...(body.messages??[])].reverse().find(item=>item.role==='tool'&&(item.name===name||names.get(item.tool_call_id)===name));
    if(!message)throw new Error(`local fixture did not receive ${name} result`);
    return JSON.parse(textOf(message.content));
  };
  const server=http.createServer(async(req,res)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push({phase,body});
      expect(req.headers.authorization).toBe('Bearer fixture-only');
      expect(body.tools?.map((tool:any)=>tool.function.name).sort()).toEqual(toolNames);
      expect(JSON.stringify(body)).not.toContain(marker);
      const index=step++;
      const candidate=index===0?undefined:lastToolResult(body,'memory_candidates')[0];
      let call:[string,Record<string,unknown>]|undefined;
      if(index===0)call=['memory_candidates',{}];
      else if(phase==='save'){
        call=[
          undefined,
          ['bash',{command:'echo forbidden-native-tool'}],
          ['memory_search',{candidateId:candidate.id,query:'组件卸载清理订阅'}],
          ['memory_evidence',{candidateId:candidate.id,evidenceId:'source'}],
          ['memory_commit',{candidateId:candidate.id,decision:'save',draft:lesson,sourceQuote:quote,reason:'原始观察可定位且条件完整',deletionComparisons:[]}]
        ][index] as [string,Record<string,unknown>]|undefined;
      }else if(index===1)call=['memory_search',{candidateId:candidate.id,query:'组件卸载清理订阅'}];
      else if(index===2)call=['memory_evidence',{candidateId:candidate.id,evidenceId:'source'}];
      else if(index===3){
        if(phase==='query')call=['memory_commit',{candidateId:candidate.id,decision:'discard',sourceQuote:'',reason:'只读查询已完成，不新增或修改知识',deletionComparisons:lastToolResult(body,'memory_search').deleted.map((item:any)=>({id:item.id,equivalent:false}))}];
        else{
          const target=lastToolResult(body,'memory_search').records.find((record:any)=>record.summary===lesson.summary&&record.status==='active');
          if(!target)throw new Error('delete model step did not receive an active target from the real reference tool');
          call=['memory_commit',{candidateId:candidate.id,decision:'delete',sourceQuote:deleteText,reason:'用户原文明确删除',targetId:target.id,targetRevision:target.revision,deletionComparisons:[]}];
        }
      }
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      const write=(delta:Record<string,unknown>,finishReason:string|null=null)=>res.write(`data: ${JSON.stringify({id:`chat-${requests.length}`,object:'chat.completion.chunk',created:1,model:'curator-electron-fixture',choices:[{index:0,delta,finish_reason:finishReason}]})}\n\n`);
      write({role:'assistant',content:''});
      if(call){
        write({tool_calls:[{index:0,id:`call-${requests.length}`,type:'function',function:{name:call[0],arguments:JSON.stringify(call[1])}}]});
        write({},'tool_calls');
      }else{
        write({reasoning_content:privateThought});
        write({content:phase==='save'?'SDK保存完成。':phase==='query'?'SDK只读查询完成。':'SDK删除完成。'});write({},'stop');
      }
      res.end('data: [DONE]\n\n');
    }catch(error){
      serverErrors.push(String((error as Error).stack??error));
      if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'controlled fixture assertion failed'}}));
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('missing fixture server address');
  fs.writeFileSync(path.join(directory,'main.ts'),`
    import {app,BrowserWindow} from 'electron';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
    import {MemoryService} from ${source('src/main/memory/service.ts')};
    import {curatorDirectory as resolveCuratorDirectory} from ${source('src/main/memory/layout.ts')};
    import {setMemoryService} from ${source('src/main/memory/serviceRef.ts')};
    import {setUserProfileFilePath} from ${source('src/main/memory/userProfile.ts')};
    import {registerMemoryCuratorIpc} from ${source('src/main/memory/curatorIpc.ts')};
    import {registerKnowledgeIpc} from ${source('src/main/memory/knowledgeIpc.ts')};
    import {memoryCurator,closeMemoryCurator} from ${source('src/main/memory/curatorBindings.ts')};
    import {noteKnowledge} from ${source('src/main/memory/knowledgeTools.ts')};
    import {runAsAgentWorkspace,runAsAgentSession} from ${source('src/main/agent/agentScope.ts')};
    import {runWithTurnUserText} from ${source('src/main/agent/turnScope.ts')};
    import {writeTextAtomicSync} from ${source('src/main/atomicJson.ts')};
    const stage=(name:string)=>{fs.appendFileSync(path.join(__dirname,'bootstrap.log'),name+'\\n');console.log('[curator-sdk-fixture]',name);};
    const bootId=randomUUID();stage('imports-loaded '+bootId);
    app.setPath('userData',path.join(__dirname,'profile'));stage('profile-set');
    app.whenReady().then(async()=>{
      stage('when-ready');
      const work=path.join(__dirname,'work'),firstBoot=!fs.existsSync(work);fs.mkdirSync(work,{recursive:true});
      if(firstBoot){
        execFileSync('git',['init','-b','main'],{cwd:work,windowsHide:true});fs.writeFileSync(path.join(work,'fixture.txt'),'isolated real SDK fixture');
        execFileSync('git',['add','fixture.txt'],{cwd:work,windowsHide:true});
        execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','isolated baseline'],{cwd:work,windowsHide:true});
      }
      stage('git-ready');
      const escaped=path.join(__dirname,'unrelated-executed'),curatorDirectory=resolveCuratorDirectory(work,'sdk');
      if(firstBoot)for(const base of [work,path.join(curatorDirectory,'pi-home')]){
        fs.mkdirSync(path.join(base,'.pi','skills','unrelated'),{recursive:true});fs.mkdirSync(path.join(base,'.pi','extensions'),{recursive:true});fs.mkdirSync(path.join(base,'.pi','prompts'),{recursive:true});
        fs.writeFileSync(path.join(base,'AGENTS.md'),${JSON.stringify(marker)});
        fs.writeFileSync(path.join(base,'.pi','skills','unrelated','SKILL.md'),'---\\nname: unrelated\\ndescription: '+${JSON.stringify(marker)}+'\\n---\\n'+${JSON.stringify(marker)});
        fs.writeFileSync(path.join(base,'.pi','prompts','unrelated.md'),${JSON.stringify(marker)});
        fs.writeFileSync(path.join(base,'.pi','extensions','unrelated.ts'),'import fs from "node:fs";fs.writeFileSync('+JSON.stringify(escaped)+',"unexpected");export default function(){}');
        fs.writeFileSync(path.join(base,'.pi','settings.json'),JSON.stringify({extensions:['./extensions/unrelated.ts'],skills:['./skills'],prompts:['./prompts']}));
        fs.writeFileSync(path.join(base,'.mcp.json'),JSON.stringify({mcpServers:{unrelated:{command:${JSON.stringify(marker)}}}}));
      }
      const config:any={locale:'zh-CN',activeWorkspaceId:'sdk',workspaces:[{id:'sdk',name:'SDK fixture',path:work}],memoryConsolidation:{enabled:true,admissionMode:'automatic'},
        llm:{activeProviderId:'curator-local',activeModelId:'curator-electron-fixture',providers:[{id:'curator-local',name:'Controlled loopback fixture',api:'openai-completions',baseUrl:${JSON.stringify(`http://127.0.0.1:${address.port}`)},apiKey:'fixture-only',
          models:[{id:'curator-electron-fixture',name:'Electron actual Pi fixture',contextWindow:128000,maxTokens:2048}]}]}};
      stage('config-ready');
      const svc=new MemoryService();setMemoryService(svc);setUserProfileFilePath(app.getPath('userData'));
      stage('memory-service-ready');
      let win:BrowserWindow|undefined;
      const ctx:any={config:{get:()=>config},getWindow:()=>win,ui:{notify(){}},sessions:{get:()=>({id:'sdk-worker',workspaceId:'sdk'})},
        agentSessions:{entries:new Map([['sdk-worker',{workspaceId:'sdk',assistant:{id:'sdk-observation-turn',role:'assistant',ts:Date.now(),parts:[{kind:'tool',tool:{id:'sdk-observation',name:'fixture.observe',input:{},status:'ok',output:${JSON.stringify(quote)}}}]}}]])}};
      registerMemoryCuratorIpc(ctx);registerKnowledgeIpc(ctx);stage('ipc-ready');
      (globalThis as any).__sdkFixture={
        notePromise:undefined as Promise<unknown>|undefined,noteState:{status:'idle'} as any,
        startNote(){
          const fixture=(globalThis as any).__sdkFixture;
          if(fixture.noteState.status!=='idle')return {scheduled:false};
          fixture.noteState={status:'scheduled'};
          // Return to CDP before native ESM loading starts. Model-period observations
          // go through files/production renderer IPC, never main-process inspector evaluation.
          setTimeout(()=>{
            stage('note-started');fixture.noteState={status:'pending'};
            fixture.notePromise=runAsAgentWorkspace('sdk',()=>runAsAgentSession('sdk-worker',async()=>runWithTurnUserText('排查当前组件订阅问题，并根据已完成的原始观察处理。',()=>noteKnowledge(svc,work,JSON.stringify(${JSON.stringify(lesson)}),{repoKey:work,branch:'main'},['subscriptiondisposefixture917']))));
            fixture.notePromise.then((receipt:unknown)=>{
              fixture.noteState={status:'done',receipt};writeTextAtomicSync(path.join(__dirname,'note-result.json'),JSON.stringify(fixture.noteState));stage('note-accepted');
            },(error:unknown)=>{
              fixture.noteState={status:'error',error:String(error)};writeTextAtomicSync(path.join(__dirname,'note-result.json'),JSON.stringify(fixture.noteState));stage('note-failed');
            });
          },0);
          return {scheduled:true};
        },
        noteResult:()=>((globalThis as any).__sdkFixture.noteState),
        audit:()=>{
          const store=svc.knowledge(work),sessions=path.join(curatorDirectory,'sessions');
          return {bootId,snapshot:memoryCurator(ctx,'sdk').snapshot(),records:store.list().records,noteState:(globalThis as any).__sdkFixture.noteState,
            receipts:store.db.prepare('SELECT receipt FROM curator_receipts ORDER BY rowid').all().map((row:any)=>JSON.parse(row.receipt)),
            sessions:fs.existsSync(sessions)?fs.readdirSync(sessions).map(name=>({name,size:fs.statSync(path.join(sessions,name)).size})):[],
            escaped:fs.existsSync(escaped),node:process.versions.node,electron:process.versions.electron};
        },
        shutdown:async()=>{await closeMemoryCurator(ctx,'sdk');svc.closeAll();}
      };
      const writeAudit=()=>writeTextAtomicSync(path.join(__dirname,'audit.json'),JSON.stringify((globalThis as any).__sdkFixture.audit()));
      writeAudit();const auditTimer=setInterval(writeAudit,50);auditTimer.unref();
      let quitReady=false;
      app.on('before-quit',event=>{
        if(quitReady)return;event.preventDefault();clearInterval(auditTimer);
        (globalThis as any).__sdkFixture.shutdownPromise=(globalThis as any).__sdkFixture.shutdown().catch(console.error).finally(()=>{quitReady=true;app.quit();});
      });
      win=new BrowserWindow({width:780,height:650,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:false}});stage('window-created');
      stage('load-file');await win.loadFile(path.join(__dirname,'index.html'));stage('file-loaded');
    }).catch(error=>{stage('startup-failed');console.error(error);app.exit(1);});app.on('window-all-closed',()=>app.quit());
  `,'utf8');
  fs.writeFileSync(path.join(directory,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font:14px system-ui;margin:16px}button{padding:8px;margin:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>
    <h1>真实 Pi SDK · 隔离 Electron 集成夹具</h1>
    <button id="view">查看记忆会话</button><button id="query">只读查询</button><button id="delete">删除知识</button><p id="result" role="status"></p><pre id="state"></pre>
    <script>
      const state=document.getElementById('state'),result=document.getElementById('result');
      const show=snapshot=>state.textContent=JSON.stringify(snapshot,null,2);
      window.api.memoryCurator.onChanged(show);
      document.getElementById('view').onclick=()=>window.api.memoryCurator.state('sdk').then(show).catch(error=>result.textContent=String(error));
      document.getElementById('query').onclick=()=>window.api.memoryCurator.send('sdk',${JSON.stringify(queryText)}).then(value=>result.textContent=JSON.stringify(value)).catch(error=>result.textContent=String(error));
      document.getElementById('delete').onclick=()=>window.api.memoryCurator.send('sdk',${JSON.stringify(deleteText)}).then(value=>result.textContent=JSON.stringify(value)).catch(error=>result.textContent=String(error));
    </script></body></html>`,'utf8');

  let application:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try{
    // No injected SDK module, alternate factory, module alias or createSession override.
    // Match Electron's Node capability: a generic ES target strips the required node: prefix from node:sqlite.
    buildSync({entryPoints:[path.join(directory,'main.ts')],outfile:path.join(directory,'main.cjs'),platform:'node',format:'cjs',target:'node22.13',bundle:true,packages:'external',
      banner:{js:"require('node:fs').appendFileSync(require('node:path').join(__dirname,'bootstrap.log'),'entered\\n');"}});
    buildSync({entryPoints:[path.join(root,'src/preload/index.ts')],outfile:path.join(directory,'preload.cjs'),platform:'node',format:'cjs',bundle:true,external:['electron']});
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.NODE_OPTIONS;
    application=await electron.launch({executablePath:electronPath,args:[path.join(directory,'main.cjs')],env:env as Record<string,string>,timeout:15000});
    const app=application,win=await app.firstWindow(),rendererErrors:string[]=[];
    app.on('console',message=>{if(message.type()==='error')console.error('Electron SDK main error:',message.text());});
    win.on('pageerror',error=>rendererErrors.push(error.message));
    const readJson=(name:string):any=>{try{return JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return undefined;throw error;}};
    const audit=async()=>{const value=readJson('audit.json');if(!value)throw new Error('Electron fixture audit file is not ready');return value;};
    await expect.poll(()=>!!readJson('audit.json')).toBe(true);
    await win.getByRole('button',{name:'查看记忆会话',exact:true}).click();
    await expect(win.locator('#state')).toContainText('"workspaceId": "sdk"');
    expect(requests).toHaveLength(0);expect((await audit()).snapshot.sessionId).toBeNull();expect((await audit()).sessions).toEqual([]);
    expect(await app.evaluate(()=>((globalThis as any).__sdkFixture.startNote()))).toEqual({scheduled:true});
    await expect.poll(()=>readJson('note-result.json')?.status,{timeout:10000}).toBe('done');
    const note=readJson('note-result.json').receipt;
    expect(note.queued).toBe(true);
    await expect.poll(async()=>((await audit()).records.find((record:any)=>record.summary===lesson.summary)?.status),{timeout:60000}).toBe('active');
    await expect.poll(async()=>((await audit()).snapshot.running),{timeout:30000}).toBe(false);
    await expect(win.locator('#state')).toContainText('SDK保存完成。');
    const saved=await audit(),record=saved.records.find((item:any)=>item.summary===lesson.summary);
    expect(saved.receipts).toHaveLength(1);expect(saved.receipts[0]).toMatchObject({candidateId:note.candidateId,decision:'save',disposition:'active',record:{id:record.id,status:'active'}});
    expect(record.searchKeys).toContain('subscriptiondisposefixture917');
    const keywordHits=await win.evaluate(()=>window.api.knowledge.search('sdk',{query:'subscriptiondisposefixture917'}));
    expect(keywordHits.some(hit=>hit.record.id===record.id)).toBe(true);
    expect(saved.snapshot.failed).toBe(0);expect(saved.snapshot.error).toBeUndefined();
    expect(saved.sessions.some((file:any)=>file.name.endsWith('.jsonl')&&file.size>0)).toBe(true);
    expect(saved.snapshot.sessionId).toBeTruthy();expect(saved.electron).toBeTruthy();
    expect(saved.snapshot.messages.flatMap((message:any)=>message.parts).some((part:any)=>part.kind==='tool'&&part.tool.name==='bash'&&part.tool.status==='error')).toBe(true);
    expect(saved.escaped).toBe(false);expect(JSON.stringify(saved.snapshot)).not.toContain(privateThought);
    expect(requests.filter(request=>request.phase==='save')).toHaveLength(6);
    const recalled=await win.evaluate(()=>window.api.knowledge.search('sdk',{query:'卸载组件清理订阅'}));
    expect(recalled.some(hit=>hit.record.id===record.id)).toBe(true);

    phase='query';step=0;
    await win.getByRole('button',{name:'只读查询',exact:true}).click();
    await expect(win.locator('#state')).toContainText('SDK只读查询完成。');
    await expect.poll(async()=>((await audit()).snapshot.running)).toBe(false);
    const queried=await audit();
    expect(queried.records).toEqual(saved.records);expect(queried.snapshot.sessionId).toBe(saved.snapshot.sessionId);
    expect(queried.receipts).toHaveLength(2);expect(queried.receipts[1]).toMatchObject({decision:'discard',disposition:'discarded',affected:[]});
    expect(queried.snapshot.pending).toBe(0);expect(queried.snapshot.failed).toBe(0);
    expect(requests.filter(request=>request.phase==='query')).toHaveLength(5);

    phase='delete';step=0;
    await win.getByRole('button',{name:'删除知识',exact:true}).click();
    await expect(win.locator('#state')).toContainText('SDK删除完成。');
    await expect.poll(async()=>((await audit()).snapshot.running)).toBe(false);
    const deleted=await audit();
    expect(deleted.records.find((item:any)=>item.id===record.id).status).toBe('rejected');
    expect(deleted.receipts).toHaveLength(3);expect(deleted.receipts[2]).toMatchObject({decision:'delete',record:{id:record.id,status:'rejected'}});
    expect((await win.evaluate(()=>window.api.knowledge.search('sdk',{query:'卸载组件清理订阅'}))).some(hit=>hit.record.id===record.id)).toBe(false);
    expect(requests.filter(request=>request.phase==='delete')).toHaveLength(5);
    expect(deleted.snapshot.failed).toBe(0);expect(deleted.escaped).toBe(false);
    expect(serverErrors).toEqual([]);expect(rendererErrors).toEqual([]);
    const requestCount=requests.length;
    await win.getByRole('button',{name:'查看记忆会话',exact:true}).click();
    await expect(win.locator('#state')).toContainText('SDK删除完成。');
    expect(requests).toHaveLength(requestCount);

    // A real process restart reuses the same fixture, profile, queue and SDK session file.
    await application.close();application=undefined;
    application=await electron.launch({executablePath:electronPath,args:[path.join(directory,'main.cjs')],env:env as Record<string,string>,timeout:15000});
    const restarted=application,restartedWindow=await restarted.firstWindow();
    restarted.on('console',message=>{if(message.type()==='error')console.error('Restarted Electron SDK main error:',message.text());});
    restartedWindow.on('pageerror',error=>rendererErrors.push(error.message));
    await expect.poll(()=>{const value=readJson('audit.json');return !!value&&value.bootId!==deleted.bootId;}).toBe(true);
    await restartedWindow.getByRole('button',{name:'查看记忆会话',exact:true}).click();
    await expect(restartedWindow.locator('#state')).toContainText('SDK删除完成。');
    const recovered=await audit();
    expect(recovered.snapshot.sessionId).toBe(deleted.snapshot.sessionId);
    expect(recovered.snapshot.messages).toEqual(deleted.snapshot.messages);
    expect(recovered.records).toEqual(deleted.records);expect(recovered.receipts).toEqual(deleted.receipts);
    expect(recovered.snapshot.running).toBe(false);expect(recovered.snapshot.pending).toBe(0);
    expect((await restartedWindow.evaluate(()=>window.api.knowledge.search('sdk',{query:'卸载组件清理订阅'}))).some(hit=>hit.record.id===record.id)).toBe(false);
    expect(requests,'reopening and reading persisted state never starts Pi').toHaveLength(requestCount);
    phase='query';step=0;
    await restartedWindow.getByRole('button',{name:'只读查询',exact:true}).click();
    await expect.poll(async()=>((await audit()).receipts.length),{timeout:30000}).toBe(4);
    await expect.poll(async()=>((await audit()).snapshot.running)).toBe(false);
    const resumed=await audit();
    expect(resumed.snapshot.sessionId,'the default factory resumes the existing SDK SessionManager').toBe(deleted.snapshot.sessionId);
    expect(resumed.records).toEqual(deleted.records);expect(resumed.receipts[3]).toMatchObject({decision:'discard',disposition:'discarded',affected:[]});
    expect(resumed.snapshot.failed).toBe(0);expect(resumed.escaped).toBe(false);
    expect(requests.length-requestCount).toBe(5);
    expect(textOf(requests[requestCount].body.messages.filter((message:any)=>message.role==='assistant').map((message:any)=>({text:textOf(message.content)})))).toContain('SDK删除完成。');
    expect(serverErrors).toEqual([]);expect(rendererErrors).toEqual([]);

    // Host maintenance stays behind the formal preload/IPC boundary and outside Pi's tools.
    const requestsBeforeMaintenance=requests.length;
    const invalidMaintenance=(workspaceId:string,input:unknown)=>restartedWindow.evaluate(async args=>{
      try{await (window.api.knowledge.maintenance as any)(args.workspaceId,args.input);return {rejected:false,error:''};}
      catch(error){return {rejected:true,error:String(error)};}
    },{workspaceId,input});
    const outside=await invalidMaintenance('outside-this-fixture',{action:'prune_history'});
    expect(outside.rejected).toBe(true);expect(outside.error).toMatch(/workspace not found|工作区/);
    const policy={action:'stop_policy',namespace:'worker',policyVersion:'memory-curator-v1',reason:'fixture'};
    for(const invalid of [
      {...policy,namespace:'outside'},
      {...policy,policyVersion:''},
      {...policy,policyVersion:'p'.repeat(121)},
      {...policy,reason:undefined},
      {...policy,reason:'   '},
      {...policy,reason:'r'.repeat(1001)}
    ]){
      const result=await invalidMaintenance('sdk',invalid);
      expect(result.rejected).toBe(true);expect(result.error).toMatch(/非法记忆维护范围或策略版本|停用记忆策略需要有界原因/);
    }
    expect((await restartedWindow.evaluate(()=>window.api.memoryCurator.state('sdk'))).paused,'rejected maintenance cannot pause the service').toBe(false);
    const pruned=await restartedWindow.evaluate(()=>window.api.knowledge.maintenance('sdk',{action:'prune_history'}));
    expect(pruned).toMatchObject({action:'prune_history',processed:0,incomplete:0});expect(pruned.blocked??[]).toEqual([]);
    expect(requests).toHaveLength(requestsBeforeMaintenance);
    const stopped=await restartedWindow.evaluate(()=>window.api.knowledge.maintenance('sdk',{action:'stop_policy',namespace:'worker',policyVersion:'memory-curator-v1',reason:'fixture'}));
    expect(stopped.action).toBe('stop_policy');
    expect((await restartedWindow.evaluate(()=>window.api.memoryCurator.state('sdk'))).paused).toBe(true);
    expect((await restartedWindow.evaluate(()=>window.api.knowledge.list('sdk'))).records.find(item=>item.id===record.id)?.status).toBe('rejected');
    expect((await restartedWindow.evaluate(()=>window.api.knowledge.search('sdk',{query:'卸载组件清理订阅'}))).some(hit=>hit.record.id===record.id)).toBe(false);
    expect(requests).toHaveLength(requestsBeforeMaintenance);
    for(let attempt=0;attempt<2;attempt++){
      const continued=await restartedWindow.evaluate(()=>window.api.knowledge.maintenance('sdk',{action:'continue_policy',namespace:'worker',policyVersion:'memory-curator-v1'}));
      expect(continued).toMatchObject({action:'continue_policy',processed:0});
    }
    expect((await restartedWindow.evaluate(()=>window.api.memoryCurator.state('sdk'))).paused).toBe(true);
    expect((await restartedWindow.evaluate(()=>window.api.knowledge.list('sdk'))).records.find(item=>item.id===record.id)?.status).toBe('rejected');
    expect((await restartedWindow.evaluate(()=>window.api.knowledge.search('sdk',{query:'卸载组件清理订阅'}))).some(hit=>hit.record.id===record.id)).toBe(false);
    expect(requests).toHaveLength(requestsBeforeMaintenance);
    expect(rendererErrors).toEqual([]);
  }catch(error){
    console.error('Controlled Pi SSE errors:',serverErrors,'requests:',requests.map(request=>request.phase));
    const bootstrapLog=path.join(directory,'bootstrap.log');
    console.error('Electron fixture startup phases:',fs.existsSync(bootstrapLog)?fs.readFileSync(bootstrapLog,'utf8'):'bootstrap banner was never reached');
    const auditFile=path.join(directory,'audit.json');
    if(fs.existsSync(auditFile)){
      try{const value=JSON.parse(fs.readFileSync(auditFile,'utf8'));console.error('Electron SDK audit summary:',{bootId:value.bootId,status:value.snapshot?.status,error:value.snapshot?.error,running:value.snapshot?.running,pending:value.snapshot?.pending,failed:value.snapshot?.failed,messages:value.snapshot?.messages?.length,records:value.records?.length,receipts:value.receipts?.length,sessions:value.sessions?.length,noteStatus:value.noteState?.status});}
      catch{console.error('Electron SDK audit summary: unreadable');}
    }else console.error('Electron SDK audit summary: not created');
    throw error;
  }finally{
    if(application)await application.close();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const cleanupRoot=path.resolve(directory),cleanupProfile=path.resolve(profile),relativeProfile=path.relative(cleanupRoot,cleanupProfile);
    expect(path.isAbsolute(cleanupProfile)&&!!relativeProfile&&!relativeProfile.startsWith('..')&&!path.isAbsolute(relativeProfile)).toBe(true);
    fs.rmSync(cleanupProfile,{recursive:true,force:true,maxRetries:3});
  }
});
