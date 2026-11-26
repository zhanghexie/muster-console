/** Real Electron/preload/Host, bundled Pi worker and SDK; only HTTP inference is local. */
import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('GUI seed fork first turn, restart, cancellation and clear use the real Pi lifecycle',async({},testInfo)=>{
  test.setTimeout(120_000);
  const project=path.resolve(__dirname,'../..');
  const fixture=fs.mkdtempSync(path.join(project,'.tmp','gui-seed-fork-e2e-'));
  const userData=path.join(fixture,'.dev-sandbox','userData');
  const workspace=path.join(fixture,'workspace');
  for(const dir of [userData,workspace,path.join(userData,'agent-sessions'),path.join(userData,'agent-runtimes')])fs.mkdirSync(dir,{recursive:true});
  const hostRule='fixture-first-input-host-rule';
  const introMarker='Muster Console opens or resumes your Harness session.';
  const projectInstructions='# Fixture project instructions\n';
  const agentsFile=path.join(workspace,'AGENTS.md');
  fs.writeFileSync(agentsFile,projectInstructions+'<!-- muster:begin -->\nretired-root-injection\n<!-- muster:end -->\n');
  const sourceId='65111111-1111-4111-8111-111111111111';
  const sourceFile=path.join(userData,'agent-sessions',`${sourceId}.json`);
  fs.writeFileSync(sourceFile,JSON.stringify({version:2,messages:[
    {id:'seed-user',role:'user',ts:1,parts:[{kind:'text',text:'unique-prior-user-for-gui-seed'}]},
    {id:'seed-answer',role:'assistant',ts:2,parts:[{kind:'text',text:'unique-prior-answer-for-gui-seed'}]},
    {id:'seed-last-user',role:'user',ts:3,parts:[{kind:'text',text:'unique-final-user-seed'}]}
  ]}));
  fs.writeFileSync(path.join(userData,'sessions.json'),JSON.stringify([{id:sourceId,name:'Seed source',type:'terminal',launchKind:'agent',
    runtime:'pi',workspaceId:'seed-ws',cwd:workspace,status:'idle',lifecycle:'idle',createdAt:1,lastUsedAt:1,configurePermissions:true,guiMode:'default'}]));
  const registry=JSON.parse(fs.readFileSync(path.join(project,'src/main/runtime/builtins/registry.json'),'utf8'));
  for(const entry of registry.runtimes)entry.enabled=entry.id==='pi';
  fs.writeFileSync(path.join(userData,'agent-runtimes','registry.json'),JSON.stringify(registry));
  fs.writeFileSync(path.join(userData,'config.json'),JSON.stringify({locale:'en',workspace,activeWorkspaceId:'seed-ws',
    workspaces:[{id:'seed-ws',name:'Seed workspace',path:workspace}],openai:{baseUrl:'',apiKey:'',model:''},
    agentRules:[{id:'fixture-host-rule',text:hostRule,enabled:true}],
    mcp:{enabled:false,servers:[]},webAccess:{enabled:false}}));
  type ModelMessage = {role:string;content:unknown;tool_call_id?:string};
  const requests:Array<{messages:ModelMessage[];tools?:Array<{function:{name:string}}> }>=[];
  let held:http.ServerResponse|undefined;
  const reply=(res:http.ServerResponse, calls: Array<{id:string;name:string;args:Record<string,unknown>}> = [])=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    const deltas=calls.length
      ? [[{tool_calls:calls.map(({id,name,args},index)=>({index,id,type:'function',function:{name,arguments:JSON.stringify(args)}}))},null],[{},'tool_calls']]
      : [[{content:'GUI seed local reply'},null],[{},'stop']];
    for(const [delta,finish] of deltas)
      res.write(`data: ${JSON.stringify({id:'gui-seed-local',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  const model=http.createServer((req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'mock',object:'model'}]}));return;}
    let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
      const payload=JSON.parse(body);requests.push(payload);
      const latest=payload.messages?.at(-1);
      if(String(JSON.stringify(latest?.content)).includes('hold-gui-seed-cancel')){held=res;return;}
      if(latest?.role==='user'&&JSON.stringify(latest.content).includes('unique-gui-first-turn')){
        reply(res,[{id:'gui-memory-skill-fixture',name:'read',args:{path:'~/.muster/skills/memory/SKILL.md'}}]);
      }else if(latest?.tool_call_id==='gui-memory-skill-fixture'){
        reply(res,[{id:'gui-memory-search-fixture',name:'host_memory_search',args:{query:'previous project decisions',mode:'task'}}]);
      }else if(latest?.tool_call_id==='gui-memory-search-fixture'){
        reply(res,[
          {id:'gui-observe-fixture',name:'host_sessions_observe',args:{}},
          {id:'gui-journal-fixture',name:'host_memory_journal',args:{
            topic:'GUI首条记忆验证',status:'已完成',problem:'验证工作记录回执',points:['保留可复查的工具调用证据']
          }}
        ]);
      }else reply(res);
    });
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const port=(model.address() as {port:number}).port;
  const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
  for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','MUSTER_NO_SANDBOX','MUSTER_DEVTOOLS_PORT','MUSTER_WEB_PORT'])delete env[key];
  env.MUSTER_SANDBOX='1';env.MUSTER_INSTANCE_ID=`gui-seed-${process.pid}`;
  let app:ElectronApplication|undefined;let win!:Page;let launchNumber=0;
  const launch=async()=>{
    app=await _electron.launch({executablePath:require('electron'),args:[project,'--disable-gpu'],cwd:fixture,env});
    const file=path.join(fixture,`electron-${++launchNumber}.log`);
    app.process().stdout?.on('data',chunk=>fs.appendFileSync(file,chunk));
    app.process().stderr?.on('data',chunk=>fs.appendFileSync(file,chunk));
    app.process().on('close',(code,signal)=>fs.appendFileSync(file,`\nlauncher close ${code} ${signal}\n`));
    win=await app.firstWindow();await win.locator('.app-shell').waitFor({timeout:60_000});
  };
  const close=async()=>{
    if(!app)return;
    const closing=app;app=undefined;let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([closing.close(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Electron shutdown exceeded 20s: ${fixture}`)),20_000);})]);}
    catch(error){const child=closing.process();if(child.pid&&child.exitCode===null){if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{/* Failure remains reported. */}}else child.kill('SIGKILL');}throw error;}
    finally{if(timer)clearTimeout(timer);}
  };
  const page=(id:string)=>win.evaluate(id=>window.api.agentSession.historyRange(id),id);
  const send=async(id:string,text:string,beforeReply?:()=>Promise<void>)=>{
    const before=requests.length;
    const accepted=await win.evaluate(({id,text})=>window.api.agentSession.send(id,text),{id,text});
    expect(accepted.ok,JSON.stringify(accepted)).toBe(true);
    await expect.poll(()=>requests.length,{timeout:30_000}).toBeGreaterThan(before);
    await beforeReply?.();
    await expect.poll(async()=>{const state=await page(id);return state&&!state.busy&&state.messages.some(message=>message.role==='assistant'&&message.parts.some(part=>part.kind==='text'&&part.text==='GUI seed local reply'));},{timeout:30_000}).toBe(true);
    expect((await page(id))?.messages.at(-1)?.error).toBeFalsy();
    return requests[before]!;
  };
  try{
    await launch();
    expect(fs.readFileSync(agentsFile,'utf8')).toBe(projectInstructions);
    expect(fs.existsSync(path.join(workspace,'CLAUDE.md'))).toBe(false);
    expect(await win!.evaluate(()=> 'getHistory' in window.api.agentSession)).toBe(false);
    await win!.evaluate(baseUrl=>window.api.config.update({openai:{baseUrl,apiKey:'local-test',model:'mock'}}),`http://127.0.0.1:${port}/v1`);
    const baseline=fs.readFileSync(sourceFile);
    const fork=await win!.evaluate(id=>window.api.sessions.canvasFork(id),sourceId);
    const childId=fork.session.id;
    const markerFile=path.join(userData,'agent-fork-pending',`${childId}.json`);
    const marker=fs.readFileSync(markerFile,'utf8');expect(Buffer.byteLength(marker)).toBeLessThan(1024);
    expect(JSON.parse(marker)).toMatchObject({version:2,state:'pending',delivery:'seed',seed:{count:3},transcript:null});
    expect(requests).toHaveLength(0);expect(fs.readFileSync(sourceFile)).toEqual(baseline);
    expect((await page(childId))?.messages.map(message=>message.id)).toEqual(['seed-user','seed-answer','seed-last-user']);
    const firstUserText='帮我解释这条日志：Connection refused (unique-gui-first-turn)';
    const first=await send(childId,firstUserText,async()=>{
      const pendingJournal=async()=>(await page(childId))?.messages.find(message=>
        message.approval?.toolName.includes('memory.journal')||message.approval?.toolName.includes('memory_journal'))?.approval;
      await expect.poll(async()=>(await pendingJournal())?.approvalId).toBeTruthy();
      const approvalId=(await pendingJournal())!.approvalId;
      expect(await win.evaluate(({sessionId,approvalId})=>window.api.agentSession.respondApproval({
        sessionId,approvalId,approved:true
      }),{sessionId:childId,approvalId})).toEqual({ok:true});
    });
    const input=first.messages.at(-1)?.content;
    const inputText=typeof input==='string' ? input : Array.isArray(input) ? input.map(part=>part.text??'').join('') : '';
    const userPrefix=firstUserText+'\n\n';
    expect(inputText.startsWith(`${userPrefix}<muster_host_context source="automatic">\nMuster Console opens or resumes your Harness session.`)).toBe(true);
    expect(inputText.endsWith('\n</muster_host_context>')).toBe(true);
    expect(inputText).toContain("Reply in the user's requested language. Otherwise, use the language of their latest prose, excluding host prompts, quotes, code, and tool output.");
    expect(inputText).toContain(`Your session ID in Muster is ${childId}.`);
    expect(inputText).toMatch(/host_sessions_setStatus[^\n]*必须用户行动时[^\n]*普通对话自然结束即可/);
    await expect.poll(() => win.evaluate(async id => {
      const session = (await window.api.sessions.list()).sessions.find(row => row.id === id);
      return [session?.lifecycle, session?.activity?.event, session?.phase?.value ?? null];
    }, childId)).toEqual(['idle', 'gui-turn-end', null]);
    expect(inputText).toContain('(read/write, management root).');
    expect(inputText.indexOf('## Workspace Directory Scope')).toBeLessThan(inputText.indexOf('Read ~/.muster/skills/memory/SKILL.md'));
    expect(inputText).toContain('Use fenced `mermaid` blocks to clarify flows, dependencies, or state changes.');
    expect(inputText).toContain('Use host_ui_render when filtering');
    expect(inputText).toContain('Read ~/.muster/skills/memory/SKILL.md before your first memory tool call in this session.');
    expect(inputText).toContain('For prior work, past decisions or corrections, recurring issues, or standing preferences, search first with host_memory_search and short topic keywords.');
    expect(inputText).toContain('Use host_memory_journal for decisions, findings, or handoffs worth revisiting.');
    expect(inputText).toContain('Pi can read published skills from their registered paths.');
    expect(inputText).toContain('Before sending each final reply to the user, call host_ui_suggestReplies exactly once.');
    expect(inputText).not.toMatch(/## Registered Tools|HOST(?:-EXT)?\.md/);
    fs.mkdirSync(testInfo.outputDir,{recursive:true});
    fs.writeFileSync(testInfo.outputPath('gui-first-input-context.txt'),inputText.slice(userPrefix.length));
    expect(first.tools?.some(tool=>tool.function.name==='host_sessions_observe')).toBe(true);
    expect(first.tools?.some(tool=>tool.function.name==='host_memory_journal')).toBe(true);
    const toolResult = (id:string) => requests.flatMap(request=>request.messages).find(message=>message.tool_call_id===id)?.content;
    expect(JSON.stringify(toolResult('gui-memory-skill-fixture'))).toContain('# Memory in Muster');
    expect(JSON.stringify(toolResult('gui-memory-search-fixture'))).toMatch(/ok[^a-z0-9]*true/);
    expect(requests.slice(1).some(request=>request.messages.some(message=>message.role==='tool'&&/saved[^a-z0-9]*true/.test(JSON.stringify(message.content))))).toBe(true);
    expect(requests.slice(1).some(request=>request.messages.some(message=>message.role==='tool'&&JSON.stringify(message.content).includes(childId)))).toBe(true);
    expect(JSON.stringify(first.messages.at(-1)?.content)).toContain(hostRule);
    expect(JSON.stringify(first.messages.filter(message=>message.role==='system'))).not.toContain(hostRule);
    expect(JSON.stringify(first.messages)).toContain('unique-prior-user-for-gui-seed');
    expect(JSON.stringify(first.messages)).toContain('unique-final-user-seed');
    const metadata=await page(childId);
    expect(metadata?.messages.find(message=>message.role==='user'&&message.parts.some(part=>part.kind==='text'&&part.text===firstUserText))).toBeTruthy();
    expect(JSON.stringify(metadata?.messages)).not.toContain(hostRule);
    expect(metadata?.metadataStatus?.injectionCount).toBeGreaterThan(0);
    const summary=metadata!.injections!.at(-1)!;
    expect('kind' in summary&&summary.kind).toBe('summary');
    expect(summary.segments.every(segment=>!('text' in segment))).toBe(true);
    if(!('details' in summary))throw new Error('GUI range returned complete injection bodies');
    const reference=summary.details;
    const details=await win!.evaluate(({id,reference})=>window.api.agentSession.injectionDetails(id,reference),{id:childId,reference});
    expect(details.ok).toBe(true);
    if(details.ok)expect(details.snapshot.segments.some(segment=>segment.text.length>0)).toBe(true);
    const timeline=await win!.evaluate(id=>window.api.agentSession.metadataTimeline(id,'injections',undefined,1),childId);
    expect(timeline.ok).toBe(true);
    if(timeline.ok){expect(timeline.page.records).toHaveLength(1);expect(timeline.page.total).toBe(metadata!.metadataStatus!.injectionCount);}
    await expect.poll(()=>JSON.parse(fs.readFileSync(markerFile,'utf8')).state).toBe('delivered');
    const delivered=JSON.parse(fs.readFileSync(markerFile,'utf8'));expect(delivered.delivery).toBe('seed');expect(delivered.resumeToken).toBeTruthy();
    expect(fs.existsSync(path.join(userData,'agent-fork-context',`${childId}.seeds.ndjson`))).toBe(false);
    await close();await launch();
    const coldDetails=await win!.evaluate(({id,reference})=>window.api.agentSession.injectionDetails(id,reference),{id:childId,reference});
    expect(coldDetails).toEqual(details);
    await win!.evaluate(id=>window.api.sessions.select(id),childId);
    const second=await send(childId,'unique-gui-second-turn-after-restart');
    const resumed=JSON.stringify(second.messages);
    expect(resumed.match(/unique-prior-user-for-gui-seed/g)).toHaveLength(1);
    expect(resumed.match(/unique-gui-first-turn/g)).toHaveLength(1);
    expect(resumed.match(/fixture-first-input-host-rule/g)).toHaveLength(1);
    expect(JSON.stringify(second.messages.filter(message=>message.role==='user')).split(introMarker)).toHaveLength(2);
    expect(JSON.stringify(second.messages.at(-1)?.content)).not.toContain(introMarker);
    await win!.getByText('unique-gui-second-turn-after-restart',{exact:true}).first().waitFor();
    await win!.screenshot({path:testInfo.outputPath('gui-seed-resumed.png')});
    await win!.evaluate(id=>window.api.agentSession.send(id,'hold-gui-seed-cancel'),childId);
    await expect.poll(()=>!!held,{timeout:30_000}).toBe(true);
    expect(JSON.stringify(requests.at(-1)?.messages.at(-1)?.content)).not.toContain(introMarker);
    await win!.evaluate(id=>window.api.agentSession.abort(id),childId);
    await expect.poll(async()=>(await page(childId))?.busy,{timeout:30_000}).toBe(false);
    expect((await win!.evaluate(id=>window.api.agentSession.clear(id),childId)).ok).toBe(true);
    expect((await page(childId))?.total).toBe(0);expect(fs.existsSync(markerFile)).toBe(false);
    expect((await win!.evaluate(({id,reference})=>window.api.agentSession.injectionDetails(id,reference),{id:childId,reference})).ok).toBe(false);
    const afterClear=await send(childId,'unique-gui-after-clear');
    expect(JSON.stringify(afterClear.messages.at(-1)?.content)).toContain(introMarker);
    const cleared=JSON.stringify(afterClear.messages);
    for(const old of ['unique-prior-user-for-gui-seed','unique-gui-first-turn','unique-gui-second-turn-after-restart','hold-gui-seed-cancel'])expect(cleared).not.toContain(old);
    expect(fs.readFileSync(sourceFile)).toEqual(baseline);
    await win!.getByText('unique-gui-after-clear',{exact:true}).first().waitFor();
    await win!.screenshot({path:testInfo.outputPath('gui-seed-cleared.png')});
    await close();
  }catch(error){
    if(app)await win?.screenshot({path:testInfo.outputPath('gui-seed-failure.png')}).catch(()=>{});
    throw error;
  }finally{
    if(held&&!held.destroyed)held.destroy();
    try{await close();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));}
    // Keep isolated artifacts and logs for diagnosis; no production profile is touched.
  }
});
