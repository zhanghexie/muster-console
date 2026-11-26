import { t } from '../../shared/i18n';
import type { PrErrorKind } from '../../shared/githubPr';

export class GitHubPrError extends Error {
  constructor(readonly kind: PrErrorKind, message: string, readonly installUrl?: string) {
    super(message);
  }
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function safeGitHubUrl(value: unknown, ...hosts: string[]): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && (!hosts.length || hosts.includes(url.host)) && !url.username && !url.password) return url.href;
  } catch {}
  return null;
}

export async function githubFetch(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new GitHubPrError('network', t('GitHub 连接失败，请检查网络后重试'));
  }
}

export async function readGitHubJson(response: Response): Promise<Record<string, unknown>> {
  try { return object(await response.json()); }
  catch { throw new GitHubPrError('failed', t('GitHub 返回了无法读取的数据')); }
}

export function githubStatusError(response: Response): GitHubPrError {
  if (response.status === 401) return new GitHubPrError('auth', t('GitHub 登录已失效，请重新连接'));
  if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' ||
      (response.status === 403 && response.headers.has('retry-after'))) {
    return new GitHubPrError('rateLimit', t('GitHub 请求达到限额，请稍后重试'));
  }
  if (response.status === 403 || response.status === 404) {
    return new GitHubPrError('permission', t('GitHub 仓库不可用或当前账号权限不足'));
  }
  if (response.status === 422) return new GitHubPrError('failed', t('GitHub 拒绝了本次操作，请检查 PR、分支和评审状态'));
  return new GitHubPrError('failed', t('GitHub 请求失败（HTTP {{status}}）', { status: response.status }));
}
