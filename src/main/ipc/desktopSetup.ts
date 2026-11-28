import path from 'node:path';
import { app, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import type { DesktopAppRevealResult, DesktopPermissionRequestResult, DesktopSetupPermission } from '../../shared/desktopSetup';
import type { AppContext } from '../context';
import { resolveCuaDriverPath } from '../desktop/cuaDriverPath';
import { openDesktopPermissionSettings, readDesktopSetup, type DesktopSetupHost } from '../desktop/desktopSetup';
import { requestMacScreenRecording } from '../desktop/macPermissions';
import { desktopRuntime } from '../desktop/runtime';
import { handle } from './handle';

function requestMacPermission(permission: DesktopSetupPermission): boolean | Promise<boolean> {
  return permission === 'accessibility' ? systemPreferences.isTrustedAccessibilityClient(true) : requestMacScreenRecording();
}

export function registerDesktopSetupIpc(ctx: DesktopSetupHost & Pick<AppContext, 'getWindow'>,
  requestPermission: typeof requestMacPermission = requestMacPermission): void {
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
  let requesting = false;
  handle('desktopSetup:requestPermission', async (event, permission: unknown): Promise<DesktopPermissionRequestResult> => {
    assertLocalFrame(event);
    if (process.platform !== 'darwin') return { ok: false, code: 'unsupported_platform' };
    if (permission !== 'screenRecording' && permission !== 'accessibility') return { ok: false, code: 'invalid_permission' };
    if (requesting) return { ok: false, code: 'request_in_progress' };
    requesting = true;
    try {
      return { ok: true, granted: await requestPermission(permission) };
    } catch (error) {
      console.error('[desktop setup] could not request macOS permission:', error);
      return { ok: false, code: 'request_failed' };
    } finally {
      requesting = false;
    }
  });
  handle('desktopSetup:revealApp', (event): DesktopAppRevealResult => {
    assertLocalFrame(event);
    if (process.platform !== 'darwin') return { ok: false, code: 'unsupported_platform' };
    const macOS = path.dirname(app.getPath('exe'));
    const contents = path.dirname(macOS);
    const bundle = path.dirname(contents);
    if (path.basename(macOS) !== 'MacOS' || path.basename(contents) !== 'Contents' || path.extname(bundle) !== '.app') {
      return { ok: false, code: 'reveal_failed' };
    }
    try {
      shell.showItemInFolder(bundle);
      return { ok: true };
    } catch (error) {
      console.error('[desktop setup] could not reveal the running app:', error);
      return { ok: false, code: 'reveal_failed' };
    }
  });
}
