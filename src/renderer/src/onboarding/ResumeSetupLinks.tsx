import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsTabId } from '../../../shared/commandPalette';
import { IconChevronRight } from '../components/icons';
import type { DeferredSetupStep } from './setupProgress';
import '../styles/workbench-setup.css';

export function ResumeSetupLinks({ deferred, onOpenSettings, onShowSession }: {
  deferred: readonly DeferredSetupStep[];
  onOpenSettings?: (tab: SettingsTabId, focusId?: string) => void;
  onShowSession?: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!deferred.length) return null;
  const destinations = {
    tools: { label: t('设置 → Harness 接入 → 引擎配置 → 刷新'), where: () => onOpenSettings?.('worker', 'worker-engines') },
    model: { label: t('设置 → 模型与输入 → 模型服务商'), where: () => onOpenSettings?.('agent', 'agent-provider') },
    remote: { label: t('设置 → 远程访问 → 用网址打开'), where: () => onOpenSettings?.('remoteAccess', 'webaccess-url') },
    session: { label: t('左栏 → 工作会话 → ＋'), where: onShowSession }
  };
  return <div className="setup-resume">
    <p>{t('可以稍后从这里继续')}</p>
    <ul>{deferred.map(step => <li key={step}>
      {(step === 'session' ? onShowSession : onOpenSettings) ? <button type="button" className="btn ghost" onClick={destinations[step].where}>
        {destinations[step].label}<IconChevronRight />
      </button> : <span>{destinations[step].label}</span>}
    </li>)}</ul>
  </div>;
}
