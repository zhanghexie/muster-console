import type { GitHubAppConfig, GitHubAppInput } from '../../shared/githubPr';
import { t } from '../../shared/i18n';
import { githubFetch, githubStatusError, GitHubPrError, readGitHubJson, string } from './githubHttp';

const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

// Public OAuth identifier from github.com/apps/muster-console. Device flow does not ship a client secret.
const MUSTER_GITHUB_APP: GitHubAppConfig = { clientId: 'Iv23li38wcr7NdVRUeV3', slug: 'muster-console' };

export function configuredGitHubApp(clientId: unknown, slug: unknown): GitHubAppConfig | null {
  const id = string(clientId).trim();
  const name = string(slug).trim().toLowerCase();
  return /^Iv[A-Za-z0-9_]{1,90}(?:\.[A-Za-z0-9]{1,90})?$/.test(id) && id.length >= 6 && id.length <= 100 && APP_SLUG.test(name)
    ? { clientId: id, slug: name } : null;
}

export function defaultGitHubApp(runtimeId?: string, runtimeSlug?: string, buildId?: string, buildSlug?: string): GitHubAppConfig | null {
  if (runtimeId !== undefined || runtimeSlug !== undefined) return configuredGitHubApp(runtimeId, runtimeSlug);
  if (buildId || buildSlug) return configuredGitHubApp(buildId, buildSlug);
  return MUSTER_GITHUB_APP;
}

function appSlug(value: unknown): string | null {
  const input = string(value).trim().toLowerCase();
  if (APP_SLUG.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) return null;
    const slug = /^\/apps\/([^/]+)(?:\/installations\/new)?\/?$/.exec(url.pathname)?.[1] ??
      /^\/(?:organizations\/[a-z0-9-]+\/)?settings\/apps\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return slug && slug !== 'new' && APP_SLUG.test(slug) ? slug : null;
  } catch { return null; }
}

export async function resolveGitHubApp(input: GitHubAppInput, fetcher: typeof fetch): Promise<GitHubAppConfig> {
  const slug = appSlug(input?.app);
  if (!slug) throw new GitHubPrError('configuration', t('请输入有效的 GitHub App 链接或名称'));
  if (input.clientId !== undefined) {
    const manual = configuredGitHubApp(input.clientId, slug);
    if (!manual) throw new GitHubPrError('configuration', t('请填写 GitHub App 设置页面上的 Client ID'));
    return manual;
  }

  const response = await githubFetch(fetcher, `https://api.github.com/apps/${slug}`, { credentials: 'omit', cache: 'no-store',
    headers: { 'User-Agent': 'Muster', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } });
  if (!response.ok && response.status !== 404) throw githubStatusError(response);
  if (response.ok) {
    const data = await readGitHubJson(response);
    const app = configuredGitHubApp(data.client_id, data.slug);
    if (app?.slug === slug) return app;
  }
  throw new GitHubPrError('appLookup', t('无法从链接读取 GitHub App。请检查名称，私有 App 可填写 Client ID'));
}
