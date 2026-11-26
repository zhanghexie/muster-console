import React, { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsTabId } from '../../../shared/commandPalette';
import { IconChat, IconClose, IconFolderPlus } from '../components/icons';
import type { Presence } from '../components/motion';
import { ResumeSetupLinks } from './ResumeSetupLinks';
import type { DeferredSetupStep } from './setupProgress';

export interface WorkbenchSetup {
  step: 'workspace' | 'session' | 'done';
  deferred: readonly DeferredSetupStep[];
  onBack: () => void;
  onSkipSession: () => void;
  onShowSession: () => void;
  onDismiss: () => void;
}

export function WorkbenchSetupGuide({ setup, presence, onOpenSettings, onRevealSidebar }: {
  setup: WorkbenchSetup;
  presence: Presence;
  onOpenSettings: (tab: SettingsTabId, focusId?: string) => void;
  onRevealSidebar?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const workspace = setup.step === 'workspace';
  const finished = setup.step === 'done';
  const exiting = presence.stage === 'out';
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const needsSidebar = !!onRevealSidebar;
  useLayoutEffect(() => {
    if (!exiting && (finished || needsSidebar)) heading.current?.focus({ preventScroll: true });
  }, [exiting, finished, needsSidebar]);

  const dismiss = (): void => {
    heading.current?.closest('main')?.focus({ preventScroll: true });
    setup.onDismiss();
  };
  return <section className="workbench-setup-guide mp-panel" {...presence.spread}
    aria-labelledby={headingId} aria-hidden={exiting || undefined} {...(exiting ? { inert: '' } : {})}
    onKeyDown={event => {
      if (workspace || exiting || event.defaultPrevented || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }}>
    <div className="workbench-setup-title">
      {workspace ? <IconFolderPlus size={22} /> : <IconChat size={22} />}
      <div>
        {!finished && <div className="workbench-setup-progress">{t('首次设置 · {{step}} / 5', { step: workspace ? 4 : 5 })}</div>}
        <h2 id={headingId} ref={heading} tabIndex={-1}>{workspace ? t('在工作台创建工作区') : finished ? t('继续设置') : t('打开第一条会话')}</h2>
      </div>
      {!workspace && <button type="button" className="modal-close workbench-setup-close"
        aria-label={t('关闭设置引导')} title={t('关闭设置引导')} onClick={dismiss}>
        <IconClose size={16} />
      </button>}
    </div>
    {!finished && <p>{workspace
      ? t('点左下角「工作区」旁的「＋」，再选择文件夹。')
      : t('点左栏「工作会话」旁的「＋」。在「新建任务」里可以直接开始任务，也可以点「新建空白」后再发消息。')}</p>}
    <ResumeSetupLinks deferred={setup.deferred} onOpenSettings={onOpenSettings} onShowSession={setup.onShowSession} />
    {!finished && <div className="workbench-setup-actions">
      {onRevealSidebar && <button type="button" className="btn" onClick={onRevealSidebar}>{t('显示左侧栏')}</button>}
      <button type="button" className="btn ghost" onClick={setup.onBack}>{t('返回连接设置')}</button>
      {!workspace && <button type="button" className="btn ghost" onClick={setup.onSkipSession}>{t('稍后创建会话')}</button>}
    </div>}
  </section>;
}
