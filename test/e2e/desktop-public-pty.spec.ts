import { test, expect, _electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

test('PTY Worker 经公开桌面工具读取并操作隔离窗口', async () => {
  test.setTimeout(180_000);
  const project = path.resolve(__dirname, '../..'), tempRoot = path.join(project, '.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'desktop-pty-'));
  const fixtureApp = path.join(fixture, 'app'); fs.mkdirSync(fixtureApp, { recursive: true });
  fs.cpSync(path.join(project, 'out'), path.join(fixtureApp, 'out'), { recursive: true });
  fs.cpSync(path.join(project, 'resources'), path.join(fixtureApp, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(project, 'package.json'), path.join(fixtureApp, 'package.json'));
  if (process.platform === 'win32') {
    const driver = path.join('.tmp', 'desktop-driver', `win-${process.arch}`, 'contents', 'driver');
    fs.cpSync(path.join(project, driver), path.join(fixtureApp, driver), { recursive: true });
  }
  const userData = path.join(fixture, '.dev-sandbox/userData');
  const workspace = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Desktop fixture', path: workspace }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] }, webAccess: { enabled: false } }));
  const builtinRoot = path.join(project, 'src/main/runtime/builtins');
  const runtimeRoot = path.join(userData, 'agent-runtimes');
  fs.cpSync(path.join(builtinRoot, 'scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(builtinRoot, 'registry.json'), 'utf8'));
  registry.runtimes.push({ id: 'desktop-fixture', label: 'Desktop fixture', script: 'desktop-fixture.mjs', enabled: true, builtin: true, surface: 'pty', updatedAt: 0 });
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  const fixtureBuiltins = path.join(fixtureApp, 'out/main/runtime/builtins');
  fs.writeFileSync(path.join(fixtureBuiltins, 'registry.json'), JSON.stringify(registry));
  const resultFile = path.join(fixture, 'result.json'), targetFile = path.join(fixture, 'target.json'), child = path.join(fixture, 'worker.cjs');
  fs.writeFileSync(child, `const fs = require('node:fs');
const call = async (name, args) => { const r = await fetch(process.env.MUSTER_TOOL_URL, { method: 'POST',
 headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.MUSTER_SESSION_TOKEN },
 body: JSON.stringify({ name, arguments: args }) }); return await r.json(); };
(async () => { let lastError = 'no response', ready = false; for (let i=0; i<40; i++) { try {
 const list = await call('host.desktop.list', { limit: 3 });
 if (!list.ok) { lastError = list.error; await new Promise(r => setTimeout(r, 250)); continue; }
 ready = true;
 const look = await call('host.desktop.look', { surfaceId: 'fixture' });
 const unauthed = await fetch(process.env.MUSTER_TOOL_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
   body: JSON.stringify({ name: 'host.desktop.list', arguments: {} }) });
 const result = { listOk: list.ok, displayCount: list.result.displays.surfaces.length, runtime: list.result.runtime,
   windowsOk: list.result.windows.ok, lookCode: look.result?.code, lookOk: look.result?.ok, lookEnvelopeOk: look.ok, unauthedStatus: unauthed.status };
 if (process.platform === 'win32') {
   const target = JSON.parse(fs.readFileSync(${JSON.stringify(targetFile)}, 'utf8'));
   const display = list.result.displays.surfaces.find(d => target.x >= d.bounds.x && target.y >= d.bounds.y && target.x < d.bounds.x+d.bounds.width && target.y < d.bounds.y+d.bounds.height);
   if (!display) throw new Error('fixture display absent');
   const capture = await call('host.desktop.look', {surfaceId:display.surfaceId});
   if (!capture.ok) throw new Error('capture: '+JSON.stringify(capture));
   const frame = capture.result; let window = frame.windows.find(w => w.title === 'DesktopPublicFixture'), offset = frame.windowsNextOffset;
   while (!window && offset != null) {
     const page = await call('host.desktop.look', {surfaceId:display.surfaceId,windowOffset:offset});
     if (!page.ok) throw new Error('capture page: '+JSON.stringify(page));
     window = page.result.windows.find(w => w.title === 'DesktopPublicFixture'); offset = page.result.windowsNextOffset;
   }
   if (!window) throw new Error('fixture window absent');
   const focus = await call('host.desktop.focus',{surfaceId:window.windowId,requestId:'focus-1'});
   if (focus.result?.outcome !== 'dispatched') throw new Error('focus: '+JSON.stringify(focus));
   const observation = await call('host.desktop.look',{surfaceId:display.surfaceId,windowId:window.windowId,mode:'both'});
   if (!observation.ok || observation.result.coordinateSpace !== 'window-pixel-v1') throw new Error('window capture: '+JSON.stringify(observation));
   const frameOfWindow = observation.result;
   const x=(target.x-target.bounds.x)*frameOfWindow.width/target.bounds.width;
   const y=(target.y-target.bounds.y)*frameOfWindow.height/target.bounds.height;
   const point = {surfaceId:display.surfaceId,action:'click',target:{windowId:window.windowId,captureId:frameOfWindow.captureId,x,y},requestId:'click-1'};
   const click = await call('host.desktop.act',point);
   if (click.result?.outcome !== 'dispatched') throw new Error('click: '+JSON.stringify(click));
   const clickReplay = await call('host.desktop.act',point);
   const type = await call('host.desktop.act',{surfaceId:display.surfaceId,action:'type',target:{windowId:window.windowId,text:'Hello中'},requestId:'type-1'});
   if (type.result?.outcome !== 'dispatched') throw new Error('type: '+JSON.stringify(type));
   const typeReplay = await call('host.desktop.act',{surfaceId:display.surfaceId,action:'type',target:{windowId:window.windowId,text:'Hello中'},requestId:'type-1'});
   const launch = await call('host.desktop.launch',{appId:require('node:path').join(process.env.SystemRoot,'System32','notepad.exe'),requestId:'launch-1'});
   const launchReplay = await call('host.desktop.launch',{appId:require('node:path').join(process.env.SystemRoot,'System32','notepad.exe'),requestId:'launch-1'});
   if (launch.result?.outcome==='dispatched' && launch.result.value?.pid) process.kill(launch.result.value.pid);
   result.captureOk = capture.ok; result.captureExists = fs.existsSync(frame.path); result.focus=focus; result.click=click; result.clickReplay=clickReplay; result.type=type; result.typeReplay=typeReplay; result.launch=launch; result.launchReplay=launchReplay;
 }
 fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));
 return;
 } catch (error) { lastError = String(error); if (ready) break; await new Promise(r => setTimeout(r, 250)); } }
 fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ error: lastError })); })();
process.stdin.resume();
`);
  const fixtureRuntime = `import {randomUUID} from 'node:crypto';
import {appendCliPrompt} from './_helpers.mjs';
export async function allocate(){return {sessionId:randomUUID()};}
export function appendPrompt(options){return appendCliPrompt(options);}
export function resolveLaunch({extraArgs}){return {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(child)},...extraArgs]};}
`;
  fs.writeFileSync(path.join(runtimeRoot, 'scripts/desktop-fixture.mjs'), fixtureRuntime);
  fs.writeFileSync(path.join(fixtureBuiltins, 'scripts/desktop-fixture.mjs'), fixtureRuntime);
  const env = { ...process.env, MUSTER_SANDBOX: '1',
    MUSTER_INSTANCE_ID: `desktop-public-${process.pid}`, MUSTER_WEB_PORT: '0' } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [fixtureApp, '--disable-gpu'], cwd: fixture, env });
  let mainLog = '';
  app.process().stdout?.on('data', chunk => { mainLog += chunk.toString(); });
  app.process().stderr?.on('data', chunk => { mainLog += chunk.toString(); });
  try {
    const page = await app.firstWindow(); await page.locator('.app-shell').waitFor({ timeout: 60_000 });
    if (process.platform === 'win32') {
      const position = await app.evaluate(async ({ BrowserWindow }) => {
        const win = new BrowserWindow({ width: 360, height: 180, title: 'DesktopPublicFixture', show: true, x: 40, y: 40 });
        await win.loadURL('data:text/html,' + encodeURIComponent('<input id="field" style="width:220px;height:40px">'));
        win.setTitle('DesktopPublicFixture');
        const rect = await win.webContents.executeJavaScript('(() => {const r=document.getElementById("field").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
        const bounds = win.getContentBounds();
        return { x: bounds.x + rect.x, y: bounds.y + rect.y, bounds: win.getBounds() };
      });
      fs.writeFileSync(targetFile, JSON.stringify(position));
    }
    const worker = await page.evaluate(async cwd => window.api.sessions.create({ cwd, workspaceId: 'demo-frontend',
      runtime: 'desktop-fixture', name: 'Desktop fixture', force: true }), workspace);
    let turnApprovals = 0;
    if (process.platform === 'win32') {
      for (let i = 0; i < 240 && !fs.existsSync(resultFile); i++) {
        const allow = page.getByRole('dialog').getByRole('button', { name: /^允许/ });
        if (await allow.count() && await allow.first().isVisible()) {
          if ((await page.getByRole('dialog').innerText()).includes('本回合内后续桌面操作不再询问')) turnApprovals++;
          await allow.first().click();
        }
        await page.waitForTimeout(250);
      }
    }
    await expect.poll(() => fs.existsSync(resultFile), { timeout: 30_000 }).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    expect(result.listOk, JSON.stringify(result) + '\n' + mainLog.slice(-5000)).toBe(true); expect(result.displayCount).toBeGreaterThan(0);
    if (process.platform === 'win32') { expect(result.runtime).toBe('windows'); expect(result.windowsOk).toBe(true); }
    expect(result.lookEnvelopeOk).toBe(false);
    if (process.platform === 'win32') {
      expect(turnApprovals).toBe(1);
      expect(result.captureOk, JSON.stringify(result)).toBe(true); expect(result.captureExists).toBe(true);
      for (const name of ['focus', 'click', 'type', 'launch']) expect(result[name]?.result?.outcome, JSON.stringify(result[name])).toBe('dispatched');
      expect(result.clickReplay).toEqual(result.click); expect(result.typeReplay).toEqual(result.type); expect(result.launchReplay).toEqual(result.launch);
      const value = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(item => item.getTitle() === 'DesktopPublicFixture');
        if (!win) throw new Error('Fixture window disappeared');
        return win.webContents.executeJavaScript('document.getElementById("field").value');
      });
      expect(value).toBe('Hello中');
    }
    expect(result.unauthedStatus).toBe(401);
    const audit = new DatabaseSync(path.join(userData, 'desktop', 'audit.sqlite'), { readOnly: true });
    try {
      const hash = createHash('sha256').update(worker.id).digest('hex');
      const row = audit.prepare("SELECT action, stage, result FROM desktop_audit WHERE session_hash = ? AND action = 'list' ORDER BY sequence DESC LIMIT 1").get(hash);
      expect(row).toMatchObject({ action: 'list', stage: 'read', result: 'allowed' });
      if (process.platform === 'win32') {
        const rows = audit.prepare('SELECT action, stage, result FROM desktop_audit WHERE session_hash = ?').all(hash);
        expect(rows).toEqual(expect.arrayContaining([{ action: 'look', stage: 'capture-result', result: 'allowed' },
          ...['focus', 'type', 'launch'].map(action => ({ action, stage: 'dispatch-result', result: 'dispatched' }))]));
        expect(rows.filter(row => row.action === 'type' && row.stage === 'dispatch-result')).toHaveLength(1);
        expect(rows.filter(row => row.action === 'launch' && row.stage === 'dispatch-result')).toHaveLength(1);
      }
    } finally { audit.close(); }
  } finally {
    const proc = app.process();
    if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* process already exited */ }
      } else proc.kill('SIGKILL');
    }
    // Preserve the bounded fixture for diagnostics; Windows Git objects may be read-only.
    console.log(`Desktop fixture retained: ${fixture}`);
  }
});
