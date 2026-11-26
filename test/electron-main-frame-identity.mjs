import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = fs.realpathSync(process.cwd());
const parent = path.join(root, '.tmp'); fs.mkdirSync(parent, { recursive: true });
const realParent = fs.realpathSync(parent), relParent = path.relative(root, realParent);
assert.ok(relParent && relParent !== '..' && !relParent.startsWith(`..${path.sep}`) && !path.isAbsolute(relParent));
const fixture = fs.mkdtempSync(path.join(realParent, 'electron-frame-'));
try {
  const main = path.join(fixture, 'main.cjs');
  fs.writeFileSync(main, `
    const { app, BrowserWindow, ipcMain } = require('electron');
    const path = require('node:path');
    app.setPath('userData', path.join(process.cwd(), 'userData'));
    app.setPath('sessionData', path.join(process.cwd(), 'sessionData'));
    app.commandLine.appendSwitch('disable-gpu');
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
      ipcMain.once('frame-fixture', (event) => {
        const sameContents = event.sender === win.webContents;
        const sameFrame = event.senderFrame === win.webContents.mainFrame;
        console.log(JSON.stringify({ sameContents, sameFrame }));
        app.exit(sameContents && sameFrame ? 0 : 1);
      });
      await win.loadURL('data:text/html,<html><body>fixture</body></html>');
      await win.webContents.executeJavaScript("require('electron').ipcRenderer.send('frame-fixture')");
    }).catch(error => { console.error(error); app.exit(1); });
  `);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const output = execFileSync(electron, [main], { cwd: fixture, env, encoding: 'utf8', timeout: 30000 });
  assert.match(output, /"sameContents":true,"sameFrame":true/);
  console.log('Electron main-frame identity: real renderer IPC sender and frame matched');
} finally {
  const resolved = fs.realpathSync(fixture), rel = path.relative(realParent, resolved);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  assert.ok(path.basename(resolved).startsWith('electron-frame-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
