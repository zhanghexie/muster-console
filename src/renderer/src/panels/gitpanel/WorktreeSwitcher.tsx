import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepoLocation, GitWorktreeInfo, SessionMeta } from '../../../../shared/types';
import { pathKey } from '../../../../shared/pathKey';
import { sessionWorktreeReviewRepos } from '../../../../shared/sessionWorktreeReview';
import { CustomSelect, type SelectOption } from '../../components/CustomSelect';
import { IconFork } from '../../components/icons';
import { useScopedGit } from './GitWorkspaceScope';

type WorktreeChoice = SelectOption & { repoPath: string };

function directoryName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

/** Mounted beside the branch selector for the displayed checkout. */
export function WorktreeSwitcher({ workspaceId, rootsRevision, session, repoPath, enabled, onSelect, onError }: {
  workspaceId: string;
  rootsRevision: number;
  session?: SessionMeta;
  repoPath: string;
  enabled: boolean;
  onSelect: (repoPath: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const git = useScopedGit();
  const [query, setQuery] = useState(0);
  const [lookup, setLookup] = useState<{
    query: number; locations: GitRepoLocation[]; related: GitWorktreeInfo[]; error: string;
  }>();
  const selection = useRef(0);
  const available = useRef(enabled);
  available.current = enabled;
  useLayoutEffect(() => () => { selection.current++; }, [enabled, repoPath, workspaceId, rootsRevision]);
  const refresh = useCallback(() => setQuery(current => current + 1), []);

  useEffect(() => {
    if (!query || !enabled) return;
    let valid = true;
    const list = window.api.git.listRepoLocations(false, workspaceId).then(result => {
      if (result.workspaceId !== workspaceId || result.rootsRevision !== rootsRevision) throw new Error(t('工作区来源已变更'));
      return result;
    });
    const related = git.worktreeList(repoPath);
    void Promise.allSettled([list, related]).then(([locations, worktrees]) => {
      if (!valid) return;
      const error = [locations, worktrees].flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
      if (locations.status === 'fulfilled' && locations.value.issueCount) error.unshift(t('仓库扫描未完成'));
      setLookup({ query, locations: locations.status === 'fulfilled' ? locations.value.repos : [],
        related: worktrees.status === 'fulfilled' ? worktrees.value : [], error: error.join('\n') });
    });
    return () => { valid = false; };
  }, [query, enabled, workspaceId, rootsRevision, repoPath, git, t]);

  const options = useMemo(() => {
    const choices = new Map<string, WorktreeChoice>();
    const add = (repoPath: string, label: string, group: string) => {
      const value = pathKey(repoPath);
      if (!choices.has(value)) choices.set(value, { value, label, group, repoPath, description: repoPath });
    };
    let taskError = '';
    if (session) {
      try {
        const members = sessionWorktreeReviewRepos(session);
        const groupNames = new Map(members.filter(member => !member.relativePath).map(member =>
          [member.groupId, directoryName(member.sourcePath ?? member.repoPath)]));
        for (const member of members) {
          const root = groupNames.get(member.groupId);
          const name = (root && member.relativePath ? `${root}/${member.relativePath}` : root) ?? directoryName(member.sourcePath ?? member.repoPath);
          add(member.repoPath, member.branch ? `${name} · ${member.branch}` : name, session.name);
        }
      } catch (error) { taskError = String(error); }
    }
    const locations = lookup?.locations ?? [];
    const related = lookup?.related ?? [];
    const sourcePaths = new Set(locations.filter(repo => !repo.worktree).map(repo => pathKey(repo.path)));
    if (related.some(repo => !repo.main && !repo.bare)) {
      for (const repo of related) {
        if (repo.bare || (repo.main && !sourcePaths.has(pathKey(repo.path)))) continue;
        const name = directoryName(repo.path);
        add(repo.path, repo.main ? t('主检出 · {{name}}', { name }) : repo.branch ? `${name} · ${repo.branch}` : name, t('当前仓库'));
      }
    }
    for (const repo of locations) {
      if (repo.worktree) add(repo.path, repo.name, t('工作区 Worktree'));
    }
    const loading = !lookup || lookup.query !== query;
    const error = [taskError, !loading && lookup?.error].filter(Boolean).join('\n');
    const rows: SelectOption[] = [...choices.values()];
    if (error || !rows.length) rows.push({ value: '__worktree_status__', disabled: true,
      label: error ? t('无法读取部分 Worktree，重新打开可重试') : loading ? t('正在读取 Worktree…') : t('没有可切换的 Worktree'),
      description: error || undefined });
    return { choices, rows };
  }, [session, lookup, query, t]);

  const switchCheckout = async (value: string): Promise<void> => {
    const choice = options.choices.get(value);
    if (!choice || !available.current) return;
    const request = ++selection.current;
    const current = () => available.current && selection.current === request;
    try {
      const result = await window.api.git.listRepoLocations(false, workspaceId, [choice.repoPath]);
      if (!current()) return;
      const match = result.workspaceId === workspaceId && result.rootsRevision === rootsRevision
        ? result.repos.find(repo => pathKey(repo.path) === value) : undefined;
      if (!match) throw new Error(t('Worktree 已不可用：{{path}}', { path: choice.repoPath }));
      onSelect(match.path);
    } catch (error) {
      if (current()) onError(error instanceof Error ? error.message : String(error));
    }
  };

  return <CustomSelect ariaLabel={t('切换 Worktree')} triggerLabel="Worktree" triggerIcon={<IconFork size={13} />} className="git-worktree-picker"
    menuClassName="git-worktree-menu" detailsAsTooltip value={pathKey(repoPath)} options={options.rows}
    disabled={!enabled} menuEnabled={enabled} onOpen={refresh} onChange={value => void switchCheckout(value)} />;
}
