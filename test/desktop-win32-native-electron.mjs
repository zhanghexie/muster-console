import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

// Explicit manual Windows integration probe: opens and controls only its own isolated fixture.
if (process.platform !== 'win32') throw new Error('This integration probe requires Windows');
const executable = process.env.DESKTOP_TEST_ELECTRON;
if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('DESKTOP_TEST_ELECTRON must name an installed Electron executable');
fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-native-electron-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const input = pathToFileURL(compile('main/desktop/win32Input.ts')).href;
  const tracked = pathToFileURL(compile('main/desktop/trackedWin32Input.ts')).href;
  const apps = pathToFileURL(compile('main/desktop/win32Applications.ts')).href;
  const fixture = path.join(temp, 'fixture.cjs');
  const html = `<button id="button" onclick="document.body.dataset.clicked='yes'">Click</button><input id="field" style="display:block;margin-top:20px">`;
  fs.writeFileSync(fixture, `
const {app, BrowserWindow, screen} = require('electron');
(async () => {
  const {createWin32Input, performWin32Input} = await import(${JSON.stringify(input)});
  const {TrackedWin32Input} = await import(${JSON.stringify(tracked)});
  const {createWin32WindowApi, focusWin32Window} = await import(${JSON.stringify(apps)});
  await app.whenReady();
  const win = new BrowserWindow({width: 500, height: 300, show: true, webPreferences: {contextIsolation: true}});
  await win.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(html)}));
  await new Promise(resolve => setTimeout(resolve, 500));
  const handle = win.getNativeWindowHandle().readBigUInt64LE();
  focusWin32Window(createWin32WindowApi(), handle, () => !win.isDestroyed());
  const raw = createWin32Input(), api = createWin32WindowApi();
  const current = () => !win.isDestroyed() && BigInt(api.foreground() ?? 0) === handle;
  const driver = new TrackedWin32Input({
    move: (x,y) => { if (!current()) throw new Error('Fixture lost foreground'); raw.move(x,y); },
    send: batch => {
      const event = batch[0], release = event.kind === 'key' ? !!((event.flags ?? 0) & 2) : [4,16,64].includes(event.flags);
      if (!release && !current()) throw new Error('Fixture lost foreground');
      raw.send(batch);
    }
  });
  for (const id of ['button', 'field']) {
    const rect = await win.webContents.executeJavaScript('(() => {const r=document.getElementById("' + id + '").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    const bounds = win.getContentBounds();
    const point = screen.dipToScreenPoint({x: Math.round(bounds.x + rect.x), y: Math.round(bounds.y + rect.y)});
    await performWin32Input(driver, {action:'click', ...point});
  }
  await performWin32Input(driver, {action:'type', text:'Hello中'});
  await driver.releaseAll();
  await new Promise(resolve => setTimeout(resolve, 300));
  const result = await win.webContents.executeJavaScript('({clicked:document.body.dataset.clicked,value:document.getElementById("field").value})');
  if (result.clicked !== 'yes' || result.value !== 'Hello中') throw new Error(JSON.stringify(result));
  console.log('NATIVE_PROBE_OK ' + JSON.stringify(result));
  win.destroy(); app.quit();
})().catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [fixture], { encoding: 'utf8', timeout: 30000, env });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /NATIVE_PROBE_OK/);
  console.log(result.stdout.trim());
} finally { removeWorkspaceFixture(temp, 'desktop-native-electron-'); }
