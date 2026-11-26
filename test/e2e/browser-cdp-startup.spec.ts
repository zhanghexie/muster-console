import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(__dirname, '../..');
const electron = createRequire(__filename)('electron') as string;

test('OS-selected CDP keeps native guest automation and rejects an unrelated listener', async ({}, info) => {
  test.setTimeout(60_000);
  const root = info.outputDir;
  fs.mkdirSync(root, { recursive: true });
  const bundle = path.join(root, 'browser-fixture.cjs');
  await build({
    stdin: { resolveDir: repo, sourcefile: 'browser-cdp-entry.ts', contents: [
      "export { configureBrowserCdpAtBoot, getBrowserCdpBootState } from './src/main/browser/cdpBoot';",
      "export { BrowserTabService } from './src/main/browser/tabs';",
      "export { startCdpTypeProxy } from './src/main/browser/cdpTypeProxy';"
    ].join('\n') },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent'
  });
  fs.writeFileSync(path.join(root, 'host.html'), '<!doctype html><html><body><webview partition="persist:browser" src="data:text/html,%3Ctitle%3ECDP%20fixture%3C/title%3E%3Cbutton%3Eready%3C/button%3E" style="display:flex;width:800px;height:600px"></webview></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const root=process.env.MA_CDP_TEST_ROOT,mode=process.env.MA_CDP_TEST_MODE;
const data=path.join(root,mode+'-data');fs.mkdirSync(data,{recursive:true});app.setPath('userData',data);app.setName('MetaAgent');
if(mode==='disabled')fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({browser:{cdpEnabled:false}}));
if(mode==='normal')app.commandLine.appendSwitch('disable-blink-features','ExistingUnrelatedFeature');
if(mode==='explicit-automation')app.commandLine.appendSwitch('enable-automation');
if(mode==='explicit-feature')app.commandLine.appendSwitch('enable-blink-features','AutomationControlled');
const {configureBrowserCdpAtBoot,getBrowserCdpBootState,BrowserTabService,startCdpTypeProxy}=require(path.join(root,'browser-fixture.cjs'));
configureBrowserCdpAtBoot();
const done=result=>{fs.writeFileSync(path.join(root,mode+'-result.json'),JSON.stringify(result));app.exit(result.ok?0:1)};
app.whenReady().then(async()=>{try{
  const win=new BrowserWindow({show:false,webPreferences:{webviewTag:true}});
  const svc=new BrowserTabService(()=>win,{get:()=>({browser:{cdpEnabled:mode!=='disabled'}}),update:()=>{}});
  if(mode==='disabled'){const port=await svc.cdpPort();done({ok:port===0&&getBrowserCdpBootState().kind==='disabled',port});return}
  if(mode==='explicit-automation'||mode==='explicit-feature'){
    await win.loadURL('data:text/html,owner');
    const port=await svc.cdpPort(),webdriver=await win.webContents.executeJavaScript('navigator.webdriver');
    const disabledFeatures=app.commandLine.getSwitchValue('disable-blink-features');
    done({ok:port>0&&webdriver===true&&!disabledFeatures.split(',').includes('AutomationControlled'),port,webdriver,disabledFeatures});return;
  }
  if(mode==='collision'){
    await win.loadURL('data:text/html,owner');
    try{await svc.cdpPort();done({ok:false,error:'accepted unrelated endpoint'})}
    catch(error){done({ok:/不属于当前工作台/.test(String(error)),error:String(error)})}
    return;
  }
  win.webContents.on('did-attach-webview',(_event,guest)=>{guest.debugger.attach('1.3');guest.on('dom-ready',async()=>{try{
    const port=await svc.cdpPort(),state=getBrowserCdpBootState(),targetId=guest.getOrCreateDevToolsTargetId();
    const before=await guest.executeJavaScript('({webdriver:navigator.webdriver,userAgent:navigator.userAgent})');
    const proxy=await startCdpTypeProxy(port),pw=await require('playwright-core').chromium.connectOverCDP('http://127.0.0.1:'+proxy.port);
    let found=null;for(let attempt=0;attempt<12&&!found;attempt++){
      for(const ctx of pw.contexts())for(const page of ctx.pages()){
        let cdp=null;try{cdp=await ctx.newCDPSession(page);const r=await cdp.send('Target.getTargetInfo');if(r.targetInfo?.targetId===targetId){found=page;break}}finally{await cdp?.detach().catch(()=>{})}
      }
      if(!found)await new Promise(resolve=>setTimeout(resolve,250));
    }
    if(!found){done({ok:false,error:'guest target was not discovered'});return}
    const title=await found.title(),buttons=await found.locator('button').count(),after=await found.evaluate(()=>navigator.webdriver);
    done({ok:state.kind==='enabled'&&port>0&&before.webdriver===false&&after===false&&title==='CDP fixture'&&buttons===1&&before.userAgent.includes('Chrome/'+process.versions.chrome)&&before.userAgent.includes('Electron/'+process.versions.electron)&&!before.userAgent.includes('ZCode/'),port,before,after,title,buttons,disabledFeatures:app.commandLine.getSwitchValue('disable-blink-features')});
  }catch(error){done({ok:false,error:String(error)})}})});
  await win.loadFile(path.join(root,'host.html'));
}catch(error){done({ok:false,error:String(error)})}});
setTimeout(()=>done({ok:false,error:'fixture timeout'}),25000);
`);

  async function run(mode: 'normal' | 'disabled' | 'collision' | 'explicit-automation' | 'explicit-feature', port?: number): Promise<Record<string, unknown>> {
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      MA_CDP_TEST_ROOT: root, MA_CDP_TEST_MODE: mode
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.MUSTER_DEVTOOLS_PORT;
    if (port) env.MUSTER_DEVTOOLS_PORT = String(port);
    const child = spawn(electron, [path.join(root, 'main.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => child.kill(), 30_000);
    let code: number | null;
    try { [code] = await once(child, 'exit') as [number | null]; } finally { clearTimeout(timeout); }
    const resultPath = path.join(root, `${mode}-result.json`);
    expect(fs.existsSync(resultPath), `${mode}: Electron should write its result`).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(code, `${mode}: ${JSON.stringify(result)}`).toBe(0);
    expect(result.ok, `${mode}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  }

  const normal = await run('normal');
  expect(normal.port).toBeGreaterThan(0);
  expect(String(normal.disabledFeatures).split(',')).toEqual(['ExistingUnrelatedFeature', 'AutomationControlled']);
  await run('disabled');
  await run('explicit-automation');
  await run('explicit-feature');
  const other = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('[{"id":"other-app"}]'); });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  try {
    const address = other.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener has no TCP port');
    await run('collision', address.port);
  } finally {
    other.closeAllConnections();
    await new Promise<void>(resolve => other.close(() => resolve()));
  }
});

