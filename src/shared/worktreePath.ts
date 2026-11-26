/**
 * 隔离 worktree 路径判定单源（A2-6-2 契约单源化）：渲染层行标记（GitRepoRows）、
 * 派生态（useGitPanelDerived）、主进程 guard（workerTreeGuard）原先各自手写判定，
 * 其中 includes('.worktrees') 是子串误报源（my.worktrees-x 这类非目录段也算命中）。
 * 统一为目录边界正则语义——仅当 .worktrees 是路径中的完整目录段时才算隔离 worktree。
 */
export const WORKTREES_DIR_NAME = '.worktrees';

/** 目录边界判定：E:/r/.worktrees/ao-1 ✓；E:/r/my.worktrees/ao-1 ✗；空值 ✗ */
export function isIsolatedWorktreePath(p: string | null | undefined): boolean {
  return typeof p === 'string' && /[\\/]\.worktrees[\\/]/.test(p);
}
