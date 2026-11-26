/**
 * PR / diff 行内评论 → Worker 回注简报（T1.7）。
 * 纯函数：渲染层拼装、离线单测共用；不碰 IPC。
 */
import { pathKey } from './pathKey';
import { sessionWorktreeReviewRepos, type WorktreeReviewRepo, type WorktreeReviewSession } from './sessionWorktreeReview';

export type PrReviewCommentStatus = 'draft' | 'injected' | 'sent';

/** 一条行内评论（简报拼装只看 file/line/original/body） */
export interface PrReviewComment {
  id: string;
  file: string;
  line: number;
  original: string;
  body: string;
  status: PrReviewCommentStatus;
}

export type PrReviewCommentInput = Pick<PrReviewComment, 'file' | 'line' | 'original' | 'body'>;

const HEADER =
  '请根据以下 PR 行内评论修订代码；改完后在本隔离分支重新 push。不要 git merge 进主分支。';

/** 拼结构化简报。空正文条目跳过；按 file 再 line 稳定排序。 */
export function buildPrReviewBrief(comments: PrReviewCommentInput[], repo?: Partial<WorktreeReviewRepo>): string {
  const items = comments
    .filter((c) => c.body.trim() && c.file.trim())
    .slice()
    .sort((a, b) => {
      const fa = a.file.trim().replace(/\\/g, '/');
      const fb = b.file.trim().replace(/\\/g, '/');
      return fa.localeCompare(fb) || a.line - b.line;
    });
  if (items.length === 0) return '';
  const blocks = items.map((c) => {
    const file = c.file.trim().replace(/\\/g, '/');
    const orig = c.original.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const body = c.body.trim();
    return `[PR 评论] ${file}:${c.line} 原文/评论\n原文: ${orig}\n评论: ${body}`;
  });
  const context = repo?.repoPath ? [
    '请根据以下行内评论修订所选仓库；相对文件路径均以该目录为基准。不要 git merge 进主分支。',
    `仓库目录：${repo.repoPath}`,
    ...(repo.groupId ? [`任务仓组：${repo.groupId}`] : []),
    ...(repo.rootId ? [`来源根：${repo.rootId}`] : []),
    ...(repo.sourcePath ? [`来源仓库：${repo.sourcePath}`] : []),
    ...(repo.branch ? [`隔离分支：${repo.branch}`] : [])
  ] : [HEADER];
  return [...context, '', ...blocks].join('\n');
}

export interface WorkerRepoSession extends WorktreeReviewSession {
  type?: string;
  name?: string;
  worktreePath?: string;
  cwd?: string;
}

/** 当前仓对应的 Worker：优先 worktreePath，其次 cwd。 */
export function matchWorkerSessionForRepo(
  sessions: WorkerRepoSession[],
  repoPath: string
): { id: string; name?: string } & Partial<WorktreeReviewRepo> | null {
  const k = pathKey(repoPath);
  if (!k) return null;
  const terminals = sessions.filter((s) => !s.type || s.type === 'terminal');
  const owners = terminals.flatMap(s => {
    try {
      const repo = sessionWorktreeReviewRepos(s).find(repo => pathKey(repo.repoPath) === k);
      return repo ? [{ id: s.id, name: s.name, ...repo }] : [];
    } catch { return []; }
  });
  if (owners.length) return owners.length === 1 ? owners[0]! : null;
  const byCwd = terminals.filter(s => !s.worktreeGroups && !s.worktreePath && s.cwd && pathKey(s.cwd) === k);
  if (byCwd.length === 1) return { id: byCwd[0]!.id, name: byCwd[0]!.name, repoPath };
  return null;
}
