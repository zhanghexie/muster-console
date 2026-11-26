import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceInfo } from '../../../shared/types';
import { choiceIncluded, workspaceRepositoryChoices, type WorkspaceRepositoryChoice } from '../../../shared/worktreeSelection';

export function useWorktreeSelection(open: boolean, enabled: boolean, workspace: WorkspaceInfo | undefined, runningRootId?: string, defaultAll = false, preserveCwd = false,
  initialGroups?: import('../../../shared/types').WorkspaceWorktreeGroupSelection[]) {
  const { t } = useTranslation();
  const scope = JSON.stringify([workspace?.id, workspace?.rootsRevision, workspace?.roots?.map(root => [root.id, root.path])]);
  const [snapshot, setSnapshot] = useState<{ scope: string; choices: WorkspaceRepositoryChoice[]; error?: string; warning?: string }>();
  const [selected, setSelected] = useState<WorkspaceRepositoryChoice[]>([]);
  const [working, setWorking] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [reviewedSavedGroups, setReviewedSavedGroups] = useState(false);
  const force = useRef(false);
  const wasOpen = useRef(false);
  const wasEnabled = useRef(false);
  const selectAllOnLoad = useRef(false);
  const selectSourceOnLoad = useRef(false);
  if (wasOpen.current !== open) {
    wasOpen.current = open;
    if (open) { setSelected([]); setWorking(''); setSnapshot(undefined); setReviewedSavedGroups(false); }
  }
  if (wasEnabled.current !== (open && enabled)) {
    wasEnabled.current = open && enabled;
    if (open && enabled) {
      selectAllOnLoad.current = defaultAll; selectSourceOnLoad.current = preserveCwd;
      if (preserveCwd) setSelected([]);
    }
  }
  useEffect(() => {
    if (!open || !enabled || !workspace) return;
    let cancelled = false;
    const rescan = force.current; force.current = false;
    setSnapshot(undefined);
    void window.api.git.listRepoLocations(rescan, workspace.id).then(result => {
      if (cancelled) return;
      if (result.workspaceId !== workspace.id || result.rootsRevision !== (workspace.rootsRevision ?? 0)) throw new Error(t('工作区源文件夹已变化，请刷新仓库。'));
      const choices = workspaceRepositoryChoices(workspace, result.repos);
      if (selectSourceOnLoad.current) {
        selectSourceOnLoad.current = false;
        setSelected(initialGroups ? choices.filter(choice => initialGroups.some(group => group.rootId === choice.rootId && group.relativePath === choice.relativePath))
          : choices.filter(choice => choice.rootId === runningRootId && !choice.relativePath));
      }
      if (selectAllOnLoad.current) {
        selectAllOnLoad.current = false;
        setSelected(choices);
        const running = choices.filter(choice => choice.rootId === runningRootId);
        setWorking((running.find(choice => !choice.relativePath) ?? (running.length === 1 ? running[0] : undefined))?.key ?? '');
      }
      setSnapshot({ scope, choices, ...(result.issueCount ? { warning: result.issues.map(issue => issue.message).join('\n') || t('仓库扫描未完成') } : {}) });
    }).catch(error => { if (!cancelled) setSnapshot({ scope, choices: [], error: String(error) }); });
    return () => { cancelled = true; };
  }, [open, enabled, scope, refresh, runningRootId, t]);
  const choices = snapshot?.scope === scope ? snapshot.choices : [];
  const currentSelected = useMemo(() => selected.filter(selection => choices.some(choice => choice.key === selection.key && choice.path === selection.path)), [selected, choices]);
  const missingSavedGroup = !reviewedSavedGroups && initialGroups?.some(group => !choices.some(choice => choice.rootId === group.rootId && choice.relativePath === group.relativePath));
  const removed = snapshot?.scope === scope && (currentSelected.length !== selected.length || !!missingSavedGroup);
  const workingChoices = choices.filter(choice => choice.rootId === runningRootId && choiceIncluded(choice, currentSelected));
  const currentWorking = workingChoices.find(choice => choice.key === working);
  const ready = !enabled || (!!snapshot && snapshot.scope === scope && !snapshot.error && !removed && currentSelected.length > 0 && (preserveCwd || !!currentWorking));
  return { preserveCwd, choices, selected: currentSelected, working, workingChoices, ready,
    loading: enabled && (!snapshot || snapshot.scope !== scope), error: snapshot?.scope === scope ? snapshot.error : undefined, removed,
    warning: snapshot?.scope === scope ? snapshot.warning : undefined,
    setWorking,
    toggle(choice: WorkspaceRepositoryChoice, checked: boolean) {
      setReviewedSavedGroups(true);
      const next = currentSelected.filter(selection => selection.rootId !== choice.rootId || selection.relativePath !== choice.relativePath);
      if (checked) next.push(choice);
      setSelected(next);
      // A root repository is an unambiguous continuation of the visible source folder.
      if (checked && choice.rootId === runningRootId && !choice.relativePath && !working) setWorking(choice.key);
    },
    refresh() { force.current = true; setRefresh(value => value + 1); },
    request: enabled && (preserveCwd ? currentSelected.length > 0 : !!currentWorking) ? { isolationGroups: currentSelected.map(({ rootId, relativePath }) => ({ rootId, relativePath, ...(preserveCwd ? { repoSet: [] } : {}) })), cwd: preserveCwd ? undefined : currentWorking!.path } : undefined };
}
