import React, { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsTabId } from '../../../shared/commandPalette';
import { IconCheck, IconClose } from '../components/icons';
import { usePresenceValue } from '../components/motion';
import { useChordLabel } from '../keybindings/KeybindingHost';
import { ResumeSetupLinks } from './ResumeSetupLinks';
import { SetupCoachmark } from './SetupCoachmark';
import type { DesktopSetup, SetupStep, WorkbenchSetupStep } from './setupProgress';

const tourSteps = ['left', 'right', 'virtual', 'board', 'theme'] as const;

export function WorkbenchSetupGuide({ setup, step, narrow, sidebarHidden, onGitPage, virtualScreenOpen, rightPanelOpen, boardOpen, onCloseBoard }: {
  setup: DesktopSetup;
  step: Exclude<WorkbenchSetupStep, 'finish'>;
  narrow: boolean;
  sidebarHidden: boolean;
  onGitPage: boolean;
  virtualScreenOpen: boolean;
  rightPanelOpen: boolean;
  boardOpen: boolean;
  onCloseBoard: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const boardShortcut = useChordLabel('globalBoard.toggle');
  const closeBoard = (): void => { if (step === 'board' && boardOpen) onCloseBoard(); };
  const move = (next: SetupStep): void => { closeBoard(); setup.move(next); };
  const position = tourSteps.findIndex(item => item === step);
  const tour = position >= 0;
  const revealTarget = onGitPage ? 'virtual-screen' : 'left-sidebar';
  const content = {
    workspace: {
      target: sidebarHidden ? revealTarget : 'workspace', title: t('在工作台创建工作区'),
      description: sidebarHidden
        ? onGitPage ? t('点击露出的工作区一侧，返回工作区。') : t('先打开左侧栏，再点击「工作区」旁的「＋」。')
        : t('点击「工作区」旁的「＋」，选一个文件夹作为工作目录。')
    },
    session: {
      target: sidebarHidden ? revealTarget : 'session', title: t('打开第一条会话'),
      description: sidebarHidden
        ? onGitPage ? t('点击露出的工作区一侧，返回会话页面。') : t('先打开左侧栏，再点击「工作会话」旁的「＋」。')
        : t('点击「＋」。你可以直接发起任务，也可以先点「新建空白」。')
    },
    left: {
      target: 'left-sidebar', title: t('开合左侧栏'),
      description: t('点击这里收起或展开左侧栏。工作区和工作会话都在这里。')
    },
    right: {
      target: 'right-sidebar', title: t('开合右侧栏'),
      description: t('点击这里打开或收起右侧工具区。文件、Git 和浏览器都在这里。')
    },
    virtual: {
      target: virtualScreenOpen ? 'virtual-screen' : 'right-sidebar', title: t('切换虚拟屏'),
      description: narrow
        ? t('宽窗口中可以体验虚拟屏。')
        : virtualScreenOpen
          ? t('点击露出的另一屏，在会话和工具之间切换。长按中间分隔条的把手，可以更改切屏方式。')
          : rightPanelOpen
            ? t('长按中间分隔条的把手，选择悬浮或点击切屏，再点击露出的另一屏。')
            : t('先打开右侧栏，再点击露出的另一屏，在会话和工具之间切换。')
    },
    board: {
      target: boardOpen ? 'global-board-views' : 'global-board', title: t('使用全局看板'),
      description: boardOpen
        ? t('「状态」按进度查看各工作区的会话，「自由」在画布上整理会话。右上角可筛选工作区或新建任务。')
        : boardShortcut
          ? t('点击顶栏的「全局看板」，也可以按鼠标中键或快捷键 {{chord}} 打开。看板汇总各工作区的代办和会话。', { chord: boardShortcut })
          : t('点击顶栏的「全局看板」，也可以按鼠标中键打开。可在「设置 → 快捷键」为看板设置快捷键。')
    },
    theme: {
      target: 'theme', title: t('设置主题'),
      description: t('打开「设置 → 外观」，选一个喜欢的主题，立刻查看效果。')
    }
  }[step];

  return <SetupCoachmark target={'[data-setup-target="' + content.target + '"]'} title={content.title}
    lockOutside allowBoardToggle={step === 'board'}
    focusTarget={step === 'board' && boardOpen ? '[aria-selected="true"]' : true}
    progress={tour ? t('工作台导览 · {{step}} / {{total}}', { step: position + 1, total: tourSteps.length }) : t('首次设置')}
    onDismiss={() => { closeBoard(); setup.onPause(); }} dismissLabel={t('稍后继续')} actions={<>
      {step === 'workspace' && <button type="button" className="btn ghost" onClick={() => move('model')}>{t('上一步')}</button>}
      {step === 'session' && <button type="button" className="btn ghost" onClick={() => move('left')}>{t('稍后创建会话')}</button>}
      {tour && <>
        {position > 0 && <button type="button" className="btn ghost" onClick={() => move(tourSteps[position - 1])}>{t('上一步')}</button>}
        <button type="button" className="btn ghost" onClick={() => move('finish')}>{t('跳过导览')}</button>
        <button type="button" className="btn primary" onClick={() => move(tourSteps[position + 1] ?? 'finish')}>{t('下一步')}</button>
      </>}
    </>}>
    <p>{content.description}</p>
  </SetupCoachmark>;
}

export function SetupCompletion({ setup, onOpenSettings, onFinish, onReleased }: {
  setup: DesktopSetup | undefined;
  onOpenSettings: (tab: SettingsTabId, focusId?: string) => void;
  onFinish: () => void;
  onReleased: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { value, presence } = usePresenceValue(setup);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const released = useRef(onReleased);
  released.current = onReleased;

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (node.open) node.close();
      released.current();
    };
  }, [presence.mounted]);

  if (!value || !presence.mounted) return null;
  const deferred = value.deferred.filter(item => !(item === 'model' && value.configuredModel));
  if (!deferred.includes('remote')) deferred.push('remote');
  return <dialog ref={dialog} className="setup-finish-dialog" aria-labelledby={headingId} {...presence.spread}
    onCancel={event => { event.preventDefault(); setup?.onPause(); }}>
    <div className="workbench-setup-guide mp-panel" {...presence.spread} ref={node => { if (node) node.inert = !setup; }}>
      <button type="button" className="modal-close workbench-setup-close" aria-label={t('稍后继续')} onClick={value.onPause}><IconClose size={16} /></button>
      <div className="setup-finish-check"><IconCheck size={28} /></div>
      <h1 id={headingId} ref={heading} tabIndex={-1}>{t('准备就绪')}</h1>
      <ul className="setup-finish-results">
        {value.hasWorkspace && <li><IconCheck size={16} />{t('已创建工作区')}</li>}
        {value.hasSession && <li><IconCheck size={16} />{t('已打开第一条会话')}</li>}
        {value.configuredModel && <li><IconCheck size={16} />{t('已配置默认模型')}</li>}
      </ul>
      <ResumeSetupLinks deferred={deferred} onOpenSettings={onOpenSettings} />
      <button type="button" className="btn primary setup-finish-button" onClick={onFinish}>{t('开始使用集序')}</button>
    </div>
  </dialog>;
}
