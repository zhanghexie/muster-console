/**
 * 渲染层根分流（mobile-remote-interaction-plan）：手机表面（移动 UA / 触摸+窄视口，
 * 见 useMobileSurface）渲染 MobileApp 三级页面栈；桌面壳与桌面窄窗口维持原布局——
 * PanelHistory/Keybinding 是桌面面板体系的依赖，手机分支不挂载对方。
 *
 * 两分支各自 React.lazy：桌面树（App+xterm+面板）与手机树分 chunk——手机端
 * 不再下载桌面代码（首屏体积见 docs/features/performance.md）；
 * 懒 chunk 加载期间保留 root 外的 HTML 品牌加载标记；真实树提交后 BootReady 移除。换表面 = 刷新页面（判定在加载时锁定）。
 */
import { BootReady } from './components/BootReady';
import React, { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { useMobileSurface } from './mobile/useMobileSurface';
import { PanelHistoryProvider } from './panelHistory';
import { KeybindingProvider } from './keybindings/KeybindingHost';
import { useWorkspaceAppearance } from './useWorkspaceAppearance';
import { useSessionStore, useWorkspaceStore } from './store';
import { isWebGateway } from './webGatewayEnvironment';
import { readSetupProgress, writeSetupProgress, type MoveSetup, type SetupState } from './onboarding/setupProgress';
import { bootStatusSnapshot, subscribeBootStatus } from './bootStatus';
import { BrandBootLoader } from './components/BrandLoader';
import { showTip } from './tips';
import { t } from '../../shared/i18n';

const DesktopApp = React.lazy(() => import('./App').then((m) => ({ default: m.App })));
const FirstRun = React.lazy(() => import('./onboarding/FirstRun').then((m) => ({ default: m.FirstRun })));
const MobileApp = React.lazy(() => import('./mobile/MobileApp').then((m) => ({ default: m.MobileApp })));
const ExtensionDetachedWindow = React.lazy(() => import('./panels/ExtensionDetachedWindow').then((m) => ({ default: m.ExtensionDetachedWindow })));

/** 扩展独立窗口（加载时锁定，与表面判定同策略）：整个面板（iframe + AI 侧栏）一体。 */
const detachedExtensionWindow = window.location.hash.startsWith('#extension-window');
const noDeferredSteps = [] as const;

function persistSetup(state: SetupState): void {
  if (!writeSetupProgress(state)) showTip(t('无法保存引导进度，重启后可能需要重新进入这一步。'), { tone: 'error' });
}

function DesktopSurface(): React.JSX.Element {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const { visibleSessions } = useSessionStore();
  const boot = useSyncExternalStore(subscribeBootStatus, bootStatusSnapshot);
  const [saved, setSaved] = useState(readSetupProgress);
  const [closingWorkspace, setClosingWorkspace] = useState(false);
  const started = saved?.step ?? (workspaces.length ? 'done' : 'tools');
  const deferred = saved?.deferred ?? noDeferredSteps;
  const hasWorkspace = workspaces.some(workspace => workspace.id === activeWorkspaceId);
  const hasSession = visibleSessions.some(session => session.type === 'terminal' && !!session.runtime &&
    !session.archived && !session.hidden && session.launchKind !== 'shell');
  const progress = started === 'workspace' || started === 'session'
    ? !hasWorkspace ? 'workspace' : hasSession ? 'done' : 'session'
    : started;

  useEffect(() => {
    if (activeWorkspaceId === null || (!saved && progress !== 'done')) return;
    const remaining = hasSession ? deferred.filter(step => step !== 'session') : deferred;
    if (saved?.step === progress && remaining.length === deferred.length) return;
    const reconciled: SetupState = { ...saved, step: progress, deferred: [...remaining] };
    setSaved(reconciled);
    persistSetup(reconciled);
  }, [activeWorkspaceId, deferred, hasSession, progress, saved]);

  const move: MoveSetup = (step, outcome) => {
    const remaining = outcome ? deferred.filter(item => item !== outcome.step) : [...deferred];
    if (outcome?.skipped) remaining.push(outcome.step);
    const next = { step, deferred: remaining };
    setSaved(next);
    persistSetup(next);
  };

  if (activeWorkspaceId === null) {
    return boot.phase === 'degraded' || boot.phase === 'failed' ? <DesktopApp onWorkspaceClosePendingChange={setClosingWorkspace} /> : <BrandBootLoader />;
  }
  // The empty snapshot arrives before the renderer commits the close transaction.
  if (progress === 'workspace' || progress === 'session' ||
      (progress === 'done' && (workspaces.length > 0 || closingWorkspace))) {
    const guiding = !saved?.dismissed && (progress !== 'done' || (hasWorkspace && !hasSession && deferred.length > 0));
    return <DesktopApp onWorkspaceClosePendingChange={setClosingWorkspace} setup={guiding ? {
      step: progress,
      deferred,
      onBack: () => move('remote'),
      onSkipSession: () => move('done', { step: 'session', skipped: true }),
      onShowSession: () => move('session', { step: 'session', skipped: false }),
      onDismiss: () => {
        const remaining = [...deferred];
        if (progress === 'session' && !remaining.includes('session')) remaining.push('session');
        const next: SetupState = { step: 'done', deferred: remaining, dismissed: true };
        setSaved(next);
        persistSetup(next);
      }
    } : undefined} />;
  }

  return <FirstRun progress={progress} deferred={deferred} onProgress={move} />;
}

export function RootLayout(): React.JSX.Element {
  useWorkspaceAppearance();
  const mobile = useMobileSurface();
  // is-mobile 挂 html 根：mobile.css 的壳级覆盖（composer 紧凑化等）共用同一开关
  useEffect(() => {
    document.documentElement.classList.toggle('is-mobile', mobile);
    return () => document.documentElement.classList.remove('is-mobile');
  }, [mobile]);

  return (
    <Suspense fallback={null}>
      <BootReady />
      {detachedExtensionWindow ? (
        <ExtensionDetachedWindow />
      ) : mobile ? (
        <MobileApp />
      ) : (
        // 桌面面板体系的 Provider 壳（原挂 main.tsx，重构分流时随 App 一并移入桌面分支；
        // App 首帧即调 usePanelHistory，缺壳必抛「usePanelHistory 必须在 PanelHistoryProvider 内使用」）
        <PanelHistoryProvider>
          <KeybindingProvider>
            {isWebGateway() ? <DesktopApp /> : <DesktopSurface />}
          </KeybindingProvider>
        </PanelHistoryProvider>
      )}
    </Suspense>
  );
}
