import { useScopedGit } from './GitWorkspaceScope';
/**
 * GitPanel 根部浮层（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）：
 * 隐藏眼右键菜单、变更右键菜单、采纳确认与丢弃确认对话框。
 * 无 memo：重渲时机与原整面板渲染保持一致。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GitAdoptHunkKey } from '../../../../shared/types';
import { type ContextMenuPoint, ContextMenu } from '../../components/ContextMenu';
import { AppConfirmDialog } from '../../components/AppConfirmDialog';
import { toggleHiddenViewOnly, type HiddenView } from '../../../../shared/workspaceUiPersist';
import type { DiscardConfirmation } from './useGitActions';

export function GitPanelOverlays({
  hideBtnMenu,
  setHideBtnMenu,
  hiddenView,
  unhideAll,
  persistHiddenView,
  changeCtxMenu,
  setChangeCtxMenu,
  changeCtxItems,
  onChangeCtxSelect,
  adoptConfirmOpen,
  setAdoptConfirmOpen,
  adoptSel,
  doAdopt,
  discardConfirm,
  setDiscardConfirm,
  selectedPath,
  runAction
}: {
  hideBtnMenu: ContextMenuPoint | null;
  setHideBtnMenu: React.Dispatch<React.SetStateAction<ContextMenuPoint | null>>;
  hiddenView: HiddenView;
  unhideAll: () => void;
  persistHiddenView: (next: HiddenView) => void;
  changeCtxMenu: ContextMenuPoint | null;
  setChangeCtxMenu: (v: null) => void;
  changeCtxItems: { id: string; label: string; danger?: boolean }[];
  onChangeCtxSelect: (id: string) => void;
  adoptConfirmOpen: boolean;
  setAdoptConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  adoptSel: Map<string, GitAdoptHunkKey>;
  doAdopt: () => void;
  discardConfirm: DiscardConfirmation | null;
  setDiscardConfirm: React.Dispatch<React.SetStateAction<DiscardConfirmation | null>>;
  selectedPath: string | null;
  runAction: (fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const git = useScopedGit();
  return (
    <>
      {hideBtnMenu ? (
        <ContextMenu
          x={hideBtnMenu.x}
          y={hideBtnMenu.y}
          anchor={hideBtnMenu.anchor}
          items={[
            { id: 'unhide-all', label: t('全部取消隐藏') },
            {
              id: 'only-hidden',
              label: t('只显示隐藏的'),
              checked: hiddenView === 'only'
            }
          ]}
          onClose={() => setHideBtnMenu(null)}
          onSelect={(id) => {
            if (id === 'unhide-all') unhideAll();
            else if (id === 'only-hidden') {
              persistHiddenView(toggleHiddenViewOnly(hiddenView));
            }
          }}
        />
      ) : null}
      {changeCtxMenu && (
        <ContextMenu
          x={changeCtxMenu.x}
          y={changeCtxMenu.y}
          anchor={changeCtxMenu.anchor}
          items={changeCtxItems}
          onClose={() => setChangeCtxMenu(null)}
          onSelect={onChangeCtxSelect}
        />
      )}
      <AppConfirmDialog
        open={adoptConfirmOpen}
        title={t('采纳到主仓')}
        detail={t(
          '把勾选的 {{n}} 个 hunk（{{files}} 个文件）应用到主仓？\n改动会以 staged 方式落下（不自动提交），应用前会检查主仓干净且无冲突。',
          {
            n: adoptSel.size,
            files: new Set([...adoptSel.values()].map((k) => k.file)).size
          }
        )}
        confirmLabel={t('采纳')}
        onCancel={() => setAdoptConfirmOpen(false)}
        onConfirm={doAdopt}
      />
      <AppConfirmDialog
        open={!!discardConfirm}
        title={discardConfirm?.mode === 'unstaged' ? t('丢弃未暂存改动') : t('丢弃全部改动')}
        detail={discardConfirm ? [discardConfirm.repoPath,
          discardConfirm.mode === 'unstaged' ? t('仅丢弃未暂存改动，保留已暂存内容。') : t('丢弃所列文件的已暂存及未暂存改动。'),
          t('共 {{n}} 个文件，将删除 {{newFiles}} 个新文件。此操作不可撤销。', { n: discardConfirm.paths.length, newFiles: discardConfirm.newFiles }),
          ...discardConfirm.paths].join('\n') : ''}
        confirmLabel={t('丢弃')}
        danger
        onCancel={() => setDiscardConfirm(null)}
        onConfirm={() => {
          if (!discardConfirm) return;
          const { paths, mode, repoPath } = discardConfirm;
          setDiscardConfirm(null);
          if (selectedPath !== repoPath) return;
          void runAction(() => git.discard(repoPath, paths, mode));
        }}
      />
    </>
  );
}
