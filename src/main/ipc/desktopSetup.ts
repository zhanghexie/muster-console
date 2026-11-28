import { app, shell, type IpcMainInvokeEvent } from 'electron';
import type { AppContext } from '../context';
import { resolveCuaDriverPath } from '../desktop/cuaDriverPath';
import { openDesktopPermissionSettings, readDesktopSetup, type DesktopSetupHost } from '../desktop/desktopSetup';
import { desktopRuntime } from '../desktop/runtime';
import { handle } from './handle';

export function registerDesktopSetupIpc(ctx: DesktopSetupHost & Pick<AppContext, 'getWindow'>): void {
  const assertLocalFrame = (event: IpcMainInvokeEvent): void => {
    const sender = ctx.getWindow()?.webContents;
    if (!sender || event?.sender !== sender || event.senderFrame !== sender.mainFrame) {
      throw new Error('Desktop setup is only available in the local workbench');
    }
  };
  handle('desktopSetup:status', event => {
    assertLocalFrame(event);
    return readDesktopSetup(ctx, desktopRuntime(process.platform, process.env), app.isPackaged,
      () => resolveCuaDriverPath({ platform: process.platform, arch: process.arch, isPackaged: app.isPackaged,
        appPath: app.getAppPath(), resourcesPath: process.resourcesPath }));
  });
  handle('desktopSetup:openSettings', (event, permission: unknown) => {
    assertLocalFrame(event);
    return openDesktopPermissionSettings(process.platform, permission, url => shell.openExternal(url));
  });
}
