/**
 * ma-ui 部件卡（智能界面 M2 GUI 呈现层）：聊天 markdown 里 ui.render 产物链接
 * （…/agent-sessions/<sessionId>/ui/<n>-<slug>.<inline|browser>.html）的渲染层。
 * Markdown 插件把产物链接提升为独立块；工具兜底输出也共用本组件。
 * 本文件只管三种呈现：
 * - inline：muster-ext:// iframe（sandbox=allow-scripts）直接挂载，加载监督走宿主桥——
 *   v2 的 render 回执确认成功，resize 只报告自然高度；降级/错误/超时可重试。
 * - browser：标题链接卡，点击 browser.open 在网页区打开；
 * - followup（M5）：部件回填动作 → 派发 ma-ui-followup 全局事件（带卡片元素），
 *   由 ChatSurfaceView 监听并复用建议胶囊的 requestComposerInsert 填入输入框。
 * 宿主桥消息契约见 shared/uiWidgetProtocol.ts 与 main/uiRuntime/bridge.js。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { UiArtifactLinkMatch } from '../../../shared/uiArtifactLink';
import { buildExternalFileUrl } from '../../../shared/filePreview';
import { usePresence } from '../components/motion';
import { IconSliders } from '../components/icons';
import { useUiWidgetBridge } from './useUiWidgetBridge';
import { ChatLinkOwnerContext } from './chatLinkOwner';
export { UI_FOLLOWUP_EVENT, type UiFollowupDetail } from './uiWidgetEvents';

/** 自然高度：占位仅用于首帧，收到内容高度后不以窗口大小截断。 */
const DEFAULT_HEIGHT = 96;
/** 桥活体信号等待上限。懒挂载后同时建 iframe 的数量有限，10s 只兜「真死」
 *  （文件缺失/协议失败——错误页永不发 __ma 消息）；实测教训：10+ 卡并发时
 *  沙箱 iframe 各占渲染进程、生成排队，4s 会误杀排在后面的活卡 */
const LOAD_ACK_TIMEOUT_MS = 10000;
/** A live bridge gets one bounded recheck before a missing render becomes a failure. */
const LOAD_RECHECK_TIMEOUT_MS = 2000;
/** 懒挂载预载带：滚入视口前 200px 就开始建 iframe，滚动时不易露骨架 */
const LAZY_ROOT_MARGIN = '200px';

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

function clampHeight(h: number): number {
  const safe = Number.isFinite(h) ? Math.round(h) : DEFAULT_HEIGHT;
  return Math.max(safe, 1);
}

type LoadState = 'loading' | 'alive' | 'failed';

function openInBrowserPane(url: string, owner: { workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session' }): void {
  void window.api.browser.open({ url, ...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}), ...(owner.sessionId ? { sessionId: owner.sessionId } : {}), ...(owner.scope ? { scope: owner.scope } : {}) }).catch((err) => console.warn('[ma-ui] browser.open failed', err));
}

