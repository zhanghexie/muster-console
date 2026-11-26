import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  dataTransferHasPaths,
  pathsFromDataTransfer
} from '../../../shared/fileDropPaths';

export type SideToolsTab = 'files' | 'git' | 'browser';

function pathsFromDrag(e: React.DragEvent): string[] {
  const getPath = window.api?.shell?.pathForFile;
  if (typeof getPath !== 'function') return [];
  return pathsFromDataTransfer(e.dataTransfer, (f) => getPath(f));
}

/** 面板历史导航（‹ ›）：与「文件|Git」页签分离，嵌在工具栏左端（2026-08-28 起页签挪右缘） */
export function SideToolsHistoryNav({
  onBack,
  canBack,
  onForward,
  canForward
}: {
  /** 面板历史：返回上一面板（右栈按工作区独立） */
  onBack?: () => void;
  /** 栈空时置灰（按钮常显） */
  canBack?: boolean;
  /** 面板历史：前进下一面板 */
  onForward?: () => void;
  canForward?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="side-tools-history-nav">
      {onBack ? (
        <button
          type="button"
          className="git-btn ghost tiny side-tools-history-btn"
          title={t('返回上一面板')}
          disabled={!canBack}
          onClick={onBack}
        >
          ‹
        </button>
      ) : null}
      {onForward ? (
        <button
          type="button"
          className="git-btn ghost tiny side-tools-history-btn"
          title={t('前进下一面板')}
          disabled={!canForward}
          onClick={onForward}
        >
          ›
        </button>
      ) : null}
    </div>
  );
}

/** 嵌入各面板工具栏的紧凑「文件 | Git」切换（药丸凹槽分段，对齐会话「对话 | 轨迹」） */
export function SideToolsSwitcher({
  tab,
  onSelect,
  onDropOnTab
}: {
  tab: SideToolsTab;
  onSelect: (tab: SideToolsTab) => void;
  /** 拖路径到按钮：切到对应页并跳转 */
  onDropOnTab?: (tab: SideToolsTab, paths: string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [over, setOver] = useState<SideToolsTab | null>(null);

  const bindDrop = (id: SideToolsTab) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dataTransferHasPaths(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(id);
    },
    onDragLeave: () => {
      setOver((v) => (v === id ? null : v));
    },
    onDrop: (e: React.DragEvent) => {
      if (!dataTransferHasPaths(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      const paths = pathsFromDrag(e);
      if (paths.length === 0) {
        onSelect(id);
        return;
      }
      if (onDropOnTab) onDropOnTab(id, paths);
      else onSelect(id);
    }
  });

  return (
    <div className="side-tools-switcher" role="tablist" aria-label={t('侧栏工具')}>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'files'}
        className={`git-btn ghost tiny${tab === 'files' ? ' is-on' : ''}${
          over === 'files' ? ' is-drop' : ''
        }`}
        title={t('文件 (F) · 可拖入路径')}
        onClick={() => onSelect('files')}
        {...bindDrop('files')}
      >
        {t('文件')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'git'}
        className={`git-btn ghost tiny${tab === 'git' ? ' is-on' : ''}${
          over === 'git' ? ' is-drop' : ''
        }`}
        title={t('Git (G) · 可拖入路径')}
        onClick={() => onSelect('git')}
        {...bindDrop('git')}
      >
        Git
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'browser'}
        className={`git-btn ghost tiny${tab === 'browser' ? ' is-on' : ''}`}
        title={t('浏览器 (B) · 可拖入文件以 file:// 打开')}
        onClick={() => onSelect('browser')}
      >
        {t('浏览器')}
      </button>
    </div>
  );
}
