import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const root = path.resolve(__dirname, '..', '..');
const requireNode = createRequire(__filename);
const { buildSync } = requireNode('esbuild') as typeof import('esbuild');
const electronPath = requireNode('electron') as string;

test('only the latest usable snapshot is shown and the older records are retired after persistence', async () => {
  test.setTimeout(60_000);
  const dir = path.join(root, '.tmp', `turn-snapshot-retention-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const source = (file: string) => JSON.stringify(path.join(root, file).replace(/\\/g, '/'));
  const main = path.join(dir, 'main.ts');
  fs.writeFileSync(main, `
    import { app, BrowserWindow } from 'electron';
    import fs from 'node:fs'; import path from 'node:path'; import { randomUUID } from 'node:crypto';
    import { registerTurnChangesIpc } from ${source('src/main/turnChanges/ipc.ts')};
    import { startTurnChangesCleanupSweeper } from ${source('src/main/turnChanges/cleanup.ts')};
    import { turnChanges } from ${source('src/main/turnChanges/runtime.ts')};
    const profile = path.join(__dirname, 'profile'); fs.mkdirSync(profile, {recursive:true});
    app.setPath('userData', profile);
    app.whenReady().then(async () => {
      const dir = path.join(profile, 'turn-changes'); fs.mkdirSync(dir);
      const create = (name: string, save = true) => {
        const id=randomUUID(), messageId='message-'+name;
        const summary={id,state:'ready',warnings:[],files:[{path:name+'.ts',kind:'modified',added:1,removed:1,revertible:true}]};
        const message={id:messageId,role:'assistant',parts:[],ts:Date.now(),turnChanges:summary};
        if(save) fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({owner:'gui:session',messageId,roots:[],summary,files:[{view:summary.files[0],abs:name+'.ts',before:null,beforeHash:null,after:null,diff:'--- a/a.ts\\n+++ b/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n'}]}));
        return message;
      };
      const old=create('old'), latest=create('latest'), missing=create('missing',false);
      const entry:any={sessionId:'session',cwd:__dirname,messages:[old,latest,missing],closed:false};
      let durable=structuredClone(entry.messages), win:BrowserWindow;
      const ctx:any={ getWindow:()=>win, sessions:{get:(id:string)=>id==='session'?{}:undefined},
        config:{get:()=>({workspaces:[]})}, notify:{push(){}} };
      ctx.agentSessions={ctx,entries:new Map([['session',entry]]),pushSubs:new Set(),
        store:{save(){},loadForReviewRetention:async()=>structuredClone(durable)},getWorkspaceContext:()=>undefined};
      registerTurnChangesIpc(ctx);
      startTurnChangesCleanupSweeper(ctx,profile,turnChanges());
      (globalThis as any).__fixtureIds={old:old.turnChanges.id,latest:latest.turnChanges.id};
      (globalThis as any).__publish=()=>{
        const next=create('newest'); entry.messages.push(next);
        (globalThis as any).__fixtureIds.newest=next.turnChanges.id;
        win.webContents.send('agentSession:event',{kind:'sync',sessionId:'session',messages:entry.messages});
        turnChanges().requestRetention('gui:session');
      };
      (globalThis as any).__persist=()=>{durable=structuredClone(entry.messages);turnChanges().requestRetention('gui:session');};
      (globalThis as any).__exists=(id:string)=>fs.existsSync(path.join(dir,id+'.json'));
      fs.writeFileSync(path.join(__dirname,'index.html'), '<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><body><div id="root"></div><script>window.__messages='+JSON.stringify(entry.messages)+'</script><script src="renderer.js"></script></body></html>');
      win=new BrowserWindow({width:800,height:500,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:false}});
      await win.loadFile(path.join(__dirname,'index.html'));
    }).catch(error=>{console.error(error);app.exit(1)});
    app.on('window-all-closed',()=>app.quit());
  `);
  const renderer = path.join(dir, 'renderer.tsx');
  fs.writeFileSync(renderer, `
    import React,{useEffect,useState} from 'react'; import {createRoot} from 'react-dom/client';
    import ${source('src/renderer/src/i18n.ts')};
    import ${source('src/renderer/src/styles/base.css')};
    import ${source('src/renderer/src/styles/git.css')};
    import ${source('src/renderer/src/styles/turn-changes.css')};
    import {TurnChangesCard} from ${source('src/renderer/src/chatSurface/TurnChangesCard.tsx')};
    import {TurnSnapshotVisibilityProvider} from ${source('src/renderer/src/chatSurface/TurnSnapshotVisibility.tsx')};
    function Fixture(){
      const [messages,setMessages]=useState((window as any).__messages);
      useEffect(()=>window.api.on('agentSession:event',(event:any)=>{if(event.kind==='sync'&&event.sessionId==='session')setMessages(event.messages)}),[]);
      const owner={kind:'gui' as const,id:'session'};
      return <main style={{padding:16}}><TurnSnapshotVisibilityProvider owner={owner} messages={messages}>
        {messages.map((m:any)=><TurnChangesCard key={m.id} summary={m.turnChanges} target={{...owner,messageId:m.id}}/>)}
      </TurnSnapshotVisibilityProvider></main>;
    }
    createRoot(document.getElementById('root')!).render(<Fixture/>);
  `);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    buildSync({ entryPoints: [main], outfile: path.join(dir, 'main.cjs'), platform: 'node', format: 'cjs', bundle: true, external: ['electron'] });
    buildSync({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(dir, 'preload.cjs'), platform: 'node', format: 'cjs', bundle: true, external: ['electron'] });
    buildSync({ entryPoints: [renderer], outfile: path.join(dir, 'renderer.js'), platform: 'browser', format: 'iife', bundle: true, jsx: 'automatic', loader: { '.woff2': 'file', '.woff': 'file' }, define: { 'process.env.NODE_ENV': '"production"' } });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS']) delete env[key];
    app = await electron.launch({ executablePath: electronPath, args: [path.join(dir, 'main.cjs')], env });
    const win = await app.firstWindow();
    await expect(win.getByRole('button', { name: /latest\.ts/ })).toBeVisible();
    await expect(win.getByRole('button', { name: /old\.ts|missing\.ts/ })).toHaveCount(0);
    await expect(win.locator('.turn-changes-card')).toHaveCount(1);
    const ids = await app.evaluate(() => (globalThis as any).__fixtureIds);
    await app.evaluate(() => (globalThis as any).__publish());
    await expect(win.getByRole('button', { name: /newest\.ts/ })).toBeVisible();
    await expect(win.getByRole('button', { name: /latest\.ts/ })).toHaveCount(0);
    await new Promise(resolve => setTimeout(resolve, 1800));
    expect(await app.evaluate((_electron, id) => (globalThis as any).__exists(id), ids.latest)).toBe(true);
    await app.evaluate(() => (globalThis as any).__persist());
    await expect.poll(() => app!.evaluate((_electron, id) => (globalThis as any).__exists(id), ids.latest), { timeout: 6000 }).toBe(false);
    expect(await app.evaluate((_electron, id) => (globalThis as any).__exists(id), ids.old)).toBe(false);
    const newest = await app.evaluate(() => (globalThis as any).__fixtureIds.newest);
    expect(await app.evaluate((_electron, id) => (globalThis as any).__exists(id), newest)).toBe(true);
  } finally {
    await app?.close();
    expect(dir.startsWith(path.join(root, '.tmp') + path.sep)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
