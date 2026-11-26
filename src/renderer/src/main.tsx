// 必须第一个 import：纯浏览器打开（无 Electron preload）时先装好 window.api，
// 后续模块（i18n/theme/App）求值时才能调到（见 webApiShim.ts 头注释）
import './webApiShim';
import { createRoot } from 'react-dom/client';
import { RootLayout } from './RootLayout';
import { StoreProvider } from './store';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BootFailure } from './components/BootFailure';
import { BootReady, finishBoot } from './components/BootReady';
import { BootStatusBanner } from './components/BootStatusBanner';
import { AppTipHost } from './components/AppTip';
import { markBootDegraded, settleBoot } from './bootStatus';
import { applyTheme, getStoredTheme, initTheme } from './theme';
import { initLocale } from './i18n';
import { initUserAvatar } from './userAvatar';
import { initUiFont } from './uiFont';
import { initInteractionPreferences } from './interactionPreferences';
import { initThinkingDisplayPreference } from './thinkingDisplayPreference';
import { initWaitingTipsPreference } from './waitingTips';
import { initLongtaskDiag } from './longtaskDiag';
import { installMacChrome } from './macChrome';
import { warmMarkdownParser } from './components/MarkdownBody';
import { t } from '../../shared/i18n';
import { isBenignRendererError } from '../../shared/rendererErrorLog';
import type { BootResult } from '../../shared/boot';
import './styles.css';

window.replaySession = (...args) => import('./chatSurface/sessionReplay').then(({ replaySession }) => replaySession(...args));

if (window.demoRecording) void import('./demo/record').then(({ startRecording }) => startRecording(window.demoRecording!)).catch(error => {
  console.error('[demo]', error);
  window.alert(t('演示录制未启动：{{error}}', { error: String(error) }));
});

// macOS：红绿灯与自绘顶栏同排，chrome.css 的 .is-mac 给左上让位（Linux 用原生标题栏无需处理）
if (/Mac/i.test(navigator.platform)) {
  installMacChrome();
}

// 缓存主题先行（防闪深色），再由主进程当前主题异步校正
applyTheme(getStoredTheme());
void initTheme();
// 语言同款：缓存已在 ./i18n 模块加载时先刷，这里挂配置校正与订阅
initLocale();
initUserAvatar();
initUiFont();
initInteractionPreferences();
initThinkingDisplayPreference();
initWaitingTipsPreference();
// P1-3：>1s 长任务观测入环形缓冲（连续/累计 >2s 走 reportRendererError 落盘）
initLongtaskDiag();

// 渲染层大量调用点是 `void window.api.x()`；没有这条日志，主进程 handler 抛错
// 在这里就彻底消失了，只表现为「点了没反应」。
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledRejection]', e.reason);
  const reason = e.reason;
  const message = reason instanceof Error ? reason.message : String(reason ?? 'unhandledrejection');
  const stack = reason instanceof Error ? reason.stack : undefined;
  void window.api?.app?.reportRendererError?.({
    label: 'window.unhandledrejection',
    message,
    stack
  });
});
window.addEventListener('error', (e) => {
  // ResizeObserver 自限提示等浏览器良性事件不进「渲染层崩溃」上报（见 isBenignRendererError 注释）
  if (isBenignRendererError(e.message)) {
    console.debug('[renderer] benign browser notice suppressed:', e.message);
    return;
  }
  void window.api?.app?.reportRendererError?.({
    label: 'window.onerror',
    message: e.message || String(e.error ?? 'error'),
    stack: e.error instanceof Error ? e.error.stack : undefined
  });
});

/**
 * bootWait 兜底超时：主进程启动链卡死/过慢时也放行挂载，避免永远停在骨架。
 * X7-F01：超时不再「当成功挂载了事」——标记降级态（顶部横幅明示部分面板暂不可用），
 * 等主进程启动链真正收口（bootWait 迟到 resolve 或 app:boot:ready 事件）后
 * 重拉初始数据补齐，消灭「静默半工作台」。
 */
const BOOT_WAIT_TIMEOUT_MS = 15_000;
const BOOT_TIMED_OUT: BootResult = { ok: true };
const root = createRoot(document.getElementById('root')!);
root.render(<><AppTipHost /></>);

// 顶层 async IIFE（不阻塞模块求值）：窗口已先亮，这里等主进程后台初始化链
// （含全部 IPC 注册）完成再挂载 React，期间 index.html 的静态骨架顶住画面。
void (async () => {
  let boot: BootResult = BOOT_TIMED_OUT;
  let degraded = false;
  try {
    const bootPromise = window.api.app.bootWait();
    boot = await Promise.race([
      bootPromise,
      new Promise<BootResult>((resolve) =>
        window.setTimeout(() => resolve(BOOT_TIMED_OUT), BOOT_WAIT_TIMEOUT_MS)
      )
    ]);
    if (boot === BOOT_TIMED_OUT) degraded = true;
    // 超时后该 promise 仍会 resolve：作为就绪对账源之一（谁先到谁生效，幂等）
    void bootPromise.then(settleBoot, () => settleBoot(null));
  } catch {
    // bootWait 通道异常同样放行（按降级处理，后续错误交给 ErrorBoundary；
    // 就绪对账只剩 app:boot:ready 事件一路）
    degraded = true;
  }
  if (degraded) markBootDegraded();

  // Electron 桌面壳不用 StrictMode：它会双挂载/卸载，node-pty 配套的 xterm WebGL
  // dispose 会抛错并把整棵 React 树打白。
  // 保留根节点标记，HTML 启动遮罩由真正就绪或失败的提交移除。
  root.render(<>
    <AppTipHost />
    <div className="app-root-fade-in">
      <ErrorBoundary label={t('工作台')} onError={finishBoot}>
        {boot.ok ? (
          <StoreProvider>
            <BootStatusBanner />
            <RootLayout />
          </StoreProvider>
        ) : (
          <><BootReady /><BootFailure error={boot.error} /></>
        )}
      </ErrorBoundary>
    </div>
  </>);

  // X7-F01：web 网关的 invoke 有独立超时，长尾场景 bootWait 已 reject、
  // 只有这个事件能把降级态收口成 ready/failed（IPC_EVENT_CHANNELS 白名单内）
  try {
    window.api.on('app:boot:ready', settleBoot);
  } catch (err) {
    console.warn('[boot] app:boot:ready 订阅失败:', err);
  }

  // P2-3②：boot 完成后空闲预热 markdown 解析链（micromark/remark 首次初始化
  // 移出首帧；游离节点渲染样本，不进文档、不拉 IPC）
  const warmIdle = (cb: () => void): void => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => cb());
    } else {
      window.setTimeout(cb, 1);
    }
  };
  warmIdle(() => warmMarkdownParser());
})();