test('concurrent instances bind distinct free ports and ignore a stale port file', async ({}, info) => {
  test.setTimeout(60_000);
  const root = info.outputDir;
  fs.mkdirSync(root, { recursive: true });
  const bundle = path.join(root, 'concurrent-fixture.cjs');
  await build({
    stdin: { resolveDir: repo, sourcefile: 'browser-cdp-concurrent.ts', contents: [
      "export { configureBrowserCdpAtBoot } from './src/main/browser/cdpBoot';",
      "export { BrowserTabService } from './src/main/browser/tabs';"
    ].join('\n') },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent'
  });
  fs.writeFileSync(path.join(root, 'concurrent-main.cjs'), `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const root=process.env.MA_CDP_CONCURRENT_ROOT,id=process.env.MA_CDP_CONCURRENT_ID;
const data=path.join(root,id+'-data');fs.mkdirSync(data,{recursive:true});app.setPath('userData',data);app.setName('MetaAgent');
fs.writeFileSync(path.join(data,'DevToolsActivePort'),process.env.MA_CDP_STALE_PORT+'\\n/stale');
const {configureBrowserCdpAtBoot,BrowserTabService}=require(path.join(root,'concurrent-fixture.cjs'));
configureBrowserCdpAtBoot();
const done=result=>{fs.writeFileSync(path.join(root,id+'-result.json'),JSON.stringify(result));if(!result.ok)app.exit(1)};
app.whenReady().then(async()=>{try{
  const win=new BrowserWindow({show:false});await win.loadURL('data:text/html,owner');
  const svc=new BrowserTabService(()=>win,{get:()=>({browser:{cdpEnabled:true}}),update:()=>{}});
  const port=await svc.cdpPort(),webdriver=await win.webContents.executeJavaScript('navigator.webdriver');
  done({ok:port>0&&webdriver===false,port,webdriver,switchPort:app.commandLine.getSwitchValue('remote-debugging-port')});
  const wait=setInterval(()=>{if(fs.existsSync(path.join(root,id+'-release'))){clearInterval(wait);app.exit(0)}},50);
}catch(error){done({ok:false,error:String(error)})}});
setTimeout(()=>app.exit(2),30000);
`);
  const occupied = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('[{"id":"other-app"}]'); });
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('fixture listener has no TCP port');
  const ids = ['one', 'two', 'three'];
  const children = ids.map(id => {
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      MA_CDP_CONCURRENT_ROOT: root, MA_CDP_CONCURRENT_ID: id, MA_CDP_STALE_PORT: String(address.port)
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.MUSTER_DEVTOOLS_PORT;
    return spawn(electron, [path.join(root, 'concurrent-main.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'ignore' });
  });
  try {
    await expect.poll(() => ids.every(id => fs.existsSync(path.join(root, `${id}-result.json`))), { timeout: 20_000 }).toBe(true);
    const results = ids.map(id => JSON.parse(fs.readFileSync(path.join(root, `${id}-result.json`), 'utf8')) as {
      ok: boolean; port: number; webdriver: boolean; switchPort: string; error?: string
    });
    for (const result of results) {
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.switchPort).toBe('0');
      expect(result.port).toBeGreaterThan(0);
      expect(result.port).not.toBe(address.port);
      expect(result.webdriver).toBe(false);
    }
    expect(new Set(results.map(result => result.port)).size).toBe(ids.length);
    expect((await fetch(`http://127.0.0.1:${address.port}/json/list`)).ok).toBe(true);
  } finally {
    for (const id of ids) fs.writeFileSync(path.join(root, `${id}-release`), 'release');
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const timeout = setTimeout(() => child.kill(), 5000);
      try { await once(child, 'exit'); } finally { clearTimeout(timeout); }
    }));
    occupied.closeAllConnections();
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});

