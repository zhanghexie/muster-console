import { ErrorTip } from './ErrorTip';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceInfo, WorkspaceRoot } from '../../../shared/types';
import { defaultRootFor, sourceRootsFor } from '../../../shared/workspaceRoots';
import { CustomSelect } from './CustomSelect';

export interface TaskSourceTarget {
  workspaceId: string;
  rootId: string;
  cwd?: string;
  rootsRevision?: number;
}

/** Opening pins the workspace and directory. Default changes never move a draft. */
export function useTaskSource(open: boolean, workspace?: WorkspaceInfo, initialSource?: { rootId: string; path: string }) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<{ workspaceId: string; rootId?: string; path?: string }>();
  const wasOpen = useRef(false);
  let roots: readonly WorkspaceRoot[] = [];
  let error = '';
  try {
    if (!workspace) throw new Error(t('请先打开工作区'));
    roots = sourceRootsFor(workspace);
  } catch (e) {
    error = t('工作区源目录不可用：{{message}}', { message: (e as Error).message });
  }
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open) {
      let root: WorkspaceRoot | undefined;
      try { if (workspace) root = defaultRootFor(workspace); } catch { /* visible below */ }
      setSelection(workspace ? { workspaceId: workspace.id, rootId: initialSource?.rootId ?? root?.id,
        path: initialSource?.path ?? root?.path } : undefined);
    }
  }
  if (!error && selection?.workspaceId !== workspace?.id) {
    error = t('工作区已切换，请关闭后重新创建任务');
  }
  const root = roots.find(r => r.id === selection?.rootId && r.path === selection.path);
  if (!error && !root) error = t('所选源文件夹已失效，请重新选择');
  const target: TaskSourceTarget | undefined = !error && root && workspace
    ? { workspaceId: workspace.id, rootId: root.id, rootsRevision: workspace.rootsRevision } : undefined;
  const identity = JSON.stringify([selection?.workspaceId, selection?.rootId, selection?.path]);
  const requestKey = JSON.stringify([identity, workspace?.id, workspace?.rootsRevision]);
  return { roots, root, error, target, identity, requestKey,
    locked: selection?.workspaceId !== workspace?.id,
    select: (rootId: string) => {
      const picked = roots.find(r => r.id === rootId);
      if (workspace && picked && selection?.workspaceId === workspace.id) {
        setSelection({ workspaceId: workspace.id, rootId: picked.id, path: picked.path });
      }
    }
  };
}

export function TaskSourceField({ source, disabled, showError = true }: {
  source: ReturnType<typeof useTaskSource>;
  disabled: boolean;
  showError?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <div className="task-source-field" title={source.root?.path}>
    <span>{t('运行位置')}</span>
    <CustomSelect ariaLabel={t('运行位置')} menuClassName="task-source-menu" className="task-path-select"
      value={source.root?.id ?? ''} placeholder={t('请选择源文件夹')}
      disabled={disabled || source.locked || (source.roots.length === 1 && !!source.root)}
      options={source.roots.map(root => ({ value: root.id, label: root.path }))}
      onChange={source.select} />
    {showError && source.error ? <ErrorTip message={source.error} /> : null}
  </div>;
}
