import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessPickerChoice } from '../../../shared/harnessPicker';
import { AppLogo } from '../components/AppLogo';
import { BrandLoading } from '../components/BrandLoader';
import { HarnessIcon } from '../components/HarnessIcon';
import { IconChat, IconFolderPlus, IconPhone, IconSearch, IconSparkle, IconTerminal } from '../components/icons';
import { MOTION, usePresence } from '../components/motion';
import { ConnectModel } from './ConnectModel';
import { ConnectRemote } from './ConnectRemote';
import { ResumeSetupLinks } from './ResumeSetupLinks';
import { SetupActions, SetupNext, useSetupAction } from './SetupParts';
import { WorkspaceSetup } from './WorkspaceSetup';
import { SETUP_STEPS, type DeferredSetupStep, type MoveSetup, type SetupStep } from './setupProgress';
import '../styles/onboarding.css';

function StepPanel({ step, active, title, description, icon, children }: {
  step: SetupStep;
  active: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const presence = usePresence(active, MOTION.microMs);
  const visited = useRef(active);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  if (active) visited.current = true;
  useLayoutEffect(() => {
    if (active && presence.mounted) heading.current?.focus({ preventScroll: true });
  }, [active, presence.mounted]);

  if (!visited.current) return null;
  return <section className={`setup-step xfade${active ? ' is-shown' : ''}`} data-setup-step={step}
    hidden={!presence.mounted} aria-hidden={!active || undefined} aria-labelledby={headingId}
    ref={node => { if (node) node.inert = !active; }}>
    <header className="setup-step-header">
      <span className="setup-step-icon" aria-hidden="true">{icon}</span>
      <h1 id={headingId} ref={heading} tabIndex={-1}>{title}</h1>
      <p>{description}</p>
    </header>
    {children}
  </section>;
}

function ToolScan({ next, onSkip }: { next: () => void; onSkip: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [results, setResults] = useState<HarnessPickerChoice[] | null>(null);
  const { busy, error, run } = useSetupAction();
  const scan = (): void => void run(async () => {
    setResults(null);
    await window.api.runtimes.availability(true);
    const { choices } = await window.api.agentSession.listHarnessPickerChoices();
    setResults(choices);
  });
  const external = results?.filter(choice => choice.runtimeId !== 'pi');
  const tools = new Map<string, HarnessPickerChoice>();
  for (const choice of external ?? []) {
    if (choice.available || !tools.has(choice.harnessId)) tools.set(choice.harnessId, choice);
  }

  return <>
    <div className="setup-card setup-row">
      <HarnessIcon harnessId="muster-core" size={32} />
      <div className="setup-row-text"><strong>Muster Core</strong><span>{t('使用自己的 API Key 连接模型')}</span></div>
      <span className="setup-badge">{t('内置')}</span>
    </div>
    {busy && <p className="setup-scan-status"><BrandLoading>{t('正在检测本机 AI 工具…')}</BrandLoading></p>}
    {error && <p className="setup-error" role="alert">{error}</p>}
    {external && <div className="setup-scan-results">
      <p role="status">{tools.size ? t('发现 {{count}} 个本机工具，登录状态由工具管理。', { count: tools.size }) : t('未发现可接入的外部工具，可以使用内置 Muster Core。')}</p>
      {tools.size > 0 && <ul className="setup-tool-list">{[...tools.values()].map(tool => <li className="setup-card setup-row" key={tool.harnessId}>
        <HarnessIcon harnessId={tool.harnessId} size={24} />
        <div className="setup-row-text"><strong>{tool.label}</strong>{tool.warning && !tool.available && <span>{tool.warning}</span>}</div>
        <span className="setup-badge">{tool.available ? t('可用于会话') : t('需检查设置')}</span>
      </li>)}</ul>}
    </div>}
    <SetupActions>
      {results ? <button type="button" className="btn ghost" disabled={busy} onClick={scan}>{t('重新检测')}</button> :
        <button type="button" className="btn ghost" disabled={busy} onClick={onSkip}>{t('跳过检测')}</button>}
      {results ? <SetupNext onClick={next} /> : <button type="button" className="btn primary" onClick={scan} disabled={busy}>
        <IconSearch />{t('检测本机工具')}
      </button>}
    </SetupActions>
  </>;
}

export function FirstRun({ progress, deferred, onProgress }: {
  progress: 'tools' | 'model' | 'remote' | 'done';
  deferred: readonly DeferredSetupStep[];
  onProgress: MoveSetup;
}): React.JSX.Element {
  const { t } = useTranslation();
  const recovering = progress === 'done';
  const step: SetupStep = recovering ? 'workspace' : progress;
  const index = SETUP_STEPS.indexOf(step);
  const scroll = useRef<HTMLDivElement>(null);
  const presence = usePresence(true);
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [step]);

  const back = (): void => onProgress(SETUP_STEPS[index - 1]);
  const advance = (skipped: boolean): void => {
    if (progress !== 'done') onProgress(SETUP_STEPS[index + 1], { step: progress, skipped });
  };
  const next = (): void => advance(false);
  const skip = (): void => advance(true);
  const resume = deferred.filter(item => item !== step);
  const panels = [
    { label: t('本机工具'), title: t('检测本机 AI 工具'), description: t('查找 Codex、Claude Code 等已经安装的工具。'), Icon: IconTerminal,
      content: <ToolScan next={next} onSkip={skip} /> },
    { label: t('连接模型'), title: t('让 Muster Core 使用你的模型'), description: t('选择供应商并填入 API Key。只使用已经登录的本机工具时，可以跳过。'), Icon: IconSparkle,
      content: <ConnectModel back={back} next={next} onSkip={skip} /> },
    { label: t('远程访问'), title: t('在手机或另一台电脑上继续'), description: t('可以现在查看连接方式，也可以稍后在「设置 → 远程访问」中打开。'), Icon: IconPhone,
      content: <ConnectRemote back={back} next={next} onSkip={skip} /> },
    { label: t('工作区'), title: t('为会话选一个工作目录'), description: t('工作区把项目文件、会话和配置放在一起。创建后，你可以再添加其他文件夹。'), Icon: IconFolderPlus,
      content: <WorkspaceSetup /> }
  ];
  const navigation = [...panels, { label: t('第一条会话'), Icon: IconChat }];

  return <div className="app-shell setup-shell">
    <div className="chrome-bar" aria-hidden="true" />
    <div className="setup-scroll" ref={scroll}>
      <main className={`setup-layout mp-panel${recovering ? ' is-recovery' : ''}`} {...presence.spread}>
        <aside className="setup-rail">
          <div className="setup-brand"><AppLogo size={44} /><span><strong>Muster</strong>{!recovering && <small>{t('首次设置')}</small>}</span></div>
          {!recovering && <nav aria-label={t('初始化进度')}>
            <ol>{navigation.map(({ label, Icon }, position) => <li key={SETUP_STEPS[position]}
              aria-current={position === index ? 'step' : undefined} className={position < index ? 'is-visited' : undefined}>
              <Icon size={17} /><span>{label}</span>
            </li>)}</ol>
          </nav>}
        </aside>
        <div className="setup-step-stack xfade-stack">
          {panels.map(({ title, description, Icon, content }, position) => <StepPanel key={SETUP_STEPS[position]} step={SETUP_STEPS[position]}
            active={position === index} title={title} description={description} icon={<Icon size={24} />}>
            {!recovering && <ResumeSetupLinks deferred={resume} />}
            {content}
          </StepPanel>)}
        </div>
      </main>
    </div>
  </div>;
}
