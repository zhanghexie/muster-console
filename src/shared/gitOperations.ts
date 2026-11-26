import type {
  GitActionResult, GitAddRepoResult, GitAdoptHunkKey, GitAdoptHunksResult,
  GitAdoptPreviewResult, GitBranchList, GitCheckoutRequest, GitCommitDiffResult,
  GitCommitFilesResult, GitDiffResult, GitLogPage, GitRepoStatus, GitRepoListResult,
  GitWorktreeAddResult, GitWorktreeInfo, GitDiscardMode
} from './types';

/** A Git request belongs to the workspace that initiated it, even after UI navigation. */
export interface GitOperationScope {
  workspaceId: string;
  rootsRevision: number;
}

export interface GitScopedOperations {
  status(repoPath: string): Promise<GitRepoStatus>;
  /** At most two explicitly registered repositories; background list updates. */
  repoSummaries(repoPaths: string[]): Promise<GitRepoListResult>;
  log(repoPath: string, skip?: number, limit?: number, ref?: string): Promise<GitLogPage>;
  diff(repoPath: string, filePath: string, staged?: boolean, untracked?: boolean): Promise<GitDiffResult>;
  commitFiles(repoPath: string, sha: string): Promise<GitCommitFilesResult>;
  commitDiff(repoPath: string, sha: string, filePath: string): Promise<GitCommitDiffResult>;
  stage(repoPath: string, paths: string[]): Promise<GitActionResult>;
  unstage(repoPath: string, paths: string[]): Promise<GitActionResult>;
  discard(repoPath: string, paths: string[], mode?: GitDiscardMode): Promise<GitActionResult>;
  stageAll(repoPath: string): Promise<GitActionResult>;
  commit(repoPath: string, message: string): Promise<GitActionResult>;
  fetch(repoPath: string): Promise<GitActionResult>;
  pull(repoPath: string): Promise<GitActionResult>;
  push(repoPath: string): Promise<GitActionResult>;
  pushBranch(repoPath: string, branch: string): Promise<GitActionResult>;
  initRepo(dirPath?: string): Promise<GitAddRepoResult>;
  workspaceRoot(): Promise<{ path: string; workspaceId: string }>;
  listBranches(repoPath: string): Promise<GitBranchList>;
  checkout(repoPath: string, req: GitCheckoutRequest): Promise<GitActionResult>;
  worktreeList(repoPath: string): Promise<GitWorktreeInfo[]>;
  worktreeAdd(repoPath: string, args: { dirName: string; newBranch?: string; branch?: string; baseRef?: string }): Promise<GitWorktreeAddResult>;
  worktreeRemove(worktreePath: string, force?: boolean): Promise<GitActionResult>;
  adoptPreview(worktreePath: string): Promise<GitAdoptPreviewResult>;
  adoptHunks(worktreePath: string, keys: GitAdoptHunkKey[]): Promise<GitAdoptHunksResult>;
}

/** Explicit dispatch allowlist: never expose arbitrary service or IPC methods. */
export const GIT_SCOPED_METHODS = [
  'status', 'repoSummaries', 'log', 'diff', 'commitFiles', 'commitDiff', 'stage', 'unstage', 'discard',
  'stageAll', 'commit', 'fetch', 'pull', 'push', 'pushBranch', 'initRepo',
  'workspaceRoot', 'listBranches', 'checkout', 'worktreeList',
  'worktreeAdd', 'worktreeRemove', 'adoptPreview', 'adoptHunks'
] as const satisfies readonly (keyof GitScopedOperations)[];
