/** Real Electron IPC + preload + production React + real Git snapshot, isolated profile. */
import {test,expect,_electron as electron} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const root=path.resolve(__dirname,'../..'),requireNode=createRequire(__filename);
const {buildSync}=requireNode('esbuild') as typeof import('esbuild');
const electronPath=requireNode('electron') as string;

test('真实轮次Diff、知识修订恢复与失效依据',async()=>{
  test.setTimeout(90000);
  const directory=path.join(root,'.tmp',`knowledge-e2e-${randomUUID()}`);fs.mkdirSync(directory,{recursive:true});
  const source=(file:string)=>JSON.stringify(path.join(root,file).replace(/\\/g,'/'));
  fs.writeFileSync(path.join(directory,'main.ts'),`
    import {app,BrowserWindow} from 'electron';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
    import {MemoryService} from ${source('src/main/memory/service.ts')};
    import {setMemoryService} from ${source('src/main/memory/serviceRef.ts')};
    import {setUserProfileFilePath} from ${source('src/main/memory/userProfile.ts')};
    import {registerKnowledgeIpc} from ${source('src/main/memory/knowledgeIpc.ts')};
    import {turnChanges} from ${source('src/main/turnChanges/runtime.ts')};
    app.setPath('userData',path.join(__dirname,'profile'));
    app.whenReady().then(async()=>{
      const work=path.join(__dirname,'work');fs.mkdirSync(work,{recursive:true});
      execFileSync('git',['init','-b','main'],{cwd:work,windowsHide:true});
      fs.writeFileSync(path.join(work,'app.ts'),'export const cleanup = false;\\n');
      execFileSync('git',['add','app.ts'],{cwd:work,windowsHide:true});
      execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','baseline'],{cwd:work,windowsHide:true});
      fs.mkdirSync(path.join(work,'docs','memory'),{recursive:true});
      fs.writeFileSync(path.join(work,'docs','memory','MEMORY.md'),'旧系统重复任务摘要');
      const svc=new MemoryService();setMemoryService(svc);setUserProfileFilePath(app.getPath('userData'));
      const store=svc.knowledge(work);
      if(!fs.existsSync(path.join(work,'docs','memory','MEMORY.md')))throw new Error('旧核心文件不应被自动清理');
      const capture=turnChanges().begin('gui:session','turn',work,[work]);await capture.ready;
      await capture.toolStart('edit','write',{path:'app.ts',content:'export const cleanup = true;\\n'},undefined,true);
      fs.writeFileSync(path.join(work,'app.ts'),'export const cleanup = true;\\n');await capture.toolEnd('edit',true,undefined,true);
      const snapshot=await capture.finish();if(!snapshot.repository?.scopeStable)throw new Error('missing actual Git identity');
      const result=store.submit({kind:'reusable_lesson',summary:'组件卸载时清理订阅',problem:'重复事件回调',action:'在effect返回取消订阅函数',rationale:'挂载卸载回归通过',applicability:['React组件订阅'],expectedFutureUse:'避免重复回调',repoKey:work,branch:'main'},
        {namespace:'worker',origin:'worker',evidence:[{id:'event',source:'gui-session',eventTime:Date.now(),sessionId:'session',turnId:'turn',snapshotId:snapshot.id,repoKey:work,branch:'main',verification:'unverified'}]});
      (globalThis as any).__record=result.record;(globalThis as any).__store=store;(globalThis as any).__snapshot=snapshot;
      (globalThis as any).__removeEvidence=()=>fs.unlinkSync(path.join(app.getPath('userData'),'turn-changes',snapshot.id+'.json'));
      const ctx:any={config:{get:()=>({activeWorkspaceId:'fixture',workspaces:[{id:'fixture',path:work}]})},ui:{notify(){}}};
      registerKnowledgeIpc(ctx);
      fs.writeFileSync(path.join(__dirname,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
      const win=new BrowserWindow({width:900,height:850,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:false}});
      await win.loadFile(path.join(__dirname,'index.html'));
      app.on('before-quit',()=>svc.closeAll());
    }).catch(error=>{console.error(error);app.exit(1);});app.on('window-all-closed',()=>app.quit());
  `);
  fs.writeFileSync(path.join(directory,'renderer.tsx'),`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {KnowledgePanel} from ${source('src/renderer/src/components/KnowledgePanel.tsx')};
    import ${source('src/renderer/src/styles/base.css')};import ${source('src/renderer/src/styles/memory.css')};
    import {applyTheme} from ${source('src/renderer/src/theme.ts')};import {builtinTheme} from ${source('src/shared/theme.ts')};
    applyTheme(builtinTheme('light')!);
    const api=Object.fromEntries(['list','search','decide','revise','supersede','restore','evidence','process','create','govern','undoGovernance','historySources','history'].map(name=>[name,(input:any)=>(window as any).api.knowledge[name]('fixture',input)]));
    createRoot(document.getElementById('root')!).render(<KnowledgePanel api={api as any} workspaceKey="fixture"/>);
  `);
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try{
    buildSync({entryPoints:[path.join(directory,'main.ts')],outfile:path.join(directory,'main.cjs'),platform:'node',format:'cjs',bundle:true,packages:'external'});
    buildSync({entryPoints:[path.join(root,'src/preload/index.ts')],outfile:path.join(directory,'preload.cjs'),platform:'node',format:'cjs',bundle:true,external:['electron']});
    buildSync({entryPoints:[path.join(directory,'renderer.tsx')],outfile:path.join(directory,'renderer.js'),platform:'browser',format:'iife',bundle:true,jsx:'automatic',loader:{'.woff2':'file','.woff':'file'},define:{'process.env.NODE_ENV':'"production"'}});
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.NODE_OPTIONS;
    app=await electron.launch({executablePath:electronPath,args:[path.join(directory,'main.cjs')],env:env as Record<string,string>});
    const win=await app.firstWindow();
    await expect(win.getByRole('heading',{name:'组件卸载时清理订阅'})).toBeVisible();
    await win.getByRole('button',{name:'查看依据与修订'}).click();
    await win.getByRole('button',{name:'核对快照依据'}).first().click();
    await win.getByRole('button',{name:'app.ts',exact:true}).click();
    await expect(win.locator('.knowledge-diff')).toContainText('+export const cleanup = true;');
    await win.getByRole('button',{name:'修订内容与条件'}).click();
    await expect(win.getByRole('button',{name:'保存并生效'})).toBeVisible({timeout:5000});
    await win.getByLabel('方法',{exact:true}).fill('新的取消订阅方法');
    await win.getByRole('button',{name:'保存并生效'}).click();
    await expect(win.getByText('新的取消订阅方法',{exact:false}).first()).toBeVisible();
    await win.getByRole('button',{name:'撤销本次修改'}).click();
    await expect(win.getByText('在effect返回取消订阅函数',{exact:false}).first()).toBeVisible();
    await app.evaluate(()=> (globalThis as any).__removeEvidence());
    await win.getByRole('button',{name:'核对快照依据'}).first().click();
    await expect(win.getByText(/依据不可用/)).toBeVisible();
    const audit=await app.evaluate(()=> (globalThis as any).__store.list().records[0]);
    expect(audit.revision).toBeGreaterThan(1);expect(audit.action).toBe('在effect返回取消订阅函数');
    await win.screenshot({path:path.join(root,'.tmp/knowledge-electron.png'),fullPage:true});
  }catch(error){if(app){const win=await app.firstWindow();console.error((await win.locator('body').innerText()).slice(0,6000));await win.screenshot({path:path.join(root,'.tmp/knowledge-electron-failure.png'),fullPage:true,timeout:5000}).catch(()=>{});}throw error;
  }finally{await app?.close();expect(directory.startsWith(path.join(root,'.tmp')+path.sep)).toBe(true);fs.rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});
