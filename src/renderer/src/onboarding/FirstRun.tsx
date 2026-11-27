import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessPickerChoice } from '../../../shared/harnessPicker';
import { AppLogo } from '../components/AppLogo';
import { BrandLoading } from '../components/BrandLoader';
import { HarnessIcon } from '../components/HarnessIcon';
import { IconClose, IconSearch } from '../components/icons';
import { usePresence } from '../components/motion';
import { SetupActions, SetupNext, useSetupAction } from './SetupParts';
import { WorkspaceSetup } from './WorkspaceSetup';
import '../styles/onboarding.css';

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

export function FirstRun({ step, onAdvanceTools, onBack, onSkipModel, onOpenModelSettings, onDismiss, notice, modelReady = false }: {
  step: 'tools' | 'model';
  onAdvanceTools: (skipped: boolean) => void;
  onBack: () => void;
  onSkipModel: () => void;
  onOpenModelSettings: () => void;
  onDismiss: () => void;
  notice?: string;
  modelReady?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const noticeId = useId();
  const [closing, setClosing] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const presence = usePresence(!closing);
  const leave = (action: () => void): void => {
    if (pending.current) return;
    pending.current = action;
    setClosing(true);
  };
  useLayoutEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { if (node?.open) node.close(); };
  }, []);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step]);
  useLayoutEffect(() => {
    if (!presence.mounted && closing) {
      dialog.current?.close();
      const action = pending.current;
      pending.current = null;
      action?.();
    }
  }, [presence.mounted, closing]);
  return <dialog ref={dialog} className="setup-dialog" aria-labelledby={titleId}
    data-mp-stage={presence.stage} onCancel={event => { event.preventDefault(); leave(onDismiss); }}>
    <main className="setup-layout setup-modal-layout mp-panel" {...presence.spread}
      ref={node => { if (node) node.inert = closing; }}>
      <button type="button" className="icon-btn setup-close" aria-label={t('稍后继续')} onClick={() => leave(onDismiss)}><IconClose /></button>
      <aside className="setup-rail">
        <div className="setup-brand"><AppLogo size={36} /><span><strong>Muster</strong><small>{t('开始使用')}</small></span></div>
        <nav aria-label={t('初始化进度')}><ol>
          {[t('本机工具'), t('连接模型')].map((label, index) => <li key={label} aria-current={(step === 'tools' ? 0 : 1) === index ? 'step' : undefined}>{index + 1}. {label}</li>)}
        </ol></nav>
      </aside>
      <section className="setup-step">
        <header className="setup-step-header">
          <h1 id={titleId} ref={heading} tabIndex={-1} aria-describedby={notice ? noticeId : undefined}>{step === 'tools' ? t('检测本机 AI 工具') : t('让 Muster Core 使用你的模型')}</h1>
          <p>{step === 'tools' ? t('查找 Codex、Claude Code 等已经安装的工具。登录状态由工具管理。') : t('在模型设置中添加供应商、填写 API Key，再添加并选择默认模型。只使用本机工具时，可以跳过。')}</p>
        </header>
        {notice && <p id={noticeId} className="setup-error" role="alert">{notice}</p>}
        <div hidden={step !== 'tools'} ref={node => { if (node) node.inert = step !== 'tools'; }}>
          <ToolScan next={() => onAdvanceTools(false)} onSkip={() => onAdvanceTools(true)} />
        </div>
        {step === 'model' && <>
          <div className="setup-card setup-row"><HarnessIcon harnessId="muster-core" size={32} />
            <div className="setup-row-text"><strong>{t('模型与输入')}</strong><span>{modelReady ? t('已配置模型，可随时继续调整。') : t('选择供应商 → 填写 API Key → 添加模型 → 设为默认并保存')}</span></div>
          </div>
          <SetupActions back={onBack}>
            <button type="button" className="btn ghost" onClick={onSkipModel}>{modelReady ? t('继续') : t('稍后配置')}</button>
            <button type="button" className="btn primary" onClick={() => leave(onOpenModelSettings)}>{t('去模型设置')}</button>
          </SetupActions>
        </>}
      </section>
    </main>
  </dialog>;
}

export function WorkspaceRecovery(): React.JSX.Element {
  const { t } = useTranslation();
  return <div className="app-shell setup-shell"><div className="chrome-bar" aria-hidden="true" />
    <div className="setup-scroll"><main className="setup-layout is-recovery">
      <aside className="setup-rail"><div className="setup-brand"><AppLogo size={44} /><strong>Muster</strong></div></aside>
      <section className="setup-step"><header className="setup-step-header"><h1>{t('为会话选一个工作目录')}</h1>
        <p>{t('工作区把项目文件、会话和配置放在一起。创建后，你可以再添加其他文件夹。')}</p></header><WorkspaceSetup /></section>
    </main></div></div>;
}
