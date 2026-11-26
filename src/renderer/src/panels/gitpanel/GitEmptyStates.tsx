/**
 * GitPanel 空态（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）：
 * 「无仓库」扫描/初始化引导态（外部仓导入入口已随多文件夹支持移除，2026-10-10）。
 * 无 memo：重渲时机与原整面板渲染保持一致。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';

/** 工作区没有 Git 仓库：引导在工作区根目录初始化 */
export function GitNoRepoState({
  busy,
  workspacePath,
  runInitRepo
}: {
  busy: boolean;
  workspacePath: string;
  runInitRepo: (dirPath?: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="git-empty-state ui-empty">
      <div className="git-empty-icon" aria-hidden>
        ⎇
      </div>
      <h3 className="git-empty-title ui-empty-title">{t('当前工作区没有 Git 仓库')}</h3>
      <p className="git-empty-desc ui-empty-desc">
        {t('未在工作区下扫描到仓库，可以在工作区根目录初始化一个。')}
      </p>
      {workspacePath ? (
        <code className="git-empty-path" title={workspacePath}>
          {workspacePath}
        </code>
      ) : null}
      <div className="git-empty-actions">
        <button
          type="button"
          className="git-btn primary"
          disabled={busy || !workspacePath}
          onClick={() => runInitRepo(workspacePath || undefined)}
        >
          {t('在工作区根目录初始化')}
        </button>
      </div>
    </div>
  );
}
