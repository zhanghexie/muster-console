import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepoDiscoveryIssue, WorkspaceRoot } from '../../../../shared/types';
import { workspaceRootLabel } from '../../../../shared/workspaceRoots';
import { usePresenceValue } from '../../components/motion';

export function GitDiscoveryNotice({ issues, count, roots, busy, retry }: {
  issues: GitRepoDiscoveryIssue[]; count: number; roots: readonly WorkspaceRoot[]; busy: boolean; retry: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { presence, value } = usePresenceValue(count ? { issues, count } : null);
  if (!presence.mounted || !value) return null;
  const reason = (issue: GitRepoDiscoveryIssue): string => {
    if (issue.code === 'ENOENT') return t('目录不存在或暂时离线');
    if (issue.code === 'EACCES' || issue.code === 'EPERM') return t('无法读取目录，请检查访问权限');
    if (issue.code === 'ENOTDIR') return t('路径不是文件夹');
    return issue.message;
  };
  return <div className="git-discovery-notice mp-panel" {...presence.spread} role="status" aria-hidden={!count || undefined}>
    <div className="git-discovery-heading">
      <span>{t('仓库扫描未完成（{{n}} 处）', { n: value.count })}</span>
      <button className="git-btn" type="button" disabled={busy || !count} onClick={retry}>{t('重试扫描')}</button>
    </div>
    <p>{t('可访问目录的仓库仍可使用，修复后刷新。')}</p>
    {value.issues.slice(0, 4).map((issue, i) => <div className="git-discovery-issue" key={`${issue.rootId ?? issue.rootPath}:${issue.path}:${i}`}>
      <strong>{(() => { const root = roots.find(root => root.id === issue.rootId); return root ? workspaceRootLabel(root) : t('外部'); })()}</strong>
      <div>{issue.path}</div><div>{reason(issue)}</div>
    </div>)}
    {value.count > 4 ? <p>{t('还有 {{n}} 处目录未完成扫描', { n: value.count - 4 })}</p> : null}
  </div>;
}
