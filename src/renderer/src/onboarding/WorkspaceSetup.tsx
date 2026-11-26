import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandLoader } from '../components/BrandLoader';
import { IconCheck, IconFolderOpen, IconFolderPlus } from '../components/icons';
import { useWorkspaceStore } from '../store';
import { SetupActions, useSetupAction } from './SetupParts';

export function WorkspaceSetup(): React.JSX.Element {
  const { t } = useTranslation();
  const { workspaceRecommendation, openWorkspace, switching } = useWorkspaceStore();
  const [existingPath, setExistingPath] = useState('');
  const [name, setName] = useState<string>();
  const nameId = useId();
  const { busy, error, run, clearError } = useSetupAction();
  const recommended = workspaceRecommendation?.root ?? '';
  const selectedPath = existingPath || recommended;
  const defaultName = existingPath ? existingPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : t('我的工作区');
  const pending = busy || switching;

  return <form method="post" onSubmit={event => {
    event.preventDefault();
    if (!selectedPath || pending) return;
    void run(async () => {
      const result = await openWorkspace({ path: selectedPath, name: name?.trim() || defaultName,
        ...(!existingPath ? { ensureRecommendedRoot: true } : {}) });
      if (!result.ok) throw new Error(result.message || t('创建失败'));
    });
  }}>
    <div className="setup-workspace-options">
      {recommended && <button type="button" className="setup-card setup-choice" aria-pressed={!existingPath}
        disabled={pending} onClick={() => { setExistingPath(''); clearError(); }}>
        <IconFolderPlus size={20} />
        <span className="setup-row-text"><strong>{t('使用推荐文件夹')}</strong><code>{recommended}</code></span>
        {!existingPath && <IconCheck size={16} />}
      </button>}
      <button type="button" className="setup-card setup-choice" aria-pressed={Boolean(existingPath)} disabled={pending} onClick={() => void run(async () => {
        const result = await window.api.workspaces.pickDir();
        if (result.ok && result.path) setExistingPath(result.path);
        else if (result.message && result.message !== 'cancelled') throw new Error(result.message);
      })}>
        <IconFolderOpen size={20} />
        <span className="setup-row-text"><strong>{t('选择已有文件夹')}</strong>
          {existingPath ? <code>{existingPath}</code> : <span>{t('打开已有项目或任意本地目录')}</span>}
        </span>
        {existingPath && <IconCheck size={16} />}
      </button>
    </div>
    <div className="setup-field">
      <label htmlFor={nameId}>{t('工作区名称')}</label>
      <input className="ui-input" id={nameId} name="workspace-name" autoComplete="off" value={name ?? defaultName ?? ''} disabled={pending}
        onChange={event => setName(event.target.value)} />
    </div>
    {error && <p className="setup-error" role="alert">{error}</p>}
    <SetupActions>
      <button type="submit" className="btn primary" disabled={!selectedPath || pending}>
        {pending ? <BrandLoader size={16} /> : <IconFolderPlus />}{t('创建工作区')}
      </button>
    </SetupActions>
  </form>;
}
