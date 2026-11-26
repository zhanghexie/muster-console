/**
 * 归档 / 合入删 worktree 前的拆链顺序。
 * Windows 上 GUI driver 子进程 cwd 仍占目录时，`git worktree remove` 会失败；
 * 必须 await 拆链完成后再 cleanup，禁止 fire-and-forget 竞态。
 */
export async function releaseThenCleanup(
  release: (() => void | Promise<void>) | null | undefined,
  cleanup: () => void | Promise<void>
): Promise<void> {
  if (release) {
    await release();
  }
  await cleanup();
}
