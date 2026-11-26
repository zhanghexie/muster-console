import type { FeedbackTarget } from '../../shared/feedback';

export interface RemoteIssue { id: string; title: string; body: string; state: string; url: string; bodyTruncated?: boolean; bodyHash?: string }
export interface RemoteLookup { target: FeedbackTarget; issues: RemoteIssue[] }
export interface FeedbackRemote {
  find(title: string, marker?: string): Promise<RemoteLookup>;
  /** Full issue history for AI review. */
  history?(): Promise<RemoteLookup>;
  details?(id: string): Promise<RemoteIssue>;
  create(target: FeedbackTarget, title: string, body: string, seen: RemoteIssue[]): Promise<RemoteIssue>;
}

/** `uncertain` means a non-idempotent POST may have reached the repository. */
export class FeedbackRemoteError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}

export function normalizeFeedbackTarget(value: unknown): FeedbackTarget {
  if (!value || typeof value !== 'object') throw new Error('反馈服务返回的仓库信息无效');
  const target = value as Partial<FeedbackTarget>;
  if ((target.provider !== 'gitlab' && target.provider !== 'github') || typeof target.repository !== 'string') throw new Error('反馈服务返回的仓库信息无效');
  let url: URL;
  try { url = new URL(target.repository); } catch { throw new Error('反馈服务返回的仓库信息无效'); }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || parts.length < 2 ||
      (target.provider === 'github' && (url.hostname.toLowerCase() !== 'github.com' || parts.length !== 2)) ||
      parts.some(p => p === '.' || p === '..' || !/^[\p{L}\p{N}_.-]+$/u.test(p))) throw new Error('反馈服务返回的仓库信息无效');
  return { provider: target.provider, repository: `${url.origin}/${parts.join('/')}` };
}
