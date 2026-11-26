import { app, net, safeStorage } from 'electron';
import type { AppContext } from '../context';
import type { PrApi, PrFilter, PrRepoScope, PrResult } from '../../shared/githubPr';
import { t } from '../../shared/i18n';
import { handle } from './handle';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { defaultGitHubApp } from '../git/githubAppConfig';
import { GitHubAppAuth } from '../git/githubAppAuth';
import { GitHubPrError } from '../git/githubHttp';
import { GitHubPrService } from '../git/githubPrService';
import { GitHubPrStorage } from '../git/githubPrStorage';

declare const __MUSTER_GITHUB_APP_CLIENT_ID__: string | undefined;
declare const __MUSTER_GITHUB_APP_SLUG__: string | undefined;

export function registerPrIpc(ctx: AppContext): void {
  const fetcher = ((input, init) => net.fetch(input instanceof URL ? input.href : input, init)) as typeof fetch;
  const storage = new GitHubPrStorage(userDataStorage(app.getPath('userData')).manifestPath('github-pr'), safeStorage, process.platform);
  const config = defaultGitHubApp(
    process.env.MUSTER_GITHUB_APP_CLIENT_ID, process.env.MUSTER_GITHUB_APP_SLUG,
    typeof __MUSTER_GITHUB_APP_CLIENT_ID__ === 'string' ? __MUSTER_GITHUB_APP_CLIENT_ID__ : undefined,
    typeof __MUSTER_GITHUB_APP_SLUG__ === 'string' ? __MUSTER_GITHUB_APP_SLUG__ : undefined
  );
  const auth = new GitHubAppAuth({ app: config, fetcher,
    readApp: () => storage.appConfig(), saveApp: (value, clearSession) => storage.saveAppConfig(value, clearSession),
    read: () => storage.session(), save: value => storage.saveSession(value),
    assertStorage: () => storage.assertStorage() });
  const service = ctx.githubPr = new GitHubPrService(ctx, auth, storage, fetcher);
  const register = <Args extends unknown[], T>(channel: keyof PrApi, run: (...args: Args) => T | Promise<T>) => {
    handle(`pr:${channel}`, async (_event, ...args: unknown[]): Promise<PrResult<T>> => {
      try { return { ok: true, value: await run(...args as Args) }; }
      catch (error) {
        if (error instanceof GitHubPrError) {
          return { ok: false, kind: error.kind, message: error.message, ...(error.installUrl ? { installUrl: error.installUrl } : {}) };
        }
        console.warn('[github-pr] IPC failed', channel, error instanceof Error ? error.name : 'unknown');
        return { ok: false, kind: 'failed', message: t('GitHub 操作失败，请重试') };
      }
    });
  };
  register('appSetup', () => auth.appSetup());
  register('configureApp', auth.configureApp.bind(auth));
  register('connection', () => auth.connection());
  register('authorize', () => auth.authorize());
  register('disconnect', async () => { auth.disconnect(); return auth.connection(); });
  register('repository', service.repository.bind(service));
  register('list', (scope: PrRepoScope, filter: PrFilter, cursor?: string) => service.list(scope, filter, cursor));
  register('detail', service.detail.bind(service));
  register('files', service.files.bind(service));
  register('threads', service.threads.bind(service));
  register('create', service.create.bind(service));
  register('forward', service.forward.bind(service));
  register('draft', service.draft.bind(service));
  register('publish', service.publish.bind(service));
  register('setAutoReview', service.setAutoReview.bind(service));
}
