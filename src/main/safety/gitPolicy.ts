import type { SafetyGitEvidence } from '../../shared/safety';

/** Host-only classification. Auxiliary facts never overturn a model concern. */
export function assessIntegrationEvidence(evidence: SafetyGitEvidence | undefined, delivery?: string) {
  const critical: string[] = [], informational: string[] = [];
  if (!evidence || evidence.operation !== 'integrate') return { critical, informational };
  const tasks = evidence.repositories.filter(repo => repo.role === 'task' && !repo.roleUnknown);
  if (!tasks.length) critical.push('任务仓库及源/目标提交无法确认');
  if (evidence.incomplete) critical.push('任务 diff 捕获不完整');
  const claimsPass = /测试(?:全部|均|已|已全部)?(?:通过|成功)|(?:tests?|testing)\s+(?:(?:all|have|has)\s+)?(?:passed|pass|successful)/i.test(delivery ?? '');
  for (const repo of evidence.repositories) {
    if (!tasks.includes(repo)) {
      informational.push(`${repo.id}: ${repo.roleUnknown ? 'roleUnknown，归属未确认' : repo.role ?? 'shared'}工作区材料仅供参考${repo.unavailable ? '，仓库不可用' : ''}`);
      continue;
    }
    if (repo.unavailable) critical.push(`${repo.id}: 任务仓库不可用`);
    if (!repo.source || !repo.target) critical.push(`${repo.id}: 源/目标提交不明`);
    const diff = repo.content.diff && evidence.contents[repo.content.diff];
    if (typeof diff !== 'string') critical.push(`${repo.id}: 任务 diff 不可读取`);
    else {
      // Inspect patch headers, including removed/renamed paths, never code prose.
      const headers = diff.match(/^diff --git .*$/gm) ?? [];
      if (headers.some(header => /[ab]\/src\/main\/safety\/|[ab]\/src\/[^\s"]*(?:permission|approval|authorization|capabilityAuth)[^\s"]*|[ab]\/src\/shared\/safety\.ts|[ab]\/src\/main\/(?:sessions\.ts|capabilities\/executor\.ts|git\/(?:worktreeIntegrate|mergeIsolate)\.ts)/i.test(header)))
        critical.push(`${repo.id}: 任务 diff 涉及安全、权限或审批链路`);
    }
    const status = repo.tests?.status ?? 'not-collected';
    if (status === 'verified-fail') critical.push(`${repo.id}: 已验证测试失败`);
    else if (status === 'not-collected') {
      informational.push(`${repo.id}: tests=not-collected`);
      if (claimsPass) critical.push(`${repo.id}: 交付声称测试通过，但未提供对应验证证据`);
    }
  }
  return { critical, informational };
}
