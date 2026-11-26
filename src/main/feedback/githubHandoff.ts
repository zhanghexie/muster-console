import type { FeedbackTarget } from '../../shared/feedback';
import { normalizeFeedbackTarget } from './remote';

export function githubIssueHandoff(target: FeedbackTarget, title: string, body: string): { url: string; clipboardBody?: string } {
  const normalized = normalizeFeedbackTarget(target);
  if (normalized.provider !== 'github' || new URL(normalized.repository).origin !== 'https://github.com') {
    throw new Error('反馈服务返回的仓库信息无效');
  }
  const url = new URL(`${normalized.repository}/issues/new`);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  // Electron limits openExternal URLs to 2081 characters on Windows.
  if (url.href.length <= 2000) return { url: url.href };
  url.searchParams.delete('body');
  return { url: url.href, clipboardBody: body };
}
