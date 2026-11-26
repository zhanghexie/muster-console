/** Hidden Electron window, isolated userData and the production preload/IPC adapter. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

test('one scan requires all sessions before deleting a shared worktree through real IPC', async () => {
  const root = path.resolve(__dirname, '../..'), temporary = path.join(root, '.tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(temporary, 'storage-ipc-e2e-'));
  const userData = path.join(fixture, 'userData'), themes = path.join(userData, 'themes');
  fs.mkdirSync(themes, { recursive: true });
  const bundle = path.join(fixture, 'storage.cjs'), bootstrap = path.join(fixture, 'bootstrap.cjs');
  const preload = path.join(root, 'out/preload/index.js');
  const missingTree = path.join(fixture, 'missing-worktree');
  buildSync({ stdin: { contents: "export { registerLocalStorageIpc } from './src/main/ipc/localStorage'; export { ThemeService } from './src/main/themes';", resolveDir: root, sourcefile: 'storage-ipc-entry.ts', loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['electron'], logLevel: 'silent' });
  fs.writeFileSync(bootstrap, `
const {app,BrowserWindow,session:electronSession}=require('electron');
const http=require('node:http');
app.setPath('userData',${JSON.stringify(userData)});
let win;
app.whenReady().then(async()=>{
  const modules=require(${JSON.stringify(bundle)});
  let state={workspaces:[{id:'ws',name:'Workspace'}],themeId:'dark',activeWorkspaceId:'ws'};
  const config={get:()=>state,update:patch=>{state={...state,...patch}}};
  const themes=new modules.ThemeService(${JSON.stringify(userData)},config);
  const owner={id:'00000000-0000-4000-8000-000000000001',name:'Missing task',type:'terminal',workspaceId:'ws',archived:true,status:'exited',worktreePath:${JSON.stringify(missingTree)}};
  const borrower={id:'00000000-0000-4000-8000-000000000002',name:'Sharing chat',type:'terminal',workspaceId:'other',archived:false,status:'running',cwd:owner.worktreePath};
  let rows=[owner,borrower];
  const sessions={
    rootDependencyRoster:()=>structuredClone(rows),
    preflightLocalStorageWorktree:async (id,dependencies)=>{
      if(id!==owner.id || !dependencies.has(owner.id) || !dependencies.has(borrower.id)) throw new Error('unexpected plan');
      return {ok:true};
    },
    cleanupArchivedWorktree:async id=>{
      if(id!==owner.id || rows.length!==1 || !rows[0].retainedWorktreeOnly) throw new Error('sessions must be removed first');
      rows=[]; return {ok:true};
    },
    deleteLocalStorageSession:async id=>{
      if(id===owner.id) rows[0]={...owner,retainedWorktreeOnly:true};
      else if(id===borrower.id) rows=rows.filter(row=>row.id!==id);
      else throw new Error('unexpected session');
    }
  };
  themes.create('Fixture theme');
  modules.registerLocalStorageIpc({config,sessions,themes,getWindow:()=>win});
  win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false}});
  await win.loadURL('data:text/html,<html><body>storage IPC fixture</body></html>');
  const server=http.createServer((_req,res)=>res.end('<html>site fixture</html>'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const browserSession=electronSession.fromPartition('persist:browser');
  await browserSession.cookies.set({url,name:'fixture',value:'cookie'});
  const guest=new BrowserWindow({show:false,webPreferences:{partition:'persist:browser'}});
  app.on('window-all-closed',()=>{});
  await guest.loadURL(url);
  await guest.webContents.executeJavaScript("localStorage.setItem('fixture','value')");
  guest.close();
  globalThis.fixtureUrl=url;
  app.on('before-quit',()=>server.close());
  await win.webContents.executeJavaScript('window.fixtureReady=true');
});
`);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap, '--no-sandbox'], cwd: fixture, env, timeout: 30000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => (window as Window & { fixtureReady?: boolean }).fixtureReady === true);
    const result = await page.evaluate(async () => {
      const snapshot = await window.api.localStorage.scan();
      const theme = snapshot.items.find(item => item.category === 'themes' && item.name === 'Fixture theme');
      const tree = snapshot.items.find(item => item.category === 'worktrees' && item.name === 'Missing task');
      const owner = snapshot.items.find(item => item.category === 'sessions' && item.name === 'Missing task');
      const borrower = snapshot.items.find(item => item.category === 'sessions' && item.name === 'Sharing chat');
      if (!theme || theme.action !== 'theme' || !theme.bytes) throw new Error('Fixture theme was not found');
      if (!tree || tree.action !== 'worktree' || tree.pathStatuses?.[0]?.status !== 'missing') throw new Error('Missing worktree was not reviewable');
      if (owner?.action !== 'session' || borrower?.action !== 'session' || !borrower.stopsSession) throw new Error('Dependent sessions were not reviewable');
      if (snapshot.dependencies?.filter(edge => edge.prerequisiteId === tree.id).length !== 2) throw new Error('A worktree dependency was omitted');
      const clean = async (ids: string[]) => {
        const job = await window.api.localStorage.startCleanup(snapshot.id, ids.map(id => ({ id })));
        let status = await window.api.localStorage.cleanupStatus(job.id);
        for (let attempt = 0; !status.done && attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 25));
          status = await window.api.localStorage.cleanupStatus(job.id);
        }
        return status;
      };
      const browser = snapshot.items.find(item => item.action === 'browserData');
      if (!browser) throw new Error('Browser partition was not found');
      const browserResult = await clean([browser.id]);
      const missingConsent = await clean([tree.id]);
      const status = await clean([tree.id, owner.id, borrower.id, theme.id]);
      const refreshed = await window.api.localStorage.scan();
      return { missingConsent, status, browserResult, relatedRemains: refreshed.items.some(item => item.category === 'worktrees' || item.action === 'session') };
    });
    expect(result.browserResult.results.map(item => item.status)).toEqual(['completed']);
    const browserState = await app.evaluate(async ({ session, BrowserWindow }) => {
      const url = (globalThis as typeof globalThis & { fixtureUrl: string }).fixtureUrl;
      const cookies = await session.fromPartition('persist:browser').cookies.get({ url });
      const guest = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:browser' } });
      await guest.loadURL(url);
      const value = await guest.webContents.executeJavaScript("localStorage.getItem('fixture')");
      guest.close();
      return { cookies, value };
    });
    expect(browserState.cookies).toHaveLength(0);
    expect(browserState.value).toBeNull();
    expect(result.status.done).toBe(true);
    expect(result.missingConsent.error).toContain('缺少必删项目');
    expect(result.missingConsent.results).toEqual([]);
    expect(result.status.results.map(item => item.status)).toEqual(['started', 'started', 'completed', 'completed']);
    expect(result.relatedRemains).toBe(false);
    expect(fs.readdirSync(themes)).toEqual([]);
  } finally {
    if (app) {
      const child = app.process();
      await app.close();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Electron fixture did not exit before cleanup')), 10000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); }
        });
      }
    }
    const target = path.resolve(fixture), parent = path.resolve(temporary);
    expect(target.startsWith(`${parent}${path.sep}storage-ipc-e2e-`)).toBe(true);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