test('full workbench browser tools use the owned OS-selected port and real engine identity', async ({}, info) => {
  test.setTimeout(60_000);
  const cwd = info.outputDir;
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  const workspace = path.join(cwd, 'workspace');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', activeWorkspaceId: 'browser-cdp', defaultCwd: workspace,
    workspaces: [{ id: 'browser-cdp', name: 'CDP test', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>CDP workbench fixture</title><button>Browser tool fixture</button>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listener has no TCP port');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `browser-cdp-${process.pid}`,
    MUSTER_WEB_PORT: '0', APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata')
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: electron, args: [repo, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 60_000 });
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 45_000 });
    const shellApiPath = path.join(userData, 'shell-api.json');
    await expect.poll(() => fs.existsSync(shellApiPath), { timeout: 30_000 }).toBe(true);
    const toolUrl = (JSON.parse(fs.readFileSync(shellApiPath, 'utf8')) as { toolUrl: string }).toolUrl;
    const tool = async (action: string, params: Record<string, unknown>) => {
      const response = await fetch(toolUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ name: 'host.browser.run', arguments: { action, params } })
      });
      expect(response.ok).toBe(true);
      const result = await response.json() as { ok: boolean; result: unknown };
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result.result;
    };
    const opened = await tool('open', { url: `http://127.0.0.1:${address.port}/` }) as { id: string };
    const snapshot = await tool('snapshot', { tabId: opened.id });
    expect(JSON.stringify(snapshot)).toContain('Browser tool fixture');
    const cdp = await win.evaluate(() => window.api.browser.cdp());
    expect(cdp.enabled).toBe(true);
    expect(cdp.port).toBeGreaterThan(0);
    const engine = await app.evaluate(({ app }) => ({
      port: app.commandLine.getSwitchValue('remote-debugging-port'),
      disabledBlinkFeatures: app.commandLine.getSwitchValue('disable-blink-features'),
      chrome: process.versions.chrome, electron: process.versions.electron
    }));
    expect(engine.port).toBe('0');
    expect(engine.disabledBlinkFeatures.split(',')).toContain('AutomationControlled');
    const allocatedPort = Number(fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    expect(allocatedPort).toBe(cdp.port);
    const view = win.locator(`webview[data-tab-id="${opened.id}"]`);
    const guestId = await view.evaluate(el => (el as Electron.WebviewTag).getWebContentsId());
    const identity = await app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id);
      if (!guest) throw new Error('missing guest');
      return guest.executeJavaScript('({webdriver:navigator.webdriver,userAgent:navigator.userAgent})') as Promise<{ webdriver: boolean; userAgent: string }>;
    }, guestId);
    expect(identity.webdriver).toBe(false);
    expect(identity.userAgent).toContain(`Chrome/${engine.chrome}`);
    expect(identity.userAgent).toContain(`Electron/${engine.electron}`);
    expect(identity.userAgent).not.toContain('ZCode/');
  } finally {
    if (app) {
      const proc = app.process();
      await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (proc.exitCode === null && proc.pid) {
        if (process.platform === 'win32') {
          try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
        } else proc.kill('SIGKILL');
      }
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
