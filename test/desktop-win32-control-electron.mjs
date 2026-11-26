import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

if (process.platform !== 'win32') throw new Error('This integration probe requires Windows');
const executable = process.env.DESKTOP_TEST_ELECTRON;
if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('DESKTOP_TEST_ELECTRON must name an installed Electron executable');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-control-electron-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const sharp = createRequire(import.meta.url).resolve('sharp');
  const shim = path.join(temp, 'compiled', 'node_modules', 'sharp');
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ name: 'sharp', main: 'index.cjs' }));
  fs.writeFileSync(path.join(shim, 'index.cjs'), `module.exports = require(${JSON.stringify(sharp)});`);
  const load = file => pathToFileURL(compile(file)).href;
  const modules = { control: load('main/desktop/win32ControlRuntime.ts'), registry: load('main/desktop/displayRegistry.ts'),
    capture: load('main/desktop/displayCapture.ts'), artifacts: load('main/desktop/captureArtifacts.ts'),
    access: load('main/desktop/sessionCaptureAccess.ts'), decoder: load('main/desktop/pngDecoder.ts'), turn: load('main/desktop/turnGrant.ts'), ui: load('main/uiBridge.ts'), audit: load('main/desktop/auditStore.ts') };
  const html = `<button id="button" onclick="document.body.dataset.clicked='yes'">Click</button><input id="field" style="display:block;margin-top:20px">`;
  const fixture = path.join(temp, 'fixture.cjs');
  fs.writeFileSync(fixture, `
const {app, BrowserWindow, screen, powerMonitor, desktopCapturer, nativeImage} = require('electron');
(async () => {
  const {Win32ControlRuntime} = await import(${JSON.stringify(modules.control)});
  const {desktopTurnGrants} = await import(${JSON.stringify(modules.turn)});
  const {UiBridge} = await import(${JSON.stringify(modules.ui)});
  const {DesktopAuditStore} = await import(${JSON.stringify(modules.audit)});
  const {ElectronDisplayRegistry} = await import(${JSON.stringify(modules.registry)});
  const {captureDisplay} = await import(${JSON.stringify(modules.capture)});
  const {DesktopCaptureArtifacts} = await import(${JSON.stringify(modules.artifacts)});
  const {prepareSessionCaptureDirectory} = await import(${JSON.stringify(modules.access)});
  const {decodeDesktopPng} = await import(${JSON.stringify(modules.decoder)});
  await app.whenReady();
  const win = new BrowserWindow({width:500,height:300,title:'DesktopControlFixture',show:true});
  await win.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(html)})); win.setTitle('DesktopControlFixture');
  await new Promise(resolve => setTimeout(resolve, 500));
  const registry = new ElectronDisplayRegistry(screen, powerMonitor);
  const display = registry.refresh().surfaces.find(d => {const b=win.getBounds();return b.x>=d.bounds.x && b.y>=d.bounds.y && b.x<d.bounds.x+d.bounds.width && b.y<d.bounds.y+d.bounds.height});
  if (!display) throw new Error('Fixture display unavailable');
  const actor = {sessionId:'fixture',taskId:'fixture-task',isCurrent:() => !win.isDestroyed()};
  const target = registry.captureTarget(actor.taskId, display.surfaceId);
  const store = new DesktopCaptureArtifacts(prepareSessionCaptureDirectory(${JSON.stringify(temp)}, actor.sessionId), decodeDesktopPng);
  const frame = await captureDisplay({getSources: o=>desktopCapturer.getSources(o),normalizePng: p=>nativeImage.createFromBuffer(p),
    confirmAllDisplays:async()=>true,audit:async()=>{},artifacts:store},target,()=>registry.isCurrent(target),60000);
  let prompts=0;
  const confirmWin = new BrowserWindow({width:400,height:200,show:true,webPreferences:{nodeIntegration:true,contextIsolation:false}});
  await confirmWin.loadURL('data:text/html,' + encodeURIComponent('<button id=approve>Approve</button><script>const {ipcRenderer}=require("electron"); ipcRenderer.on("ui:confirm",(_,p)=>{document.body.dataset.request=p.requestId; document.getElementById("approve").onclick=()=>ipcRenderer.send("ui:confirm:"+p.requestId,true)})</script>'));
  let confirmationAvailable = false;
  const ui = new UiBridge(()=>confirmationAvailable ? confirmWin : null,()=> 'fixture');
  const approve = async pending => {
    let request; for(let i=0;i<100&&!request;i++){request=await confirmWin.webContents.executeJavaScript('document.body.dataset.request');if(!request) await new Promise(r=>setTimeout(r,50));}
    if(!request) throw new Error('No real confirmation reached renderer');
    prompts++; await confirmWin.webContents.executeJavaScript('document.getElementById("approve").click();delete document.body.dataset.request');
    return pending;
  };
  const control = new Win32ControlRuntime(${JSON.stringify(temp)},ui,p=>screen.dipToScreenPoint(p),p=>screen.screenToDipPoint(p));
  let selected, offset=0;
  do {
    const page=control.register(actor,frame,target,()=>registry.isCurrent(target),offset);
    selected=page.windows.find(w=>w.title==='DesktopControlFixture');
    offset=page.nextOffset;
  } while (!selected && offset!==null);
  if (!selected) throw new Error('Fixture missing from all window pages');
  const other = new BrowserWindow({width:120,height:100,x:0,y:0,show:true});
  await other.loadURL('data:text/html,other'); other.focus();
  const bounds=win.getContentBounds();
  const mx=Math.round((bounds.x+20-target.bounds.x)*frame.sourceSize.width/target.bounds.width);
  const my=Math.round((bounds.y+20-target.bounds.y)*frame.sourceSize.height/target.bounds.height);
  let rejected = false;
  try { await control.act(actor,{action:'move',windowId:selected.windowId,x:mx,y:my},'first-move'); } catch (error) { rejected = /confirmation-unavailable/.test(String(error)); }
  if (!rejected || desktopTurnGrants.current(actor.sessionId)) throw new Error('Unavailable confirmation must reject without a grant');
  const audit = new DesktopAuditStore(require('node:path').join(${JSON.stringify(temp)},'desktop','audit.sqlite'));
  const denied = audit.list(actor.sessionId).find(row=>row.stage==='approval' && row.result==='denied');
  if (denied?.refusal_reason !== 'confirmation-unavailable') throw new Error('Missing unavailable confirmation reason: '+JSON.stringify(denied));
  audit.close();
  confirmationAvailable = true;
  const waitRequest = async () => { let id; for(let i=0;i<100&&!id;i++){id=await confirmWin.webContents.executeJavaScript('document.body.dataset.request');if(!id) await new Promise(r=>setTimeout(r,50));} if(!id) throw new Error('No confirmation'); return id; };
  for (const [index,payload] of ['null', '{}', '{confirmed:false,kind:"allowOnce"}', '{confirmed:true,kind:"bogus"}', '{confirmed:true,kind:"deny"}'].entries()) {
    const pending = control.act(actor,{action:'move',windowId:selected.windowId,x:mx,y:my},'invalid-'+index).then(()=>null,e=>String(e));
    await waitRequest();
    await confirmWin.webContents.executeJavaScript('require("electron").ipcRenderer.send("ui:confirm:"+document.body.dataset.request,'+payload+'); delete document.body.dataset.request');
    if (!/invalid-response/.test(await pending)) throw new Error('Invalid response was not identified: '+payload);
    if (desktopTurnGrants.current(actor.sessionId)) throw new Error('Invalid response granted authorization');
    const check = new DesktopAuditStore(require('node:path').join(${JSON.stringify(temp)},'desktop','audit.sqlite'));
    if (check.list(actor.sessionId).at(-1)?.refusal_reason !== 'invalid-response') throw new Error('Invalid response audit missing'); check.close();
  }
  for (const action of ['move','focus','launch']) {
    const controller = new AbortController();
    const call = action==='launch' ? control.launch(actor,require('node:path').join(process.env.SystemRoot,'System32','notepad.exe'),'abort-launch',controller.signal) : control.act(actor,{action,windowId:selected.windowId,...(action==='move'?{x:mx,y:my}:{})},'abort-'+action,controller.signal);
    const pending = call.then(()=>null,e=>String(e));
    await waitRequest(); controller.abort();
    const error = await pending;
    if (!/confirmation-interrupted/.test(error)) throw new Error('Missing interrupted error: '+error);
    await confirmWin.webContents.executeJavaScript('delete document.body.dataset.request');
    const check = new DesktopAuditStore(require('node:path').join(${JSON.stringify(temp)},'desktop','audit.sqlite'));
    if (check.list(actor.sessionId).at(-1)?.refusal_reason !== 'confirmation-interrupted') throw new Error('Abort audit missing'); check.close();
    if (desktopTurnGrants.current(actor.sessionId)) throw new Error('Abort granted authorization');
  }
  const first=await approve(control.act(actor,{action:'move',windowId:selected.windowId,x:mx,y:my},'first-move'));
  if(first.outcome!=='dispatched') throw new Error('First move: '+JSON.stringify(first));
  const focused=await control.act(actor,{action:'focus',windowId:selected.windowId},'focus-1');
  if(focused.outcome!=='dispatched'||!win.isFocused()) throw new Error('Focus: '+JSON.stringify(focused));
  other.destroy();
  const doClick = async id => {
    const rect = await win.webContents.executeJavaScript('(() => {const r=document.getElementById("'+id+'").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    const b=win.getContentBounds();
    const x=Math.round((b.x+rect.x-target.bounds.x)*frame.sourceSize.width/target.bounds.width);
    const y=Math.round((b.y+rect.y-target.bounds.y)*frame.sourceSize.height/target.bounds.height);
    const result=await control.act(actor,{action:'click',windowId:selected.windowId,x,y},'click-'+id);
    if(result.outcome!=='dispatched') throw new Error('Click: '+JSON.stringify(result));
  };
  await doClick('button'); await doClick('field');
  const typed=await control.act(actor,{action:'type',windowId:selected.windowId,text:'Hello中'},'type-1');
  if(typed.outcome!=='dispatched') throw new Error('Type: '+JSON.stringify(typed));
  await new Promise(resolve=>setTimeout(resolve,300));
  const result=await win.webContents.executeJavaScript('({clicked:document.body.dataset.clicked,value:document.getElementById("field").value})');
  if(result.clicked!=='yes'||result.value!=='Hello中') throw new Error(JSON.stringify(result));
  const executable=require('node:path').join(process.env.SystemRoot,'System32','notepad.exe');
  const retryExe=require('node:path').join(${JSON.stringify(temp)},'retry-notepad.exe');
  let missing=false; try { await control.launch(actor,retryExe,'launch-retry'); } catch { missing=true; }
  if(!missing) throw new Error('Missing executable should fail before dispatch');
  require('node:fs').copyFileSync(executable,retryExe);
  const retried=await control.launch(actor,retryExe,'launch-retry');
  if(retried.outcome!=='dispatched'||!retried.value.pid) throw new Error('Retry after missing executable: '+JSON.stringify(retried));
  process.kill(retried.value.pid);
  const launched=await control.launch(actor,executable,'launch-1');
  if(launched.outcome!=='dispatched'||!launched.value.pid) throw new Error('Launch: '+JSON.stringify(launched));
  process.kill(launched.value.pid);
  if(prompts!==1) throw new Error('Expected one turn approval across focus, input and launches; got '+prompts);
  desktopTurnGrants.nextUserMessage(actor.sessionId);
  const next=await approve(control.launch(actor,executable,'launch-next-turn'));
  if(next.outcome!=='dispatched'||prompts!==2) throw new Error('Next turn did not prompt');
  process.kill(next.value.pid);
  console.log('CONTROL_PROBE_OK '+JSON.stringify(result));
  control.close(); registry.dispose(); confirmWin.destroy(); win.destroy(); app.quit();
})().catch(error=>{console.error(error);app.exit(1)});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [fixture], { encoding: 'utf8', timeout: 30000, env });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /CONTROL_PROBE_OK/);
  console.log(result.stdout.trim());
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