export function UiWidgetCard({
  match,
  sessionPage = false,
  presentationVisible = true,
  onSessionDraft,
  children
}: {
  match: UiArtifactLinkMatch;
  sessionPage?: boolean;
  presentationVisible?: boolean;
  onSessionDraft?: (sessionId: string, text: string) => void;
  children?: React.ReactNode;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const owner = React.useContext(ChatLinkOwnerContext);
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const ackTimerRef = React.useRef<number | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>(
    match.mode === 'browser' ? 'alive' : 'loading'
  );
  const [height, setHeight] = React.useState(DEFAULT_HEIGHT);
  const [loadAttempt, setLoadAttempt] = React.useState(0);
  const [error, setError] = React.useState('');
  const errorRef = React.useRef('');
  const widget = useUiWidgetBridge(match.path, cardRef, iframeRef, loadAttempt, sessionPage, onSessionDraft);
  const presence = usePresence(!widget.collapsed);
  const contentId = React.useId();
  const visibleRef = React.useRef(false);
  const presentationVisibleRef = React.useRef(presentationVisible);
  React.useLayoutEffect(() => {
    presentationVisibleRef.current = presentationVisible;
    if (!presentationVisible) visibleRef.current = false;
  }, [presentationVisible]);
  const statusRef = React.useRef<'mounted' | 'rendered' | 'failed' | 'degraded'>('mounted');
  const url = React.useMemo(() => buildExternalFileUrl(match.path), [match.path]);
  const file = baseName(match.path);

  // 懒挂载（实测教训：一条消息 10+ 个沙箱 iframe 各占渲染进程，全量常驻既排队误杀又浪费）：
  // 卡片滚入视口（带预载带）才创建 iframe；无 IntersectionObserver 环境（jsdom/降级）直接挂。
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    if (match.mode !== 'inline') return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const el = cardRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: LAZY_ROOT_MARGIN }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [match.mode]);

  // Loading ahead of the viewport is distinct from actually showing the result.
  React.useEffect(() => {
    const el = cardRef.current;
    if (!el || match.mode !== 'inline' || !presentationVisible) return;
    if (typeof IntersectionObserver === 'undefined') return;
    let observing = true;
    const io = new IntersectionObserver(entries => {
      if (!observing || !presentationVisibleRef.current) return;
      visibleRef.current = entries.some(entry => entry.isIntersecting);
      widget.receipt(statusRef.current, visibleRef.current, error);
    });
    io.observe(el);
    return () => { observing = false; io.disconnect(); };
  }, [match.mode, presentationVisible, widget.receipt, error]);

  React.useEffect(() => {
    if (match.mode === 'inline' && inView && (!presentationVisible || widget.loaded)) {
      widget.receipt(statusRef.current, visibleRef.current, error);
    }
  }, [widget.collapsed, widget.receipt, widget.loaded, error, match.mode, inView, presentationVisible]);

  React.useEffect(() => window.api.on('uiWidget:updated', event => {
    if (event.path.replace(/\\/g, '/').toLowerCase() !== match.path.replace(/\\/g, '/').toLowerCase()) return;
    setLoadState('loading'); setError(''); errorRef.current = ''; statusRef.current = 'mounted';
    setLoadAttempt(value => value + 1);
  }), [match.path]);

  // 宿主桥消息：resize/stats（活体信号 + 高度协商）与 followup 回填。
  // 只认自家 iframe 发出的（e.source 校验），别的部件/扩展窗口的消息不串。
  React.useEffect(() => {
    if (match.mode !== 'inline' || !inView || !widget.loaded) return;
    let bridgeSeen = false;
    const markAlive = (): void => {
      if (ackTimerRef.current != null) {
        clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
      }
      setLoadState('alive');
    };
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as Record<string, any> | null;
      if (!data || data.__ma !== true || data.v !== 2) return;
      bridgeSeen = true;
      if (widget.process(data)) return;
      // Invalid input is editable inside the same frame. Fatal script errors still use the failure card.
      if (data.recoverable === true && (data.type === 'diagnostic' || data.type === 'render' && data.status === 'degraded')) {
        markAlive(); statusRef.current = 'degraded';
        const message = typeof data.message === 'string' ? data.message.slice(0, 1000) : '';
        errorRef.current = message; setError(message); widget.receipt('degraded', visibleRef.current, message, data.diagnostics);
        return;
      }
      if (data.type === 'error' || data.status === 'failed' || data.status === 'degraded' ||
        (typeof data.stats?.degraded === 'number' && data.stats.degraded > 0)) {
        if (ackTimerRef.current != null) clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
        const message = typeof data.message === 'string' && data.message ? data.message.slice(0, 1000) : errorRef.current || '内容渲染失败';
        errorRef.current = message;
        setError(message);
        setLoadState('failed');
        statusRef.current = data.status === 'degraded' ? 'degraded' : 'failed';
        widget.receipt(statusRef.current, visibleRef.current, message);
        return;
      }
      if (data.type === 'render' && data.status === 'rendered') {
        markAlive();
        errorRef.current = ''; setError('');
        statusRef.current = 'rendered';
        widget.receipt('rendered', visibleRef.current);
        return;
      }
      if (data.type === 'resize') {
        setHeight(clampHeight(typeof data.height === 'number' ? data.height : DEFAULT_HEIGHT));
        return;
      }
    };
    window.addEventListener('message', onMessage);
    // A state/ready message proves the document is alive, but is not render success.
    // Ask the same iframe for a fresh render receipt once; no version churn/reload.
    const failTimeout = (): void => {
      errorRef.current = '内容加载超时';
      setError(errorRef.current); setLoadState('failed'); statusRef.current = 'failed';
      widget.receipt('failed', visibleRef.current, errorRef.current);
    };
    ackTimerRef.current = window.setTimeout(() => {
      if (!bridgeSeen) { failTimeout(); return; }
      iframeRef.current?.contentWindow?.postMessage({ __ma: true, type: 'probe' }, '*');
      ackTimerRef.current = window.setTimeout(failTimeout, LOAD_RECHECK_TIMEOUT_MS);
    }, LOAD_ACK_TIMEOUT_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      if (ackTimerRef.current != null) {
        clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
      }
    };
  }, [match.mode, inView, widget.loaded, loadAttempt, widget.process, widget.receipt]);

  if (match.mode === 'browser') {
    return (
      <div className="ma-ui-card is-browser" ref={cardRef}>
        <button
          type="button"
          className="ma-ui-linkcard"
          title={t('在网页区打开')}
          onClick={() => openInBrowserPane(url, owner)}
        >
          <span className="ma-ui-linkcard-glyph" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M3.5 3.5h9M3.5 8h9M3.5 12.5h5" />
            </svg>
          </span>
          <span className="ma-ui-linkcard-text">
            <span className="ma-ui-linkcard-title">{widget.title || children || file}</span>
          </span>
          <span className="ma-ui-linkcard-go" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M6 3.5h6.5V10M12.5 3.5L7 9M11 12.5H3.5V5" />
            </svg>
          </span>
        </button>
      </div>
    );
  }

  // inline：loading / alive 都直接挂 iframe（加载态由 iframe 背景骨架呈现）；
  // 未滚入视口（懒挂载）只留等高占位，不建 iframe——并发风暴与常驻浪费的根治
  return (
    <div className={`ma-ui-card is-inline${loadState === 'loading' ? ' is-loading' : ''}${loadState === 'failed' ? ' is-missing' : ''}${widget.collapsed ? ' is-collapsed' : ''}`} ref={cardRef}>
      <div className="ma-ui-toolbar chat-card-header">
        <span className="chat-card-header-icon" aria-hidden="true"><IconSliders size={18}/></span>
        {(widget.collapsed || sessionPage) && <span className="ma-ui-summary">{widget.title || children || t('交互内容')}</span>}
        <button type="button" className="ma-ui-collapse" aria-expanded={!widget.collapsed} aria-controls={contentId}
          onClick={widget.toggleCollapsed}>{t(widget.collapsed ? '展开' : '收起')}</button>
      </div>
      <div className={`acc${presence.stage === 'in' ? ' is-open' : ''}`} {...presence.spread}>
        <div className="acc-body" id={contentId} {...(widget.collapsed ? { inert: '' } : {})}
          style={{ visibility: !presence.mounted ? 'hidden' : undefined }}>
      {loadState === 'failed' ? (
        <div className="ma-ui-error">
          <span className="ma-ui-missing-text" role="status">{t('交互内容加载失败')}{error ? `：${t(error)}` : ''}</span>
          <div className="ma-ui-error-actions">
            <button type="button" onClick={() => {
              setError(''); errorRef.current = ''; setLoadState('loading'); statusRef.current = 'mounted';
              setLoadAttempt(attempt => attempt + 1);
            }}>{t('重试')}</button>
            <button type="button" onClick={() => openInBrowserPane(url, owner)}>{t('在网页区打开')}</button>
          </div>
        </div>
      ) : inView && widget.loaded ? (
        <iframe
          key={loadAttempt}
          ref={iframeRef}
          className="ma-ui-frame"
          style={{ height }}
          src={`${url}?attempt=${loadAttempt}`}
          title={file}
          sandbox="allow-scripts"
          onLoad={() => { widget.postAppearance(); widget.receipt(statusRef.current, visibleRef.current); }}
        />
      ) : (
        <div className="ma-ui-frame ma-ui-frame-holder" style={{ height }} aria-label={file} />
      )}
        </div>
      </div>
      {widget.warning && <div className="ma-ui-warning" role="status">{t('交互状态保存失败')}：{widget.warning}</div>}
    </div>
  );
}
