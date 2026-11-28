import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { DesktopSetupPermission } from '../../../src/shared/desktopSetup';
import { desktopSetupIssue, desktopSetupMacApp } from '../../../src/main/desktop/desktopSetup';
import { registerDesktopSetupIpc } from '../../../src/main/ipc/desktopSetup';
import { UiBridge } from '../../../src/main/uiBridge';

const directory = process.env.MUSTER_DESKTOP_SETUP_FIXTURE!;
app.setPath('userData', path.join(directory, 'profile'));

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 920, height: 580, webPreferences: {
    preload: process.env.MUSTER_DESKTOP_SETUP_PRELOAD,
    sandbox: false, contextIsolation: true, nodeIntegration: false
  } });
  const permissions = { screenRecording: false, accessibility: false };
  const opened: string[] = [];
  const requested: DesktopSetupPermission[] = [];
  const revealed: string[] = [];
  let completeScreenRequest: (() => void) | undefined;
  shell.openExternal = async url => { opened.push(url); };
  shell.showItemInFolder = path => { revealed.push(path); };
  const getWindow = () => win;
  const unused = () => { throw new Error('Setup must never perform desktop operations'); };
  registerDesktopSetupIpc({ getWindow, desktopScreen: unused, desktopTurns: unused, desktopWindowList: unused,
    desktopSemanticControl: unused,
    desktopMac: { status: () => ({ permissions: { ...permissions } }), checkDriverPermissions: async () => ({ ...permissions }) }
  }, async permission => {
    requested.push(permission);
    if (permission === 'screenRecording') {
      await new Promise<void>(resolve => { completeScreenRequest = resolve; });
      completeScreenRequest = undefined;
    }
    return permissions[permission];
  });
  ipcMain.handle('app:setChromeTheme', () => ({ ok: true, material: 'solid' }));
  ipcMain.handle('config:waitingTips', () => ({ ok: true, path: '', tips: [] }));
  ipcMain.handle('shell:getInfo', () => ({ platform: process.platform, manualGitBashPath: '', bgShellMode: 'auto' }));

  const ui = new UiBridge(getWindow, () => undefined, process.platform === 'darwin' ? desktopSetupMacApp(app.isPackaged) : undefined);
  Object.assign(globalThis, { desktopSetupFixture: { permissions, opened, revealed, requested,
    resolveScreenRequest: () => completeScreenRequest?.(), sendFailure: (result: unknown) => {
    const issue = desktopSetupIssue(result, process.platform);
    if (issue) ui.showDesktopSetup(issue);
  } } });
  await win.loadFile(path.join(directory, 'index.html'));
});
