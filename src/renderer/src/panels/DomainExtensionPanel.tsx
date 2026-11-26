import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentChatView } from '../agentChat/AgentChatView';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
import { BrandLoading } from '../components/BrandLoader';
import { filePreviewUrl } from '../filePreviewUrl';
import { MUSTER_APP_SCHEME } from '../../../shared/protocolSchemes';
import { getResolvedAppearance, subscribeAppearance } from '../theme';
import { getUiFontStylesheets, subscribeUiFont } from '../uiFont';
import { getResolvedLocale, subscribeLocale } from '../../../shared/i18n';
import { ExtensionIcon } from '../extensionIcons';
import { IconClose, IconRefresh, IconSparkle } from '../components/icons';
import { AGENT_SIDEBAR_MIN, clampAgentSidebarWidth, useAgentSidebarWidth } from './extAgentSidebar';
import { CustomSelect } from '../components/CustomSelect';
import { ExtensionSurface } from '../components/ExtensionSurface';
import { isWebGateway } from '../webGatewayEnvironment';
import { getWebGatewayStatus, subscribeWebGatewayStatus } from '../webGatewayStatus';

/** AI 侧栏布局持久化：悬浮/嵌入 × 左/右 四态（旧 float/dock 两键迁移合并）。 */
const LAYOUT_STORAGE_KEY = 'ext-agent-layout-mode';
type AgentLayoutMode = 'float-left' | 'float-right' | 'dock-left' | 'dock-right';
/** 悬浮尺寸独立保存，底边由当前面板锚定；恢复旧记录时忽略 top。 */
const FLOAT_SIZE_STORAGE_KEY = 'ext-agent-float-geometry';
const FLOAT_MIN_HEIGHT = 200;
/** 未读回复胶囊的正文截断上限（取最后一条助手消息末段非空正文，超长截尾部）。 */
const UNREAD_SNIPPET_MAX = 64;
/** 后台回合正文的缓冲上限：只留尾部（摘要取末段最后 64 字符足够），防止长回合字符串无限增长。 */
const ASSISTANT_BUFFER_MAX = 2048;

type AgentLiveStatus = 'idle' | 'thinking' | 'streaming' | 'tool' | 'error';
type AgentFloatSize = { w?: number; h?: number };

const LAYOUT_MODES: readonly AgentLayoutMode[] = ['float-left', 'float-right', 'dock-left', 'dock-right'];

function initialFloatSize(): AgentFloatSize {
  try {
    const raw = JSON.parse(localStorage.getItem(FLOAT_SIZE_STORAGE_KEY) ?? '') as AgentFloatSize;
    const size: AgentFloatSize = {};
    if (typeof raw?.w === 'number' && raw.w >= AGENT_SIDEBAR_MIN) size.w = clampAgentSidebarWidth(raw.w);
    if (typeof raw?.h === 'number' && raw.h >= FLOAT_MIN_HEIGHT) size.h = Math.round(raw.h);
    return size;
  } catch {
    return {};
  }
}

function initialLayoutMode(): AgentLayoutMode {
  const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (stored && (LAYOUT_MODES as readonly string[]).includes(stored)) return stored as AgentLayoutMode;
  // 旧键迁移：float(0/1) × dock(left/right) → 四态
  const mode = (`${localStorage.getItem('ext-agent-float') === '1' ? 'float' : 'dock'}-${localStorage.getItem('ext-agent-dock') === 'left' ? 'left' : 'right'}`) as AgentLayoutMode;
  localStorage.setItem(LAYOUT_STORAGE_KEY, mode);
  return mode;
}

type DomainPanelView = {
  token: string;
  identity?: { extensionInstanceId?: string; surfaceId?: string; sourceRootId?: string };
  manifest: { name: string; icon?: string; version?: string; permissions?: string[]; theme?: { accent?: string; tokens?: Record<string, string> }; surface: { entry?: string } };
  entry: string;
  sessionId?: string;
};

function readAppearance(): { theme: Record<string, string>; colorScheme: string; fontStylesheets: string[]; revision: number; locale: string } {
  const appearance = getResolvedAppearance();
  return { theme: { ...appearance.cssVars }, colorScheme: appearance.appearance, fontStylesheets: getUiFontStylesheets(), revision: appearance.revision, locale: getResolvedLocale() };
}

