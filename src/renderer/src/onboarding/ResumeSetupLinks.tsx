import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsTabId } from '../../../shared/commandPalette';
import { IconChevronRight } from '../components/icons';
import type { DeferredSetupStep } from './setupProgress';
import '../styles/workbench-setup.css';

export function ResumeSetupLinks({ deferred, onOpenSettings }: {
  deferred: readonly DeferredSetupStep[];
  onOpenSettings: (tab: SettingsTabId, focusId?: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!deferred.length) return null;
  const destinations = {
    tools: { label: t('设置 → Harness 接入 → 引擎配置 → 刷新'), where: () => onOpenSettings('worker', 'worker-engines') },
    model: { label: t('设置 → 模型与输入 → 模型服务商'), where: () => onOpenSettings('agent', 'agent-provider') },
    remote: { label: t('设置 → 远程访问 → 用网址打开'), where: () => onOpenSettings('remoteAccess', 'webaccess-url') }
  };
  return <div className="setup-resume">
    <h2>{t('稍后设置')}</h2>
    <ul>{deferred.map(step => <li key={step}>
      <button type="button" className="btn ghost" onClick={destinations[step].where}>
        {destinations[step].label}<IconChevronRight />
      </button>
    </li>)}</ul>
  </div>;
}
