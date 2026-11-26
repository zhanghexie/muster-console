import type { BrowserWindow } from 'electron';
import path from 'node:path';
import type { AppContext } from '../context';
import { BrowserTabService } from '../browser/tabs';
import { cleanupAbandonedUploadSnapshots } from '../browser/uploadFiles';
import { startCaptureCleanup, sweepSessionCaptures } from '../desktop/captureCleanup';
import { decodeDesktopPng } from '../desktop/pngDecoder';
import { registerBrowserIpc } from '../ipc/browser';
import { registerScopedIpc } from '../ipc/handle';
import { WebAccessServer } from '../webAccess/server';
import { startCliRuns } from '../cliRuns/wiring';
import { cliDiscoveryHome } from '../cliRuns/discovery';
import { PRODUCT_CLI_HOME_ENV, PRODUCT_NAME } from '../../shared/productIdentity';
import { errorMessage } from '../../shared/errors';
import { t } from '../../shared/i18n';
import type { NotifyBus } from '../notify/bus';
import type { ConfigManager } from '../config';
import type { ShellApiServer } from '../protocol/shellApi';
import type { StorageRootResolver } from '../runtimeKernel/storageRootResolver';
import type { DomainRegistry } from '../runtimeKernel/domainRegistry';

export type HostEntrypointBindings = {
  domains: DomainRegistry;
  ctx: AppContext;
  getWindow: () => BrowserWindow | null;
  config: ConfigManager;
  storage: StorageRootResolver;
  shellApi: ShellApiServer;
  notifyBus: NotifyBus;
  userDataDir: string;
  isPackaged: boolean;
  resourcesPath: string;
  appVersion: string;
  appInstanceId: string;
  sandbox: boolean;
  setWebAccess: (server: WebAccessServer) => void;
  setCliStopAdmission: (stopAdmission: () => void) => void;
};

/** Registers the host-facing domains after the IPC handlers are available. */
export function registerHostEntrypointDomains(bindings: HostEntrypointBindings): void {
  const {
    domains,
    ctx,
    getWindow,
    config,
    storage,
    shellApi,
    notifyBus,
    userDataDir,
    isPackaged,
    resourcesPath,
    appVersion,
    appInstanceId,
    sandbox,
    setWebAccess,
    setCliStopAdmission
  } = bindings;

  domains.register({
    id: 'host-entrypoints',
    // Session domains stop first, so accepted calls can finish retirement.
    start: async (_runtimeContext, scope) => {
      // Browser tabs are lazy. The guest web contents is created only when the
      // renderer or an Agent first activates a tab.
      const browserTabs = new BrowserTabService(getWindow, config);
      const uploadCleanup = cleanupAbandonedUploadSnapshots();
      scope.add(() => uploadCleanup);
      void uploadCleanup.catch(error => console.warn('[browser] upload snapshot cleanup failed:', String(error)));
      let captureCleanupWarned = false;
      const captureCleanup = startCaptureCleanup(
        () => sweepSessionCaptures(userDataDir, decodeDesktopPng),
        error => {
          console.error('[desktop] capture cleanup failed:', error);
          if (!captureCleanupWarned) {
            captureCleanupWarned = true;
            try { ctx.ui.notify(t('截图'), t('清理失败：{{reason}}', { reason: error })); }
            catch (notifyError) { console.error('[desktop] capture cleanup notification failed:', notifyError); }
          }
        }
      );
      void captureCleanup.ready.catch(error => console.error('[desktop] capture cleanup startup failed:', error));
      scope.add(() => captureCleanup.stop());
      ctx.bindBrowser(browserTabs);
      scope.add(() => browserTabs.stop());
      registerScopedIpc('host-entrypoints:browser', scope, () => registerBrowserIpc(browserTabs));

      scope.add(() => shellApi.stop());
      try {
        await shellApi.start();
      } catch (error) {
        console.error('[shellApi] start failed:', error);
        ctx.ui.notify(
          PRODUCT_NAME,
          t('Agent 工具网关启动失败：{{error}}。桌面功能不受影响；Agent 的状态上报与宿主工具调用在本实例中不可用', {
            error: errorMessage(error)
          })
        );
      }

      // Web access starts after IPC registration, so every invoke channel is
      // available before a remote client can connect.
      const webAccess = new WebAccessServer();
      setWebAccess(webAccess);
      ctx.bindWebAccess(webAccess);
      webAccess.bindNotifyBus(notifyBus);
      scope.add(() => webAccess.stop());
      await webAccess.start(ctx);

      try {
        const cli = await startCliRuns(ctx, {
          directory: userDataDir,
          discoveryHome: process.env[PRODUCT_CLI_HOME_ENV] || (sandbox ? storage.resolve('app', 'cli-discovery') : cliDiscoveryHome()),
          id: appInstanceId,
          version: appVersion,
          guidePath: isPackaged
            ? path.join(resourcesPath, 'cli/scheduler-guide.txt')
            : path.resolve(__dirname, '../../resources/cli/scheduler-guide.txt')
        });
        setCliStopAdmission(cli.stopAdmission);
        scope.add(cli.dispose);
      } catch (error) {
        console.error('[cli] local CLI disabled:', error);
        ctx.ui.notify(`${PRODUCT_NAME} CLI`, t('CLI 服务启动失败：{{error}}', { error: errorMessage(error) }));
      }
    }
  });

  domains.register({
    id: 'phone-apps',
    dependsOn: ['host-entrypoints'],
    start: async (_runtimeContext, scope) => {
      scope.add(() => ctx.agentApps!.stop());
      await ctx.agentApps!.start();
    }
  });
}
