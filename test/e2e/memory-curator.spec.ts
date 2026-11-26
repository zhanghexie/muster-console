/**
 * Isolated Electron + production preload, IPC, bindings, durable queue, runtime and storage.
 * Only the Pi session factory is deterministic. Production View/KnowledgePanel run
 * inside a small shell; formal AgentFloat sheet geometry is covered by its browser fixture.
 */
import {test,expect,_electron as electron} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

const root=path.resolve(__dirname,'../..'),requireNode=createRequire(__filename);
const {build,buildSync}=requireNode('esbuild') as typeof import('esbuild');
const electronPath=requireNode('electron') as string;
const captureDirectory=path.join(root,'.tmp','ui-captures','memory-curator-electron');
const quote='挂载卸载循环的原始观察：取消订阅后监听器数量恢复到初始值，没有重复回调。';
const summary='Electron夹具：卸载组件时清理订阅';

test('按需记忆：只读不调用、后台准入、删除阻断迟到提交与会话隔离',async()=>{
  test.setTimeout(110000);
  const directory=path.join(root,'.tmp',`memory-curator-e2e-${randomUUID()}`),profile=path.join(directory,'profile');
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(captureDirectory,{recursive:true});
  const source=(file:string)=>JSON.stringify(path.join(root,file).replace(/\\/g,'/'));
  const mockRuntime=path.join(directory,'fixture-runtime.ts');
  // Test-bundle subclass injects the existing createSession option. Every production
  // binding and mutation path remains intact, with no additional production API.
  fs.writeFileSync(mockRuntime,`
    import {MemoryCuratorRuntime as ProductionRuntime} from ${source('src/main/memory/curator/runtime.ts')};
    import {randomUUID} from 'node:crypto';
    const probe=(globalThis as any).__curatorProbe={sessions:0,runs:0,toolNames:[],receipts:[],lateErrors:[],held:false,release:undefined};
    export class MemoryCuratorRuntime extends ProductionRuntime {
      constructor(options:any){super({...options,createSession:async(input:any)=>{
        probe.sessions++;probe.toolNames=input.tools.map((tool:any)=>tool.name).sort();
        if(probe.toolNames.join('|')!=='memory_candidates|memory_commit|memory_defer|memory_evidence|memory_search')throw new Error('unexpected curator tools');
        const call=async(name:string,args:any,signal:AbortSignal)=>{
          const id=randomUUID();input.onEvent({type:'tool-start',id,name,input:args});
          try{const value=await input.tools.find((tool:any)=>tool.name===name).execute(args,signal);
            input.onEvent({type:'tool-result',id,output:JSON.stringify(value),isError:false});return value;
          }catch(error){input.onEvent({type:'tool-result',id,output:String((error as Error).message),isError:true});throw error;}
        };
        return {id:randomUUID(),model:{providerId:'fixture',modelId:'deterministic-session',name:'隔离测试记忆模型'},
          async run(job:any,signal:AbortSignal){
            probe.runs++;input.onEvent({type:'model-start'});
            const candidates=await call('memory_candidates',{},signal);
            for(const candidate of candidates){
              const refs=await call('memory_search',{candidateId:candidate.id,query:${JSON.stringify(summary)}},signal);
              await call('memory_evidence',{candidateId:candidate.id,evidenceId:'source'},signal);
              if(job.kind==='user'){
                await call('memory_commit',{candidateId:candidate.id,decision:'discard',sourceQuote:'',reason:'只读查询：未新增或更改知识',deletionComparisons:refs.deleted.map((item:any)=>({id:item.id,equivalent:false}))},signal);
                input.onEvent({type:'text-delta',text:'记忆查询完成：'+candidate.text});continue;
              }
              const {flow,...draft}=JSON.parse(candidate.text);
              const old=refs.records.find((record:any)=>record.summary===draft.summary&&record.status==='active');
              const args={candidateId:candidate.id,decision:old?'duplicate':'save',draft,
                sourceQuote:${JSON.stringify(quote)},reason:'依据可定位，方法与适用条件完整',
                targetId:old?.id,targetRevision:old?.revision,
                deletionComparisons:refs.deleted.map((item:any)=>({id:item.id,equivalent:false}))};
              if(flow==='late-delete'){
                probe.held=true;await new Promise<void>(resolve=>{probe.release=resolve;});
                try{await call('memory_commit',args,signal);}catch(error){probe.lateErrors.push(String((error as Error).message));throw error;}
              }else{
                const receipt=await call('memory_commit',args,signal);probe.receipts.push(receipt);
                input.onEvent({type:'text-delta',text:'记忆已按实际事务回执保存。'});
              }
            }
          },async abort(){},dispose(){}
        };
      }});}
    }
  `,'utf8');
  fs.writeFileSync(path.join(directory,'main.ts'),`
    import {app,BrowserWindow} from 'electron';import fs from 'node:fs';import path from 'node:path';
    import {execFileSync} from 'node:child_process';
    import {MemoryService} from ${source('src/main/memory/service.ts')};
    import {setMemoryService} from ${source('src/main/memory/serviceRef.ts')};
    import {setUserProfileFilePath} from ${source('src/main/memory/userProfile.ts')};
    import {registerKnowledgeIpc} from ${source('src/main/memory/knowledgeIpc.ts')};
    import {registerMemoryCuratorIpc} from ${source('src/main/memory/curatorIpc.ts')};
    import {memoryCurator,closeMemoryCurator} from ${source('src/main/memory/curatorBindings.ts')};
    import {noteKnowledge} from ${source('src/main/memory/knowledgeTools.ts')};
    import {runAsAgentWorkspace,runAsAgentSession} from ${source('src/main/agent/agentScope.ts')};
    import {runWithTurnUserText} from ${source('src/main/agent/turnScope.ts')};
    import {handle} from ${source('src/main/ipc/handle.ts')};
    app.setPath('userData',path.join(__dirname,'profile'));
    app.whenReady().then(async()=>{
      const workspaces=['alpha','beta'].map(id=>{
        const work=path.join(__dirname,id);fs.mkdirSync(work,{recursive:true});
        execFileSync('git',['init','-b','main'],{cwd:work,windowsHide:true});
        fs.writeFileSync(path.join(work,'fixture.txt'),'isolated curator fixture');
        execFileSync('git',['add','fixture.txt'],{cwd:work,windowsHide:true});
        execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','isolated baseline'],{cwd:work,windowsHide:true});
        return {id,name:id==='alpha'?'Alpha':'Beta',path:work};
      });
      const config:any={locale:'zh-CN',activeWorkspaceId:'alpha',workspaces,keybindings:{},memoryConsolidation:{enabled:true,admissionMode:'automatic'},
        llm:{activeProviderId:'fixture',activeModelId:'deterministic-session',providers:[{id:'fixture',name:'Fixture',models:[{id:'deterministic-session',name:'隔离测试记忆模型',contextWindow:128000}]}]}};
      const svc=new MemoryService();setMemoryService(svc);setUserProfileFilePath(app.getPath('userData'));
      let win:BrowserWindow|undefined;
      const entries=new Map(workspaces.map(workspace=>['worker-'+workspace.id,{workspaceId:workspace.id,
        assistant:{id:'turn-'+workspace.id,role:'assistant',ts:Date.now(),parts:[{kind:'tool',tool:{id:'observation-'+workspace.id,name:'fixture.observe',input:{},status:'ok',output:${JSON.stringify(quote)}}}]}}]));
      const ctx:any={config:{get:()=>config},getWindow:()=>win,sessions:{get:(id:string)=>({id,workspaceId:id.replace('worker-','')})},
        agentSessions:{entries},ui:{notify(){}},pty:{getBufferTail:()=>''}};
      registerMemoryCuratorIpc(ctx);registerKnowledgeIpc(ctx);
      handle('config:get',()=>config);handle('sessions:list',()=>({sessions:[],activeId:null,schedulerByWs:{}}));
      handle('runtimes:list',()=>[]);handle('extensions:list',()=>({entries:[]}));
      handle('workspaces:list',()=>({workspaces,activeWorkspaceId:config.activeWorkspaceId}));
      handle('workspaces:switch',(_event,id:string)=>{
        if(!workspaces.some(workspace=>workspace.id===id))throw new Error('unknown fixture workspace');
        config.activeWorkspaceId=id;return {ok:true,workspaces,activeWorkspaceId:id};
      });
      handle('app:setChromeTheme',()=>({ok:true,material:'solid'}));
      const rootFor=(id:string)=>{const workspace=workspaces.find(workspace=>workspace.id===id);if(!workspace)throw new Error('unknown fixture workspace');return workspace.path;};
      const draft={kind:'reusable_lesson',summary:${JSON.stringify(summary)},problem:'组件重复挂载积累监听器',action:'在effect返回取消订阅函数',
        rationale:${JSON.stringify(quote)},applicability:['React组件订阅'],exceptions:['独立后台服务有自己的生命周期'],expectedFutureUse:'避免重复回调'};
      (globalThis as any).__fixture={
        stats:()=>{const probe=(globalThis as any).__curatorProbe;return {...probe,release:undefined};},
        note:(workspaceId:string,flow='save')=>runAsAgentWorkspace(workspaceId,()=>runAsAgentSession('worker-'+workspaceId,async()=>
          runWithTurnUserText('请排查组件订阅泄漏，并基于已经完成的观察处理这项工作。',()=>noteKnowledge(svc,rootFor(workspaceId),JSON.stringify({...draft,flow}),{repoKey:rootFor(workspaceId),branch:'main'},['订阅清理'])))),
        records:(id:string)=>svc.knowledge(rootFor(id)).list().records,
        snapshot:(id:string)=>memoryCurator(ctx,id).snapshot(),
        release:()=>{const probe=(globalThis as any).__curatorProbe;probe.release?.();},
        oldPush:(snapshot:any)=>win?.webContents.send('memoryCurator:changed',snapshot),
        shutdown:async()=>{for(const workspace of workspaces)await closeMemoryCurator(ctx,workspace.id);svc.closeAll();}
      };
      fs.writeFileSync(path.join(__dirname,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
      win=new BrowserWindow({width:900,height:820,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:false}});
      await win.loadFile(path.join(__dirname,'index.html'));
    }).catch(error=>{console.error(error);app.exit(1);});app.on('window-all-closed',()=>app.quit());
  `,'utf8');
  fs.writeFileSync(path.join(directory,'renderer.tsx'),`
    import React,{useMemo,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
    import ${source('src/renderer/src/i18n.ts')};import ${source('src/renderer/src/styles.css')};
    import {StoreProvider,useWorkspaceStore} from ${source('src/renderer/src/store.tsx')};
    import {KeybindingProvider} from ${source('src/renderer/src/keybindings/KeybindingHost.tsx')};
    import {MemoryCuratorView} from ${source('src/renderer/src/components/MemoryCuratorView.tsx')};
    import {KnowledgePanel} from ${source('src/renderer/src/components/KnowledgePanel.tsx')};
    import {useMemoryCuratorSurface} from ${source('src/renderer/src/chatSurface/memoryCuratorSurface.ts')};
    import {applyTheme} from ${source('src/renderer/src/theme.ts')};import {builtinTheme} from ${source('src/shared/theme.ts')};
    applyTheme(builtinTheme('light')!);
    const style=document.createElement('style');style.textContent='html,body,#root{height:100%;margin:0;overflow:hidden}.fixture-app{height:100%;display:flex;flex-direction:column;min-width:0;min-height:0}.fixture-toolbar{display:flex;flex-wrap:wrap;gap:6px;padding:6px;flex-shrink:0}.fixture-panel{flex:1;min-height:0;max-height:none;box-sizing:border-box;border-radius:0}.fixture-body{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden}.fixture-body>.knowledge-panel{flex:1;min-width:0;overflow:auto}.fixture-title{padding:8px 12px;margin:0}.fixture-dispatch{padding:12px;flex:1}';document.head.append(style);
    function Fixture(){
      const {activeWorkspaceId,workspaces,switchWorkspace}=useWorkspaceStore();const workspaceId=activeWorkspaceId||'alpha';
      const [roles,setRoles]=useState<Record<string,'dispatch'|'memory'>>({});const purpose=roles[workspaceId]||'dispatch';
      const [entries,setEntries]=useState(false);
      const surface=useMemoryCuratorSurface(workspaceId,purpose==='memory'&&!entries);
      const api=useMemo(()=>Object.fromEntries(['list','search','decide','revise','supersede','restore','evidence','process','create','govern','undoGovernance','historySources','history']
        .map(name=>[name,(input:any)=>(window as any).api.knowledge[name](workspaceId,input)])),[workspaceId]);
      return <main className="fixture-app" data-workspace={workspaceId} data-purpose={purpose}>
        <div className="fixture-toolbar">
          <button className="ui-btn compact" onClick={()=>void switchWorkspace('alpha')}>工作区 Alpha</button>
          <button className="ui-btn compact" onClick={()=>void switchWorkspace('beta')}>工作区 Beta</button>
          <button className="ui-btn compact" onClick={()=>applyTheme(builtinTheme('light')!)}>浅色</button>
          <button className="ui-btn compact" onClick={()=>applyTheme(builtinTheme('dark')!)}>深色</button>
        </div>
        <section className="agent-float-panel fixture-panel">
          <div className="fixture-toolbar">
            <button className="ui-btn compact fixture-memory-toggle" aria-label={purpose==='memory'?'收起记忆子系统':'打开记忆子系统'} onClick={()=>setRoles(old=>({...old,[workspaceId]:purpose==='memory'?'dispatch':'memory'}))}>{purpose==='memory'?'收起记忆子系统':'打开记忆子系统'}</button>
            <button className="ui-btn compact" onClick={()=>setEntries(value=>!value)}>{entries?'返回会话':'知识条目'}</button>
            {purpose==='memory'&&!entries?<button className="ui-btn compact" onClick={()=>void surface?.actions.clear()}>清空记忆会话</button>:null}
          </div>
          <p className="fixture-title">{workspaceId==='alpha'?'Alpha':'Beta'} · {purpose==='memory'?'记忆子系统':'调度 Agent'}</p>
          <div className="fixture-body">
            {entries?<KnowledgePanel key={workspaceId} api={api as any} workspaceKey={workspaceId}/>:purpose==='memory'&&surface?
              <MemoryCuratorView key={workspaceId} surface={surface} workspaceId={workspaceId} cwd={workspaces.find(workspace=>workspace.id===workspaceId)?.path} active={true} disabled={false}/>:
              <div className="fixture-dispatch" aria-label="调度视图夹具">调度会话占位；本夹具只验证生产记忆组件与真实IPC，正式子系统入口另有AgentFloat浏览器回归。</div>}
          </div>
        </section>
      </main>;
    }
    createRoot(document.getElementById('root')!).render(<StoreProvider><KeybindingProvider><Fixture/></KeybindingProvider></StoreProvider>);
  `,'utf8');

  let application:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try{
    await build({entryPoints:[path.join(directory,'main.ts')],outfile:path.join(directory,'main.cjs'),platform:'node',format:'cjs',bundle:true,packages:'external',
      plugins:[{name:'fixture-existing-session-factory',setup(build){build.onResolve({filter:/curator[\\/]runtime(?:\.ts)?$/},args=>
        path.resolve(args.importer)===path.resolve(mockRuntime)?undefined:{path:mockRuntime});}}]});
    buildSync({entryPoints:[path.join(root,'src/preload/index.ts')],outfile:path.join(directory,'preload.cjs'),platform:'node',format:'cjs',bundle:true,external:['electron']});
    buildSync({entryPoints:[path.join(directory,'renderer.tsx')],outfile:path.join(directory,'renderer.js'),platform:'browser',format:'iife',bundle:true,jsx:'automatic',
      loader:{'.woff2':'file','.woff':'file','.ttf':'file','.webp':'file','.png':'file','.svg':'file','.jpg':'file','.jpeg':'file','.gif':'file','.avif':'file','.ico':'file'},
      define:{'process.env.NODE_ENV':'"production"','import.meta.env.DEV':'false'}});
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.NODE_OPTIONS;
    application=await electron.launch({executablePath:electronPath,args:[path.join(directory,'main.cjs')],env:env as Record<string,string>});
    const app=application,win=await app.firstWindow();
    const rendererErrors:string[]=[];win.on('pageerror',error=>rendererErrors.push(error.message));
    const stats=()=>app.evaluate(()=>((globalThis as any).__fixture.stats()));
    const records=()=>app.evaluate(()=>((globalThis as any).__fixture.records('alpha')));
    await expect(win.locator('main')).toHaveAttribute('data-workspace','alpha');
    await win.evaluate(()=>window.api.memoryCurator.state('alpha'));
    expect((await stats()).sessions).toBe(0);expect((await stats()).runs).toBe(0);
    const trigger=win.locator('.fixture-memory-toggle');
    await trigger.click();
    await expect(win.getByRole('region',{name:'记忆子系统会话'})).toBeVisible();
    await expect(win.getByText('这里只处理记忆的查询、整理、更正和删除，不执行工程任务。')).toBeVisible();
    await expect(win.locator('.memory-curator-status')).toHaveCount(0);
    expect((await stats()).runs).toBe(0);expect((await stats()).sessions).toBe(0);
    const receipt=await app.evaluate(()=>((globalThis as any).__fixture.note('alpha')));
    expect(receipt.queued).toBe(true);expect(receipt.reason).toContain('尚未');
    await expect.poll(async()=>((await records()).find((record:any)=>record.summary===summary)?.status)).toBe('active');
    await expect.poll(async()=>((await stats()).runs)).toBe(1);
    const learned=(await records()).find((record:any)=>record.summary===summary);
    expect(learned.origin).toBe('worker');expect(learned.evidence.some((item:any)=>item.observation==='tool_output'&&item.verification==='unverified')).toBe(true);
    expect((await stats()).toolNames).toEqual(['memory_candidates','memory_commit','memory_defer','memory_evidence','memory_search']);
    await expect(win.getByText('记忆已按实际事务回执保存。')).toBeVisible();
    await win.getByRole('button',{name:'知识条目',exact:true}).click();
    await expect(win.getByRole('heading',{name:summary,exact:true})).toBeVisible();
    await win.getByRole('button',{name:'记忆状态',exact:true}).click();
    await win.getByRole('option',{name:'已生效',exact:true}).click();
    await win.getByRole('button',{name:'刷新',exact:true}).click();
    expect((await stats()).runs).toBe(1);
    const beforeDelete=await win.evaluate(()=>window.api.knowledge.search('alpha',{query:'卸载组件时清理订阅'}));
    expect(beforeDelete.some(hit=>hit.record.id===learned.id)).toBe(true);
    const inspected=await win.evaluate(()=>window.api.memoryCurator.inspect('alpha',{state:'done',limit:30}));
    expect(inspected.items.some(item=>item.result?.recordId===learned.id&&item.result?.disposition==='active')).toBe(true);
    const completed=inspected.items.find(item=>item.result?.recordId===learned.id)!;
    const archived=await win.evaluate(id=>window.api.memoryCurator.setArchived('alpha',id,true),completed.id);
    expect(archived.changed).toBe(true);
    const visible=await win.evaluate(()=>window.api.memoryCurator.inspect('alpha',{state:'done'}));
    expect(visible.items.some(item=>item.id===completed.id)).toBe(false);
    const archive=await win.evaluate(()=>window.api.memoryCurator.inspect('alpha',{visibility:'archived'}));
    expect(archive.items.some(item=>item.id===completed.id&&item.archived)).toBe(true);
    expect((await records()).find((record:any)=>record.id===learned.id)?.status).toBe('active');
    expect((await stats()).runs).toBe(1);
    await win.evaluate(id=>window.api.memoryCurator.setArchived('alpha',id,false),completed.id);
    const restored=await win.evaluate(()=>window.api.memoryCurator.inspect('alpha',{state:'done'}));
    expect(restored.items.some(item=>item.id===completed.id&&!item.archived)).toBe(true);
    expect((await stats()).runs).toBe(1);
    // Deletion must remove the card even in the default all-state view.
    await win.getByRole('button',{name:'记忆状态',exact:true}).click();
    await win.getByRole('option',{name:'全部状态',exact:true}).click();
    await app.evaluate(()=>((globalThis as any).__fixture.note('alpha','late-delete')));
    await expect.poll(async()=>((await stats()).held)).toBe(true);
    await win.getByRole('article',{name:summary,exact:true}).getByRole('button',{name:'删除',exact:true}).click();
    await expect(win.getByRole('heading',{name:summary,exact:true})).toHaveCount(0);
    await app.evaluate(()=>((globalThis as any).__fixture.release()));
    await expect.poll(async()=>((await stats()).lateErrors.length)).toBe(1);
    expect((await stats()).lateErrors[0]).toMatch(/删除记录已变化|已被用户删除|已变化/);
    expect((await records()).find((record:any)=>record.id===learned.id).status).toBe('rejected');
    expect((await win.evaluate(()=>window.api.knowledge.list('alpha'))).deletedIds).toContain(learned.id);
    expect((await win.evaluate(()=>window.api.knowledge.search('alpha',{query:'卸载组件时清理订阅'}))).some(hit=>hit.record.id===learned.id)).toBe(false);
    await win.getByRole('button',{name:'刷新',exact:true}).click();
    await expect(win.getByRole('heading',{name:summary,exact:true})).toHaveCount(0);
    await win.getByRole('button',{name:'任务历史',exact:true}).click();
    await win.getByRole('button',{name:'历史类型',exact:true}).click();
    await win.getByRole('option',{name:'退场与删除记录',exact:true}).click();
    await expect(win.getByRole('heading',{name:summary,exact:true})).toBeVisible();
    await expect(win.getByRole('article',{name:summary,exact:true}).getByText('已删除',{exact:true})).toBeVisible();
    await expect(win.getByRole('article',{name:summary,exact:true}).getByRole('button',{name:'删除',exact:true})).toHaveCount(0);
    await win.getByRole('button',{name:'返回会话',exact:true}).click();
    await win.getByLabel('询问或更正记忆').fill('Alpha尚未发送的记忆草稿');
    await win.getByRole('button',{name:'工作区 Beta',exact:true}).click();
    await expect(win.locator('main')).toHaveAttribute('data-workspace','beta');
    await expect(win.locator('main')).toHaveAttribute('data-purpose','dispatch');
    await trigger.click();
    await expect(win.getByLabel('询问或更正记忆')).toHaveValue('');
    await win.getByLabel('询问或更正记忆').fill('请查询Beta的记忆');await win.getByLabel('询问或更正记忆').press('Enter');
    await expect(win.getByText('记忆查询完成：请查询Beta的记忆')).toBeVisible();
    const betaSnapshot=await app.evaluate(()=>((globalThis as any).__fixture.snapshot('beta')));
    await win.getByRole('button',{name:'工作区 Alpha',exact:true}).click();
    await expect(win.locator('main')).toHaveAttribute('data-purpose','memory');
    await expect(win.getByLabel('询问或更正记忆')).toHaveValue('Alpha尚未发送的记忆草稿');
    await expect(win.getByText('记忆查询完成：请查询Beta的记忆')).toHaveCount(0);
    const oldSnapshot=await app.evaluate(()=>((globalThis as any).__fixture.snapshot('alpha')));
    const callsBeforeClear=(await stats()).runs;
    await win.getByRole('button',{name:'清空记忆会话',exact:true}).click();
    await expect.poll(async()=>app.evaluate(()=>((globalThis as any).__fixture.snapshot('alpha').generation))).toBeGreaterThan(oldSnapshot.generation);
    await app.evaluate((_electron,snapshot)=>((globalThis as any).__fixture.oldPush({...snapshot,updatedAt:Date.now()+60000})),oldSnapshot);
    await expect(win.getByText('记忆已按实际事务回执保存。')).toHaveCount(0);
    await expect(win.getByLabel('询问或更正记忆')).toHaveValue('Alpha尚未发送的记忆草稿');
    expect((await records()).find((record:any)=>record.id===learned.id).status).toBe('rejected');
    expect((await stats()).runs).toBe(callsBeforeClear);
    expect((await app.evaluate(()=>((globalThis as any).__fixture.snapshot('beta')))).messages).toEqual(betaSnapshot.messages);
    // Persistent captures intentionally live outside the disposable profile.
    for(const theme of ['浅色','深色']){
      await win.getByRole('button',{name:theme,exact:true}).click();
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,820));
      await win.screenshot({path:path.join(captureDirectory,theme==='浅色'?'light-wide.png':'dark-wide.png'),animations:'disabled'});
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(390,820));
      await expect.poll(()=>win.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1);
      const memory=win.getByRole('region',{name:'记忆子系统会话',exact:true});
      await expect(memory).toBeVisible();
      const box=await memory.boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(-1);expect(box!.x+box!.width).toBeLessThanOrEqual(391);
      await expect(win.getByLabel('询问或更正记忆')).toHaveCSS('resize','none');
      await expect(memory.locator('.send-btn-icon')).toHaveCount(1);
      await win.screenshot({path:path.join(captureDirectory,theme==='浅色'?'light-390-memory.png':'dark-390-memory.png'),animations:'disabled'});
    }
    expect(rendererErrors).toEqual([]);
  }catch(error){
    if(application){const win=await application.firstWindow().catch(()=>undefined);if(win){console.error((await win.locator('body').innerText()).slice(0,6000));await win.screenshot({path:path.join(captureDirectory,'failure.png'),fullPage:true,timeout:5000}).catch(()=>{});}}
    throw error;
  }finally{
    if(application){await application.evaluate(()=>((globalThis as any).__fixture?.shutdown())).catch(()=>{});await application.close();}
    // Keep fixture bundles, isolated workspaces and captures reviewable; delete only our profile.
    expect(path.resolve(profile).startsWith(path.resolve(directory)+path.sep)).toBe(true);
    fs.rmSync(profile,{recursive:true,force:true,maxRetries:3});
  }
});
