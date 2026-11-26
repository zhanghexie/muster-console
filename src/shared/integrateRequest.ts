/**
 * Worker 请调度合入隔离 worktree 的协调文案（纯函数，无 process）。
 * 调度收到后应立刻 sessions_integrate；是否弹确认由 approval 决定（缺省 required）。
 */
export interface IntegrateWorktreeGroup {
  groupId: string;
  rootId: string;
  path: string;
  sourcePath: string;
  branch: string;
  repos: Array<{ relativePath: string; path: string; branch: string }>;
}

export function buildIntegrateRequestMessage(opts: {
  sessionId: string;
  sessionName: string;
  branch: string;
  note?: string;
  worktreeGroups?: IntegrateWorktreeGroup[];
}): string {
  const lines = [
    '【请合入隔离 worktree】',
    `会话 ${opts.sessionName.trim() || opts.sessionId}（${opts.sessionId}）用户已验收。`,
    `分支 ${opts.branch.trim()}。`,
    '请立即 sessions_integrate（sessionId 如上）。简单修改可传 approval=auto 免确认；产品形态/数据流/IPC 契约必须弹确认（缺省 required）。不要让 Worker 自己 git merge 或 git worktree remove。' +
      (opts.worktreeGroups && opts.worktreeGroups.length > 1
        ? '宿主会按记录的全部仓组逐仓合入；失败保留前序成果，成功后可归档清理全部任务树。'
        : '宿主会从主仓 merge、停会话、删 worktree。')
  ];
  for (const group of opts.worktreeGroups ?? []) {
    lines.push(`仓组 ${group.groupId} / 来源 ${group.rootId}：${group.sourcePath} → ${group.path}；分支 ${group.branch}。`);
    for (const repo of group.repos.filter(repo => repo.relativePath)) {
      lines.push(`  嵌套仓 ${repo.relativePath}：${repo.path}；分支 ${repo.branch}。`);
    }
  }
  const note = opts.note?.trim();
  if (note) lines.push(`备注：${note}`);
  return lines.join('\n');
}
