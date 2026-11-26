import { ErrorTip } from '../components/ErrorTip';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { RightContent } from '../../../shared/rightWorkspace';
import { useRightWorkspace } from '../rightWorkspace';
import { useWorkspaceStore } from '../store';
import { createScopedGit } from './gitpanel/GitWorkspaceScope';
import { FileDiffView } from './FileDiffView';
import { IconBranch, IconRefresh } from '../components/icons';

export function IndependentDiff({ content, active }: { content: Extract<RightContent, { kind: 'diff' }>; active: boolean }): React.JSX.Element {
  const { t } = useTranslation(), bridge = useRightWorkspace(), { workspaces } = useWorkspaceStore();
  const workspaceId = bridge?.model.workspaceId ?? '', rootsRevision = workspaces.find(w => w.id === workspaceId)?.rootsRevision ?? 0;
  const git = useMemo(() => createScopedGit({ workspaceId, rootsRevision }), [workspaceId, rootsRevision]);
  const [diff, setDiff] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true; setLoading(true);
    void git.diff(content.repoPath, content.filePath, content.staged, content.untracked).then(result => { if (live) { setDiff(result.diff); setError(''); } }).catch(error => { if (live) setError(String(error)); }).finally(() => { if (live) setLoading(false); });
    const off = window.api.on('fs:changed', () => { if (live) setRefresh(value => value + 1); });
    return () => { live = false; off(); };
  }, [active, git, content.repoPath, content.filePath, content.staged, content.untracked, refresh]);
  const shown = bridge?.current?.content === content;
  const fullPath = `${content.repoPath.replace(/[\\/]+$/, '')}/${content.filePath}`;
  return <div className="right-independent-diff">
    {shown && bridge?.location ? createPortal(<div className="right-git-location"><IconBranch size={14}/><span className="right-full-path" title={fullPath}>{fullPath}</span><span className="right-diff-stage">{content.staged ? t('已暂存') : t('未暂存')}</span></div>, bridge.location) : null}
    {shown && bridge?.toolbar ? createPortal(<button type="button" className="right-icon" title={t('刷新')} aria-label={t('刷新')} disabled={loading} onClick={() => setRefresh(value => value + 1)}><IconRefresh size={14}/></button>, bridge.toolbar) : null}
    {error ? <ErrorTip message={error} /> : null}<FileDiffView diffText={diff} loading={loading}/>
  </div>;
}