function extensionFrameUrl(token: string, entry: string, revision: number): string {
  const path = entry.split('/').map(encodeURIComponent).join('/');
  const url = `${MUSTER_APP_SCHEME}://${token}/${path}`;
  return filePreviewUrl(`${url}${url.includes('?') ? '&' : '?'}__ma_reload=${revision}`);
}

/** Domain sidebar surface. The host owns the Agent Session and the shared domain. */
export function DomainExtensionPanel({ workspaceId, extensionId, scope = 'global', sourceRootId, active = true, placement: savedPlacement = 'center', onPlacement, surfaceKey, detachedWindow, onClose }: {
  workspaceId: string;
  extensionId: string;
  scope?: 'global' | 'project';
  sourceRootId?: string;
  active?: boolean;
  /** tab = 固定到右侧标签页（ExtensionSurface 搬运 iframe 保活）；window = 独立原生窗口 */
  placement?: 'center' | 'tab' | 'window';
  onPlacement?: (value: 'center' | 'tab' | 'window', onFailure?: (message: string) => void) => void;
  surfaceKey?: string;
  /** 独立扩展窗口自身（ExtensionDetachedWindow 渲染）：面板与 AI 一体，不参与摆放。 */
  detachedWindow?: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const web = isWebGateway();
  const connected = useSyncExternalStore(subscribeWebGatewayStatus, () => getWebGatewayStatus().connected);
  const placement = web && savedPlacement === 'window' ? 'center' : savedPlacement;
  const [view, setView] = useState<DomainPanelView | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; detail?: string; confirmLabel?: string; cancelLabel?: string; danger: boolean } | null>(null);
  const pendingConfirmation = useRef<((value: boolean) => void) | null>(null);
  const finishConfirmation = (value: boolean): void => { const resolve = pendingConfirmation.current; pendingConfirmation.current = null; setConfirmation(null); resolve?.(value); };
  const [error, setError] = useState('');
  const [frameRevision, setFrameRevision] = useState(0);
  const reloading = useRef<string | null>(null);
  const [agentVisible, setAgentVisible] = useState(true);
  const [layoutMode, setLayoutMode] = useState<AgentLayoutMode>(initialLayoutMode);
  const [floatSize, setFloatSize] = useState<AgentFloatSize>(initialFloatSize);
  /** 底栏状态胶囊（AI 侧栏隐藏时）：与调度气泡同源的回合状态 + 最后一条未读回复摘要 */
  const [agentLive, setAgentLive] = useState<{ text: string; status: AgentLiveStatus }>({ text: '', status: 'idle' });
  const [unreadReply, setUnreadReply] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const sidebarBox = useRef<HTMLElement | null>(null);
  const sidebar = useAgentSidebarWidth(layoutRef);
  const viewRef = useRef<DomainPanelView | null>(null);
  viewRef.current = view;
  const agentVisibleRef = useRef(agentVisible); agentVisibleRef.current = agentVisible;
  const layoutModeRef = useRef(layoutMode); layoutModeRef.current = layoutMode;
  /** 关闭侧栏期间持续累计的助手正文（新一轮换 messageId 重开），收口时截尾做未读摘要 */
  const assistantText = useRef<{ messageId: string; text: string }>({ messageId: '', text: '' });
  useEffect(() => {
    setView(null); setError(''); setAgentVisible(true);
    if (!connected) return;
    let alive = true;
    let openedToken: string | undefined;
    const closeView = (token: string): void => {
      if (getWebGatewayStatus().connected) void window.api.extensionSurface.closeExtension(token).catch(() => {});
    };
    void window.api.extensionSurface.openExtension({ workspaceId, extensionId, scope, ...(sourceRootId ? { sourceRootId } : {}) }).then(value => {
      const opened = value as unknown as DomainPanelView;
      openedToken = opened.token;
      if (alive) setView(opened);
      else closeView(opened.token);
    }).catch(value => { if (alive) setError(String(value)); });
    return () => {
      alive = false;
      if (openedToken) closeView(openedToken);
    };
  }, [workspaceId, extensionId, scope, sourceRootId, connected]);
  useLayoutEffect(() => {
    if (!view || !connected) return;
    let alive = true;
    const initialize = (target: Window | null | undefined = frame.current?.contentWindow): void => target?.postMessage({ __ma: true, type: 'init', context: { extensionId, extensionInstanceId: view.identity?.extensionInstanceId, workspaceId, surfaceId: view.identity?.surfaceId ?? 'main', sourceRootId: view.identity?.sourceRootId, permissions: view.manifest.permissions ?? [], theme: view.manifest.theme, appearance: readAppearance() } }, '*');
    const receive = (event: MessageEvent): void => {
      const source = frame.current?.contentWindow;
      const data = event.data;
      if (!source || event.source !== source || !data || data.__ma !== true) return;
      if (data.type === 'ready') {
        initialize(source);
        return;
      }
      if (data.type !== 'call' || typeof data.id !== 'string' || typeof data.method !== 'string') return;
      if (data.method === 'ui.confirm') {
        const options = data.args?.[0];
        if (!options || typeof options.title !== 'string' || !options.title.trim() || pendingConfirmation.current) {
          source.postMessage({ __ma: true, type: 'reply', id: data.id, ok: false, error: 'Invalid or concurrent confirmation' }, '*'); return;
        }
        pendingConfirmation.current = (value: boolean): void => { if (alive && frame.current?.contentWindow === source) source.postMessage({ __ma: true, type: 'reply', id: data.id, ok: true, result: value }, '*'); };
        setConfirmation({ title: options.title, detail: typeof options.detail === 'string' ? options.detail : undefined, confirmLabel: typeof options.confirmLabel === 'string' ? options.confirmLabel : undefined, cancelLabel: typeof options.cancelLabel === 'string' ? options.cancelLabel : undefined, danger: options.danger === true });
        return;
      }
      void window.api.extensionSurface.call({ token: view.token, method: data.method, args: Array.isArray(data.args) ? data.args : [] }).then(result => {
        if (!alive || frame.current?.contentWindow !== source) return;
        if (view.sessionId && data.method === 'tasks.open' && result && typeof result === 'object' && 'sidebar' in result && result.sidebar === true &&
            'sessionId' in result && result.sessionId === view.sessionId) {
          agentVisibleRef.current = true;
          setAgentVisible(true);
          setUnreadReply('');
        }
        source.postMessage({ __ma: true, type: 'reply', id: data.id, ok: true, result }, '*');
      }).catch(error => {
        if (alive && frame.current?.contentWindow === source) source.postMessage({ __ma: true, type: 'reply', id: data.id, ok: false, error: String(error) }, '*');
      });
    };
    window.addEventListener('message', receive);
    const stopEvents = window.api.on('extensionSurface:event', value => {
      if (value.token !== view.token) return;
      frame.current?.contentWindow?.postMessage({ __ma: true, type: 'event', topic: value.topic, value: value.value }, '*');
    });
    const handleLoad = (): void => initialize();
    frame.current?.addEventListener('load', handleLoad);
    initialize();
    return () => { pendingConfirmation.current?.(false); pendingConfirmation.current = null; setConfirmation(null); alive = false; window.removeEventListener('message', receive); stopEvents(); frame.current?.removeEventListener('load', handleLoad); };
  }, [view, connected, workspaceId, extensionId]);
  useEffect(() => {
    if (!view) return;
    const sync = (): void => {
      const appearance = readAppearance();
      frame.current?.contentWindow?.postMessage({ __ma: true, type: 'appearance', ...appearance }, '*');
      // 独立窗口经主进程转发 appearance；中栏/右侧的 iframe 走上面的 postMessage。
      void window.api.workbench.panelAppearance({ token: view.token, appearance }).catch(() => {});
    };
    sync();
    const stopAppearance = subscribeAppearance(sync), stopFont = subscribeUiFont(sync), stopLocale = subscribeLocale(sync);
    return () => { stopAppearance(); stopFont(); stopLocale(); };
  }, [view?.token]);
  useEffect(() => { if (view && !detachedWindow) void window.api.workbench.panelPlacement({ token: view.token, placement: placement === 'window' ? 'window' : 'center' }).catch(error => setError(String(error))); }, [view?.token, placement, detachedWindow]);
  // 关闭侧栏 = 仅隐藏；Agent 会话常驻后台继续跑，状态由底栏胶囊承载，重开直接复用同一会话
  //（整面板关闭才 closeExtension → 主进程释放 runtime 与会话）。
  const toggleAgent = useCallback((): void => {
    const nextVisible = !agentVisibleRef.current;
    agentVisibleRef.current = nextVisible;
    setAgentVisible(nextVisible);
    if (nextVisible) setUnreadReply('');
    else {
      // 隐藏后才开记后台状态；清掉可见期残留，避免陈旧胶囊
      setAgentLive({ text: '', status: 'idle' });
      assistantText.current = { messageId: '', text: '' };
    }
  }, []);
  const changeLayoutMode = useCallback((mode: AgentLayoutMode): void => {
    setLayoutMode(mode);
    localStorage.setItem(LAYOUT_STORAGE_KEY, mode);
  }, []);
  // 嵌入态布局层拖拽热区：对侧固定边起算宽度，左右停靠通用（悬浮无热区，宽度切回嵌入再拖）
  const beginDockResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const layout = layoutRef.current;
    if (!layout) return;
    const rect = layout.getBoundingClientRect();
    sidebar.startResize(event, layoutMode === 'dock-left' ? rect.left : rect.right);
  }, [sidebar, layoutMode]);
  // 悬浮卡片角部把手（调度 Agent 面板同款斜纹角标）：悬浮左=右上角、悬浮右=左上角。
  // 真对角语义：拖右上角则左下角固定、拖左上角则右下角固定——横向拖改宽（对侧竖边
  // 和底边均由 CSS 锚定），仅保存宽高。
  const beginFloatResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const box = sidebarBox.current?.getBoundingClientRect();
    const bounds = layoutRef.current?.getBoundingClientRect();
    if (!box || !bounds) return;
    const anchoredLeft = layoutModeRef.current === 'float-left';
    // 指针和卡片矩形都使用视口坐标，面板无需位于窗口顶端。
    const fixedBottom = box.bottom;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      const w = clampAgentSidebarWidth(anchoredLeft ? moveEvent.clientX - box.left : box.right - moveEvent.clientX);
      // 高度上不越过面板顶边距（8px），下保最小高度；顶边 = 固定底边 − 高度
      const maxH = Math.max(FLOAT_MIN_HEIGHT, fixedBottom - bounds.top - 8);
      const h = Math.round(Math.max(FLOAT_MIN_HEIGHT, Math.min(maxH, fixedBottom - moveEvent.clientY)));
      setFloatSize(current => (current.w === w && current.h === h ? current : { w, h }));
    };
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setFloatSize(current => {
        localStorage.setItem(FLOAT_SIZE_STORAGE_KEY, JSON.stringify(current));
        return current;
      });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }, []);
  // 关闭侧栏后 AI 在后台继续跑：订阅会话推送驱动底栏胶囊（思考中…/生成中…/执行工具…，
  // 与调度 Agent 悬浮气泡同源文案）。侧栏可见时整条短路——聊天视图自己消费推送，
  // 面板绝不能因流式 token 重渲染（这是今日卡顿的根因）；回合收口且侧栏隐藏时，
  // 把该轮最后一条助手正文的末段截尾存为未读摘要，重开侧栏即清除。
  useEffect(() => {
    const sessionId = view?.sessionId;
    if (!sessionId) return;
    const setLive = (label: string, status: AgentLiveStatus): void => setAgentLive(current => current.text === label && current.status === status ? current : { text: label, status });
    const settle = (): void => {
      setLive('', 'idle');
      if (!agentVisibleRef.current) {
        const paragraph = assistantText.current.text.split('\n').map(line => line.trim()).filter(Boolean).pop() ?? '';
        if (paragraph) setUnreadReply(paragraph.length > UNREAD_SNIPPET_MAX ? `…${paragraph.slice(-UNREAD_SNIPPET_MAX)}` : paragraph);
      }
    };
    const stop = window.api.on('agentSession:event', push => {
      if (push.sessionId !== sessionId || agentVisibleRef.current) return;
      if (push.kind === 'delta') {
        if (push.deltaKind === 'thinking') setLive(t('思考中…'), 'thinking');
        else {
          setLive(t('生成中…'), 'streaming');
          if (assistantText.current.messageId !== push.messageId) assistantText.current = { messageId: push.messageId, text: '' };
          assistantText.current.text += push.delta;
          if (assistantText.current.text.length > ASSISTANT_BUFFER_MAX) assistantText.current.text = assistantText.current.text.slice(-ASSISTANT_BUFFER_MAX / 2);
        }
      } else if (push.kind === 'part') {
        if (push.part.kind === 'tool') setLive(t('执行工具 {{name}}…', { name: String(push.part.tool.name ?? '').replace(/_/g, '.') }), 'tool');
        else if (push.part.kind === 'text') setLive(t('生成中…'), 'streaming');
      } else if (push.kind === 'busy') {
        if (push.busy) setLive(t('思考中…'), 'thinking');
        else settle();
      } else if (push.kind === 'error') {
        setLive(push.message, 'error');
      }
    });
    return stop;
  }, [view?.sessionId, t]);
  const reloadExtension = useCallback((): void => {
    const current = viewRef.current;
    if (!current || reloading.current === current.token) return;
    reloading.current = current.token;
    setError('');
    void window.api.extensionSurface.reloadExtension(current.token).then(value => {
      if (viewRef.current?.token !== current.token) return;
      const next = value as unknown as DomainPanelView;
      if (next.sessionId !== current.sessionId) {
        setAgentVisible(true);
        setAgentLive({ text: '', status: 'idle' });
        setUnreadReply('');
        assistantText.current = { messageId: '', text: '' };
      }
      setView(next);
      setFrameRevision(revision => revision + 1);
    }).catch(value => {
      if (viewRef.current?.token === current.token) setError(String(value));
    }).finally(() => {
      if (reloading.current === current.token) reloading.current = null;
    });
  }, []);
  if (error && connected) {
    return <section className="ext-panel"><div className="ui-empty" role="alert"><p>{error}</p><div className="ui-row"><button className="ui-btn" onClick={onClose}>{t('关闭面板')}</button></div></div></section>;
  }
  if (!view || !connected) return <section className="ext-panel"><p className="ui-empty" role="status"><BrandLoading>{connected ? t('正在核验扩展…') : t('等待重新连接…')}</BrandLoading></p></section>;
  const inTab = placement === 'tab' && !!surfaceKey && !detachedWindow;
  const away = placement === 'window' && !detachedWindow;
  const sidebarSessionId = agentVisible && !away ? view.sessionId : undefined;
  const sidebarShown = Boolean(sidebarSessionId);
  const floating = sidebarShown && (layoutMode === 'float-left' || layoutMode === 'float-right');
  const dockLeft = sidebarShown && !floating && layoutMode === 'dock-left';
  const docked = sidebarShown && !sidebar.narrow && !floating;
  const columns = dockLeft ? `${sidebar.width}px minmax(0, 1fr)` : `minmax(0, 1fr) ${sidebar.width}px`;
  return <>
    <AppConfirmDialog open={!!confirmation} title={confirmation?.title ?? ''} detail={confirmation?.detail} confirmLabel={confirmation?.confirmLabel} cancelLabel={confirmation?.cancelLabel} danger={confirmation?.danger} focusCancel onConfirm={() => finishConfirmation(true)} onCancel={() => finishConfirmation(false)} />
    {(inTab || away) && <section className="ext-panel ext-panel-away"><div className="ext-panel-away-content">
      <strong><ExtensionIcon value={view.manifest.icon} size={16} /> {view.manifest.name}</strong>
      <p role="status">{away ? (view.sessionId ? t('面板与 AI 已移至独立窗口。') : t('面板已移至独立窗口。')) : t('当前显示在虚拟屏右侧标签页')}</p>
      <button className="ui-btn" onClick={() => onPlacement?.('center')}>{t('一键召回')}</button>
    </div></section>}
    <ExtensionSurface surfaceKey={surfaceKey} inTab={inTab} onError={setError}><section className="ext-panel"><div className="ext-panel-body">
      <div ref={layoutRef} className={`ext-agent-layout${sidebarShown ? ' has-agent' : ''}${docked ? ' docked' : ''}${sidebar.resizing ? ' resizing' : ''}${floating ? ` ${layoutMode}` : ''}${dockLeft ? ' dock-left' : ''}`} style={docked ? { gridTemplateColumns: columns } : undefined}>
      <div className="ext-agent-main">
        <iframe key={frameRevision} ref={frame} className="ext-panel-frame" aria-label={t('扩展面板 {{name}}', { name: view.manifest.name })} sandbox="allow-scripts allow-downloads allow-forms" referrerPolicy="no-referrer" onLoad={() => frame.current?.contentWindow?.postMessage({ __ma: true, type: 'init', context: { extensionId, extensionInstanceId: view.identity?.extensionInstanceId, workspaceId, surfaceId: view.identity?.surfaceId ?? 'main', sourceRootId: view.identity?.sourceRootId, permissions: view.manifest.permissions ?? [], theme: view.manifest.theme, appearance: readAppearance() } }, '*')} src={extensionFrameUrl(view.token, view.entry, frameRevision)} style={away ? { display: 'none' } : undefined} />
      </div>
      {sidebarSessionId && <aside ref={sidebarBox} className={`ext-agent-sidebar${floating ? ' floating' : ''}`} style={floating ? { width: floatSize.w ?? sidebar.width, height: floatSize.h } : undefined}>
        <AgentChatView sessionId={sidebarSessionId} visible={active} workspaceId={workspaceId} runtimeId="pi" runtimeLabel="Pi" compactHeader variant="extension" />
        {floating && <div className={`ext-agent-resizer-corner${layoutMode === 'float-right' ? ' mirror' : ''}`} role="separator" aria-label={t('调整 AI 侧栏大小')} onPointerDown={beginFloatResize} />}
      </aside>}
      {docked && <div className={`ext-agent-resizer resize-divider${sidebar.resizing ? ' active' : ''}`} role="separator" aria-orientation="vertical" aria-label={t('调整 AI 侧栏宽度')} style={dockLeft ? { left: sidebar.width } : { right: sidebar.width }} onPointerDown={beginDockResize} />}
    </div>
  </div><footer className="ext-panel-statusbar">
    <span className="ext-panel-meta"><ExtensionIcon value={view.manifest.icon} size={14} /> {view.manifest.name}{view.manifest.version ? ` v${view.manifest.version}` : ''}</span><span className="ext-panel-meta-spacer" />
    {view.sessionId && <button className="ui-btn ghost tiny" data-testid="extension-agent-toggle" aria-pressed={agentVisible} title={agentVisible ? t('隐藏 AI 侧栏（会话继续在后台运行）') : t('打开 AI 侧栏')} aria-label={agentVisible ? t('关闭 AI') : t('打开 AI')} onClick={toggleAgent}><IconSparkle size={13} className={`ext-statusbar-icon${agentVisible ? ' on' : ''}`} /></button>}
    {sidebarShown && <CustomSelect className="ext-placement-select" ariaLabel={t('AI 侧栏布局')} value={layoutMode} onChange={value => changeLayoutMode(value as AgentLayoutMode)}
      options={[{ value: 'float-left', label: t('悬浮在左') }, { value: 'float-right', label: t('悬浮在右') }, { value: 'dock-left', label: t('嵌入在左') }, { value: 'dock-right', label: t('嵌入在右') }]} />}
    {view.sessionId && !agentVisible && !away && (agentLive.status !== 'idle' || unreadReply) && <button type="button" className="ext-agent-pill" onClick={toggleAgent} title={unreadReply || agentLive.text}>
      {agentLive.status !== 'idle' && <span className={`ext-agent-pill-dot${agentLive.status === 'error' ? ' is-error' : ''}`} aria-hidden />}
      {agentLive.status !== 'idle' && <span className="ext-agent-pill-status">{agentLive.text}</span>}
      {unreadReply && <span className="ext-agent-pill-reply">{unreadReply}</span>}
    </button>}
    <button className="ui-btn ghost tiny" title={t('重载')} aria-label={t('重载')} onClick={reloadExtension}><IconRefresh size={13} /></button>
    {onPlacement && surfaceKey && <CustomSelect className="ext-placement-select" ariaLabel={t('面板位置')} value={placement} onChange={value => onPlacement(value as 'center' | 'tab' | 'window')}
      options={[{ value: 'center', label: t('当前屏') }, { value: 'tab', label: t('右侧标签页') }, ...(web ? [] : [{ value: 'window', label: t('独立窗口') }])]} />}
    <button className="ui-btn ghost tiny" title={t('关闭面板')} aria-label={t('关闭面板')} onClick={onClose}><IconClose size={13} /></button>
  </footer></section></ExtensionSurface>
  </>;
}
