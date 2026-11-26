import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { uiSessionPageId } from '../../../shared/uiSessionPage';
import { isBrowserHomeUrl } from '../../../shared/browserHome';
import { bookmarkId, isBookmarkFavicon } from '../../../shared/bookmarks';
import { UiSessionPage } from '../chatSurface/UiSessionPage';
import { rightTabAppliesToSession, visibleRightTabs, type BookmarkNode, type RightTab } from '../../../shared/rightWorkspace';
import { rightToolbarHosts, useRightWorkspace } from '../rightWorkspace';
import { BrowserHome } from './BrowserHome';
import { BrowserTabList } from './BrowserTabList';
import { useTranslation } from 'react-i18next';
import { browserPanelReplaySrcPrefix, type BrowserAgentStatePayload, type BrowserTabInfo, type BrowserTabsPayload } from '../../../shared/browser';
import type { SideToolsTab } from './SideToolsSwitcher';
import { SideToolsSwitcher } from './SideToolsSwitcher';
import { setBrowserNavActive } from '../browserNav';
import { dispatchPeekPointer } from '../browserPointer';
import { useUiStore, useWorkspaceStore } from '../store';
import { runtimeSurface } from '../../../shared/types';
import { getLastFocusedDraftBucket } from './AgentComposer';
import { uiWidgetAppearance } from '../chatSurface/uiWidgetAppearance';
import { subscribeLocale, t } from '../../../shared/i18n';
import { subscribeAppearance } from '../theme';
import { subscribeUiFont } from '../uiFont';
import { parseExternalFileUrl } from '../../../shared/filePreview';
import { uiWidgetIdentity } from '../../../shared/uiWidgetProtocol';
import { NoteCardShell } from './NoteCardShell';
import { deliverWebNote } from '../agentChat/noteBridge';
import { MOTION, usePresence } from './motion';
import { IconPanelToggle, IconRefresh, IconLocate, IconGlobe, IconStar, IconCopy, IconTerminal, IconExternalLink } from './icons';

export function readableBrowserAddress(url: string): { protocol: string; host: string; path: string } {
  let readable = url;
  try { readable = decodeURI(url); } catch { /* Preserve incomplete user input verbatim. */ }
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(readable);
  return match ? { protocol: match[1]!, host: match[2]!, path: match[3]! } : { protocol: '', host: readable, path: '' };
}

/** 拾取到的网页元素（browser:picked 事件载荷） */
interface PickedElement {
  selector: string;
  tag: string;
  id: string;
  text: string;
  url: string;
  shot: string;
}

/**
 * 内置浏览器内容页：<webview> 栈每标签一个，常驻保活、仅样式切换；
 * 统一布局把地址与工具投到内容区第二行，右侧为项目收藏夹树。
 * 独立夹具仍保留旧的垂直标签栏布局。
 *
 * webview 化（2026-10-08）：网页随 DOM/虚拟屏 transform 天然移动（无逐帧 bounds
 * 上报）；浮层/弹窗直接 z-index 压过活网页（无截图让位）。懒挂载：tab 壳由主进程
 * 持有，<webview> 首次激活或收到 browser:mount-request（agent 操作后台标签）才创建。
 *
 * 露条手势：可见但不聚焦（!active）时手势覆盖层截获指针——move=驻留 dwell 切屏、
 * down=点击切页、wheel=转发主进程走 CDP 滚动网页（与旧指针管道行为对齐，但不再
 * 依赖页面注入脚本）。激活态覆盖层不命中，指针/键盘原生进 guest。
 */
export function BrowserPage({
  active,
  shown,
  workspaceActive = active,
  sideTab,
  onSideTab,
  onDropOnTab
}: {
  /** 交互激活（聚焦第二页且浏览器 tab 选中）：控制全局导航转发、手势覆盖层关闭；
   *  非激活露条态网页仍显示，指针由覆盖层接住转切屏手势 */
  active: boolean;
  /** 屏幕可见（浏览器 tab 选中且第二页 DOM 可见，不含聚焦）：控制 webview 显示。
   *  与 active 分离——VS 分屏聚焦终端侧时浏览器页仍显示网页（用户验收要求） */
  shown: boolean;
  workspaceActive?: boolean;
  sideTab: SideToolsTab;
  onSideTab: (tab: SideToolsTab) => void;
  onDropOnTab?: (tab: SideToolsTab, paths: string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const bridge = useRightWorkspace();
  const bridgeRef = useRef(bridge); bridgeRef.current = bridge;
  const knownTabs = useRef(new Set<string>());
  const ownerSync = useRef(new Map<string, string>());
  const attemptedFavicons = useRef(new Set<string>());
  const receivedInitial = useRef(false);
  const nativeActive = useRef<string | null>(null);
  const reconciledPayload = useRef<BrowserTabsPayload | null>(null);
  const snapshotBindings = useRef(new Set<string>());
  const openingWebTabs = useRef(new Map<string, Pick<RightTab, 'workspaceId' | 'sessionId' | 'scope'> & { url: string }>());
  const [openRevision, setOpenRevision] = useState(0);
  const [payload, setPayload] = useState<BrowserTabsPayload>({ tabs: [], activeId: null });
  const [nativeReady, setNativeReady] = useState(false);
  const [uiPresentation, setUiPresentation] = useState<{ sessionId: string; tabId: string } | null>(null);
  const [agent, setAgent] = useState<BrowserAgentStatePayload>({
    active: false,
    action: null,
    tabId: null
  });
  const agentPresence = usePresence(agent.active, MOTION.menuMs);
  // 退场淡出期间保留最后一个动作名，免得胶囊先变空再消失
  const lastAgentActionRef = useRef('');
  if (agent.active) lastAgentActionRef.current = agent.action ?? '';
  const agentAction = lastAgentActionRef.current;
  const [addr, setAddr] = useState('');
  /** 元素拾取态 + 备注卡（picked 元素信息独立持有，备注文字分离便于清卡） */
  const [picking, setPicking] = useState(false);
  const [noteCard, setNoteCard] = useState<PickedElement | null>(null);
  const [noteCardNote, setNoteCardNote] = useState('');
  /** 已挂载 webview 的 tab 集合（懒挂载；卸载仅发生在关 tab） */
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  /** webview preload 路径（弹窗同步桥；主进程写盘） */
  const [preloadPath, setPreloadPath] = useState('');
  const [preloadReady, setPreloadReady] = useState(false);
  const { activeWorkspaceId } = useWorkspaceStore();
  /** 插入目标 = 当前挂载的会话输入框（划词「插进输入框」同款通道，非调度专用） */
  const { requestComposerInsert, requestShowWorkspace, flashTip } = useUiStore();
  useEffect(() => window.api.on('uiWidget:present', setUiPresentation), []);
  useEffect(() => {
    if (!uiPresentation) return;
    if (!bridge) { onSideTab('browser'); requestShowWorkspace(); setUiPresentation(null); return; }
    if (!bridge.model.hydrated) return;
    if (bridge.model.sessionId !== uiPresentation.sessionId) { setUiPresentation(null); return; }
    const target = visibleRightTabs(bridge.model).find(tab => tab.content.kind === 'web' && tab.content.browserId === uiPresentation.tabId);
    if (!target) return;
    bridge.dispatch({ type: 'select', id: target.id });
    requestShowWorkspace(); setUiPresentation(null);
  }, [uiPresentation, bridge?.model, requestShowWorkspace, onSideTab]);
  useEffect(() => window.api.on('uiWidget:draft', ({ sessionId, text }) => {
    void Promise.all([window.api.sessions.list(), window.api.runtimes.list()]).then(([snapshot, runtimes]) => {
      const session = snapshot.sessions.find(item => item.id === sessionId);
      const runtime = runtimes.find(item => item.id === session?.runtime);
      if (!session || !runtime) { flashTip(t('目标会话未就绪，请稍后重试')); return; }
      const bucket = session.type === 'terminal' && session.launchKind !== 'shell' && runtimeSurface(runtime) === 'pty'
        ? `cli-session:${sessionId}` : `agent-session:${sessionId}`;
      requestComposerInsert(text, { target: bucket, replace: false });
    }).catch(error => flashTip(t('回填输入框失败：{{error}}', { error: String(error) })));
  }), [requestComposerInsert, flashTip, t]);
  const hostRef = useRef<HTMLDivElement>(null);
  const addrRef = useRef<HTMLInputElement>(null);
  const addrFocusedRef = useRef(false);
  const currentWeb = bridge?.current?.content.kind === 'web' ? bridge.current.content : undefined;
  const visibleWebTabs = bridge ? visibleRightTabs(bridge.model).filter(tab => tab.content.kind === 'web' &&
    (tab.id === bridge.current?.id || bridge.splitPanes?.has(tab.id))) : [];
  const visibleBrowserTabs = new Map(visibleWebTabs.flatMap(tab => tab.content.kind === 'web' && tab.content.browserId ? [[tab.content.browserId, tab.id]] : []));
  const currentPaneStyle = bridge?.current && bridge.splitPanes?.get(bridge.current.id);
  const controlledId = bridge ? currentWeb?.browserId ?? null : payload.activeId;
  const activeTab = payload.tabs.find((x) => x.id === controlledId) ?? null;
  useEffect(() => {
    if (!shown || !workspaceActive || !bridge?.splitPanes) return;
    return window.api.on('browser:guest-click', ({ tabId }) => {
      const latest = bridgeRef.current;
      if (!latest?.splitPanes || latest.browserTransaction?.busy) return;
      const pane = visibleRightTabs(latest.model).find(tab => latest.splitPanes?.has(tab.id) &&
        tab.content.kind === 'web' && tab.content.browserId === tabId);
      if (pane && pane.id !== latest.current?.id) latest.dispatch({ type: 'select', id: pane.id });
    });
  }, [shown, workspaceActive, !!bridge?.splitPanes]);
  const homeActive = !!activeTab && isBrowserHomeUrl(activeTab.url);
  const bookmarkNodes = bridge?.model.bookmarks[bridge.model.workspaceId];
  /** 崩溃错误态（达上限停止自动恢复）：错误卡进出场走 usePresence + mp-pop */
  const crashPresence = usePresence(!!activeTab?.crashed, MOTION.menuMs);

  useEffect(() => {
    if (!bridge || !activeTab?.favicon || !bookmarkNodes) return;
    const find = (items: BookmarkNode[]): BookmarkNode | undefined => {
      for (const item of items) {
        if (item.url === activeTab.url && !item.favicon) return item;
        const nested = item.children && find(item.children); if (nested) return nested;
      }
      return undefined;
    };
    const item = find(bookmarkNodes); if (!item) return;
    const key = `${activeTab.id}:${activeTab.url}:${activeTab.favicon}:${item.id}`;
    if (attemptedFavicons.current.has(key)) return;
    attemptedFavicons.current.add(key);
    const workspaceId = bridge.model.workspaceId;
    void window.api.browser.bookmarkFavicon({ id: activeTab.id }).then(result => {
      if (result.dataUrl && isBookmarkFavicon(result.dataUrl)) bridgeRef.current?.dispatch({ type: 'bookmarkChange', workspaceId, change: { kind: 'update', id: item.id, favicon: result.dataUrl } });
    }).catch(error => flashTip(t('站点图标保存失败：{{error}}', { error: String(error) })));
  }, [activeTab?.id, activeTab?.url, activeTab?.favicon, bookmarkNodes, bridge?.model.workspaceId, flashTip, t]);

  useEffect(() => {
    if (!shown || !currentWeb || !activeTab || bridge?.browserTransaction?.busy) return;
    if (payload.activeId !== activeTab.id) void window.api.browser.activate({ id: activeTab.id }).catch(error => flashTip(String(error)));
  }, [activeTab?.id, currentWeb?.browserId, shown, bridge?.browserTransaction?.busy]);

  useEffect(() => {
    if (!bridge || !bridge.model.hydrated.includes(bridge.model.workspaceId)) return;
    const previous = reconciledPayload.current;
    const payloadChanged = previous !== payload;
    const nativeIds = new Set(payload.tabs.map(tab => tab.id));
    const removed = [...knownTabs.current].filter(id => !nativeIds.has(id) && !bridge.browserTransaction?.manages(id));
    for (const id of removed) knownTabs.current.delete(id);
    if (removed.length) bridge.dispatch({ type: 'nativeClosed', browserIds: removed });
    const bindings = new Set<string>();
    snapshotBindings.current = bindings;
    for (const tab of payload.tabs) {
      if (bridge.model.retiredBrowserIds.includes(tab.id) || bridge.browserTransaction?.manages(tab.id, tab.panelReplayRequest)) continue;
      const parent = tab.openerId ? bridge.model.tabs.find(item => item.content.kind === 'web' && item.content.browserId === tab.openerId) : undefined;
      // The native popup may arrive in the same batch as its parent.
      if (tab.openerId && !parent && payload.tabs.some(item => item.id === tab.openerId)) continue;
      const owner = parent?.workspaceId ?? tab.workspaceId ?? bridge.model.workspaceId;
      const sessionId = parent?.sessionId ?? tab.sessionId ?? bridge.model.sessionId;
      const scope = parent?.scope ?? tab.scope;
      // Explicitly session-owned background pages must be tracked even when
      // their workspace has never been opened, so archive can release them.
      const ownerHydrated = bridge.model.hydrated.includes(owner);
      if (!ownerHydrated && !(scope === 'session' && tab.sessionId)) continue;
      const existing = bridge.model.tabs.find(item => item.content.kind === 'web' && item.content.browserId === tab.id);
      if (existing) {
        if (!payloadChanged) { knownTabs.current.add(tab.id); continue; }
        bridge.dispatch({ type: 'web', browserId: tab.id, url: tab.url, title: tab.title, historyKey: tab.panelHistoryKey,
          record: payloadChanged && tab.panelHistoryUserNavigation === true && (bridge.current?.id === existing.id || bridge.splitPanes?.has(existing.id)) && shown });
      } else if (!knownTabs.current.has(tab.id)) {
        // A snapshot can arrive before open() resolves. The reply identifies the exact new shell,
        // including when two requests target the same URL.
        if (tab.openInBackground && [...openingWebTabs.current.values()].some(request =>
          request.url === tab.url && request.workspaceId === tab.workspaceId && request.sessionId === tab.sessionId && request.scope === tab.scope)) continue;
        const pending = tab.openInBackground === undefined ? bridge.model.tabs.find(item => item.workspaceId === owner && item.content.kind === 'web' &&
          !item.content.browserId && !item.suspended && !bindings.has(item.id) && !openingWebTabs.current.has(item.id) && item.content.url === tab.url &&
          (scope === undefined || item.scope === scope) && (tab.sessionId === undefined && !parent || rightTabAppliesToSession(item, sessionId))) : undefined;
        if (pending) {
          bindings.add(pending.id);
          bridge.dispatch({ type: 'bindWeb', id: pending.id, browserId: tab.id });
        } else {
          const userOpen = receivedInitial.current && (tab.panelUserOpen ?? tab.openInBackground === false);
          bridge.dispatch({ type: 'openOwned', workspaceId: owner, sessionId, scope, content: { kind: 'web', browserId: tab.id, url: tab.url, title: tab.title },
            focus: ownerHydrated && receivedInitial.current && !tab.openInBackground, record: userOpen,
            origin: userOpen ? 'user' : 'unknown', webHistoryKey: tab.panelHistoryKey });
          if (receivedInitial.current && !tab.openInBackground && owner === bridge.model.workspaceId && (scope === 'workspace' || sessionId === bridge.model.sessionId)) requestShowWorkspace();
        }
      }
      knownTabs.current.add(tab.id);
    }
    if (receivedInitial.current && !bridge.browserTransaction?.busy && payload.activeId !== nativeActive.current && !removed.length) {
      const target = visibleRightTabs(bridge.model).find(tab => tab.content.kind === 'web' && tab.content.browserId === payload.activeId);
      if (target && target.id !== bridge.current?.id) bridge.dispatch({ type: 'select', id: target.id });
    }
    nativeActive.current = payload.activeId;
    reconciledPayload.current = payload;
    // An empty restored set is still an initialized owner. Its first subsequent open must focus.
    if (nativeReady) receivedInitial.current = true;
  }, [payload, nativeReady, openRevision, bridge?.model.hydrated, bridge?.model.tabs, bridge?.model.workspaceId, bridge?.model.sessionId, bridge?.browserTransaction?.busy, shown]);
  useEffect(() => {
    if (!bridge || !nativeReady) return;
    for (const item of bridge.model.tabs) {
      if (item.suspended || item.content.kind !== 'web' || !item.content.browserId) continue;
      const browserId = item.content.browserId;
      const tab = payload.tabs.find(value => value.id === browserId);
      if (!tab) continue;
      const { scope } = item;
      if (tab.workspaceId === item.workspaceId && tab.sessionId === item.sessionId && tab.scope === scope) {
        ownerSync.current.delete(tab.id);
        continue;
      }
      const owner = { id: tab.id, workspaceId: item.workspaceId, sessionId: item.sessionId, scope } as const;
      const key = JSON.stringify(owner);
      if (ownerSync.current.get(tab.id) === key) continue;
      ownerSync.current.set(tab.id, key);
      void window.api.browser.setOwner(owner).then(result => {
        if (!result.ok) ownerSync.current.delete(tab.id); // A concurrent close can retire the tab.
      }).catch(error => {
        ownerSync.current.delete(tab.id);
        flashTip(String(error));
      });
    }
  }, [bridge?.model.tabs, payload.tabs, nativeReady, flashTip]);
  useEffect(() => {
    if (!bridge || !shown || !nativeReady || !bridge.model.hydrated.includes(bridge.model.workspaceId) || bridge.browserTransaction?.busy) return;
    for (const tab of visibleWebTabs) {
      if (tab.content.kind !== 'web' || tab.content.browserId || snapshotBindings.current.has(tab.id) || openingWebTabs.current.has(tab.id)) continue;
      const { id, workspaceId, sessionId, scope } = tab;
      const request = { workspaceId, sessionId, scope, url: tab.content.url };
      openingWebTabs.current.set(id, request);
      void window.api.browser.open({ ...request, background: true, restoreShell: true }).then(async ({ id: browserId }) => {
        const latest = bridgeRef.current;
        if (!latest || latest.model.retiredBrowserIds.includes(browserId)) return;
        const target = latest.model.tabs.find(item => item.id === id && !item.suspended);
        if (target?.content.kind === 'web' && !target.content.browserId) {
          latest.dispatch({ type: 'bindWeb', id, browserId });
        } else {
          const result = await window.api.browser.close({ id: browserId });
          if (!result.ok) throw new Error(t('关闭标签页'));
          latest.dispatch({ type: 'nativeClosed', browserIds: [browserId] });
        }
      }).catch(error => flashTip(String(error))).finally(() => {
        openingWebTabs.current.delete(id);
        setOpenRevision(revision => revision + 1);
      });
    }
  }, [bridge?.current?.id, bridge?.model.tabs, bridge?.model.hydrated, bridge?.splitPanes, shown, nativeReady, bridge?.browserTransaction?.busy]);

  useEffect(() => {
    let live = true;
    let revision = 0;
    const offTabs = window.api.on('browser:tabs', (p) => {
      revision++;
      setPayload(p);
      setNativeReady(true);
    });
    const offAgent = window.api.on('browser:agentState', (p) => setAgent(p));
    const offPick = window.api.on('browser:picked', (info) => {
      setPicking(false);
      if (info) setNoteCard(info);
    });
    const offMount = window.api.on('browser:mount-request', (p: { tabId?: string }) => {
      const tabId = p?.tabId;
      if (typeof tabId === 'string' && tabId) setMounted((m) => new Set(m).add(tabId));
    });
    // DOM actions do not borrow the user's native focus. Reject delayed requests
    // from older main-process generations instead of selecting/revealing a page.
    const offFocus = window.api.on('browser:focus-request', (request) => {
      void window.api.browser.focusAck({ ...request, focused: false }).catch(err => flashTip(String(err)));
    });
    // owner 启动即订阅并同步标签壳，后台工具不依赖用户先打开侧工具页。
    const initialRevision = revision;
    void window.api.browser.restore().then((p) => {
      if (live && revision === initialRevision && p) setPayload(p);
      if (live) setNativeReady(true);
    }).catch((err) => flashTip(String(err)));
    return () => {
      live = false;
      offTabs();
      offAgent();
      offPick();
      offMount();
      offFocus();
    };
  }, [flashTip]);

  /** 需要挂载的 tab：已挂载 ∪ 当前激活（激活即挂载——懒挂载策略） */
  useEffect(() => {
    if (!shown) return;
    const ids = bridge ? [...visibleBrowserTabs.keys()] : controlledId ? [controlledId] : [];
    setMounted(previous => ids.every(id => previous.has(id)) ? previous : new Set([...previous, ...ids]));
  }, [controlledId, shown, bridge?.model.tabs, bridge?.splitPanes]);

  useEffect(() => {
    void window.api.browser
      .preloadPath()
      .then((r) => { setPreloadPath(r?.path ?? ''); setPreloadReady(true); })
      .catch((err) => flashTip(String(err)));
  }, []);

  /** 定向插入：目标 GUI 会话 → 网页批注通道（同款「批注N」胶囊 token + 发送展开，
   *  二次编辑=点输入框胶囊弹 WebNoteEntryHost）；无 GUI 会话目标 → 降级定向纯文本 */
  const insertToComposer = useCallback(
    (entry: { label: string; selector: string; url: string; note: string; shot: string }): boolean => {
      const bucket = getLastFocusedDraftBucket();
      const prefix = bucket?.startsWith('agent-session:') ? 'agent-session:'
        : bucket?.startsWith('cli-session:') ? 'cli-session:' : null;
      const sessionId = prefix ? bucket!.slice(prefix.length) : null;
      if (sessionId) {
        const seq = deliverWebNote(sessionId, {
          label: entry.label,
          selector: entry.selector,
          url: entry.url,
          note: entry.note,
          noteId: `web-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          ...(entry.shot ? { shot: entry.shot } : {})
        });
        return seq != null;
      }
      if (activeWorkspaceId) {
        requestComposerInsert(
          `[${t('网页备注')}] ${entry.label} (${entry.selector}) —— ${entry.note}`,
          { target: activeWorkspaceId }
        );
        return true;
      }
      return false;
    },
    [requestComposerInsert, activeWorkspaceId, t]
  );
  /** 标签栏布局：宽度/收起（初始读全局 config，变更经主进程合并落盘） */
  const [tabbarW, setTabbarW] = useState(208);
  const [tabbarCollapsed, setTabbarCollapsed] = useState(false);
  useEffect(() => {
    void window.api.config
      .get()
      .then((c) => {
        const b = c.browser;
        if (b?.tabbarWidth) setTabbarW(Math.max(140, Math.min(320, b.tabbarWidth)));
        setTabbarCollapsed(!!b?.tabbarCollapsed);
      })
      .catch(() => {});
  }, []);
  const toggleTabbar = (): void => {
    setTabbarCollapsed((v) => {
      void window.api.browser.setTabbar({ collapsed: !v }).catch((err) => flashTip(String(err)));
      return !v;
    });
  };
  /** 拖左缘把手调宽：右缘栏，向左拖加宽；结束时落盘 */
  const onTabbarResizeDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startW = tabbarW;
    let finalW = startW;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      finalW = Math.max(140, Math.min(320, Math.round(startW + (startX - ev.clientX))));
      setTabbarW(finalW);
    };
    const up = (ev: PointerEvent): void => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      void window.api.browser.setTabbar({ width: finalW }).catch((err) => flashTip(String(err)));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const togglePicking = (tabId?: string): void => {
    if (picking && (!tabId || tabId === controlledId)) {
      setPicking(false);
      void window.api.browser.cancelPick();
      return;
    }
    void (async () => {
      if (tabId && payload.activeId !== tabId) await window.api.browser.activate({ id: tabId });
      await window.api.browser.pick();
      setPicking(true);
    })().catch(error => flashTip(String(error)));
  };

  // 离开浏览器页时取消拾取，防注入残留在网页里
  useEffect(() => {
    if (!active) {
      setPicking(false);
      void window.api.browser.cancelPick();
    }
  }, [active]);

  // 工作台卸载时兜底取消拾取；切工作区保留 owner，仅按 active 状态结束拾取。
  useEffect(() => () => void window.api.browser.cancelPick(), []);

  /** 确认备注：投递目标 GUI 会话为「批注N」胶囊（发送时展开网页批注全文） */
  const confirmNote = useCallback((value = noteCardNote): void => {
    if (!noteCard) return;
    const label = noteCard.text ? `${noteCard.tag}「${noteCard.text}」` : noteCard.tag;
    const note = value.trim();
    setNoteCard(null);
    setNoteCardNote('');
    if (!note) return;
    const ok = insertToComposer({ label, selector: noteCard.selector, url: noteCard.url, note, shot: noteCard.shot });
    if (!ok) {
      flashTip(t('没有可投递的会话输入框'));
    }
  }, [noteCard, noteCardNote, insertToComposer, flashTip, t]);

  // 全局导航仅跟随交互激活，标签同步由常驻 owner 独立执行。
  useEffect(() => {
    setBrowserNavActive(active);
    return () => setBrowserNavActive(false);
  }, [active]);

  // 地址栏非聚焦时跟随当前标签 URL
  useEffect(() => {
    const u = activeTab?.url ?? '';
    if (isBrowserHomeUrl(u)) { setAddr(''); return; }
    if (addrFocusedRef.current) return;
    setAddr(u === 'about:blank' ? '' : u);
  }, [activeTab?.url]);

  const openTab = useCallback(async (url?: string): Promise<void> => {
    await window.api.browser.open({ ...(url ? { url } : { newTab: true }), workspaceId: bridgeRef.current?.model.workspaceId, sessionId: bridgeRef.current?.model.sessionId, scope: 'workspace' });
    setAddr('');
    if (url) addrRef.current?.focus();
  }, []);

  const onAddrKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || !activeTab) return;
    e.preventDefault();
    void window.api.browser.navigate({ id: activeTab.id, input: addr }).catch((err) => flashTip(String(err)));
    addrRef.current?.blur();
  };

  const navBtn = (dir: 'back' | 'forward' | 'refresh'): void => {
    if (!activeTab) return;
    void window.api.browser.nav({ id: activeTab.id, dir }).catch((err) => flashTip(String(err)));
  };

  /** 露条手势（与 git 露条热区同构：move=驻留 dwell、down=点击切屏）；滚轮转发主进程 */
  const onGestureMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      dispatchPeekPointer('move', e.currentTarget);
    },
    []
  );
  const onGestureDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      dispatchPeekPointer('down', e.currentTarget);
    },
    []
  );
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent): void => {
      const layer = (e.target as HTMLElement).closest<HTMLElement>('[data-browser-gesture-tab]');
      const tabId = layer?.dataset.browserGestureTab;
      if (!shown || workspaceActive || !layer || !tabId) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = layer.getBoundingClientRect();
      const width = layer.clientWidth || rect.width;
      const height = layer.clientHeight || rect.height;
      const x = Math.max(0, Math.min(width - 1, (e.clientX - rect.left) * (rect.width ? width / rect.width : 1)));
      const y = Math.max(0, Math.min(height - 1, (e.clientY - rect.top) * (rect.height ? height / rect.height : 1)));
      const line = Number.parseFloat(getComputedStyle(host).lineHeight) || 16;
      const factorX = e.deltaMode === 1 ? line : e.deltaMode === 2 ? width : 1;
      const factorY = e.deltaMode === 1 ? line : e.deltaMode === 2 ? height : 1;
      void window.api.browser.wheelForward({ tabId, x, y, deltaX: e.deltaX * factorX, deltaY: e.deltaY * factorY });
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [workspaceActive, shown]);

  return (
    <div className={`browser-page${active ? ' is-active' : ''}`}>
      {bridge ? payload.tabs.map(tab => {
        const hosts = rightToolbarHosts(bridge, visibleBrowserTabs.get(tab.id));
        if (!hosts) return null;
        const home = isBrowserHomeUrl(tab.url);
        const tabPicking = picking && tab.id === controlledId;
        const agentChip = (agent.tabId === tab.id || (!agent.tabId && tab.id === controlledId)) && agentPresence.mounted
          ? <span className="browser-agent-chip mp-pop" data-mp-stage={agentPresence.stage} title={agentAction}>
              <span className="browser-agent-dot"/><span className="browser-agent-text">{agentAction}</span>
            </span> : null;
        return <React.Fragment key={tab.id}>
        {hosts.location ? createPortal(<RightBrowserLocation tab={tab} agentChip={agentChip}/>, hosts.location) : null}
        {hosts.toolbar ? createPortal(<>
          <div className="right-tool-group">
            <button className="right-icon" type="button" aria-label={t('刷新')} title={t('刷新')} onClick={() => void window.api.browser.nav({ id: tab.id, dir: 'refresh' }).catch(error => flashTip(String(error)))}><IconRefresh size={14}/></button>
            <button className="right-icon" type="button" aria-label={t('收藏当前网页')} title={t('收藏当前网页')} disabled={!bookmarkNodes || home || tab.url === 'about:blank'} onClick={() => {
              const nodes = bridge.model.bookmarks[bridge.model.workspaceId] ?? [];
              const find = (list: typeof nodes): typeof nodes[number] | undefined => { for (const node of list) { if (node.url === tab.url) return node; const result = node.children && find(node.children); if (result) return result; } return undefined; };
              const existing = find(nodes);
              bridge.dispatch({ type: 'bookmarkChange', workspaceId: bridge.model.workspaceId, change: existing ? { kind: 'remove', ids: [existing.id] } : { kind: 'add', parentId: null, node: { id: bookmarkId(), label: tab.title || tab.url, url: tab.url, dateAdded: Date.now() } } });
            }}><IconStar size={14}/></button>
            <button className="right-icon" type="button" aria-label={t('复制网址')} title={t('复制网址')} disabled={home} onClick={() => void navigator.clipboard.writeText(tab.url)}><IconCopy size={14}/></button>
          </div>
          <div className="right-tool-group">
            <button className={`right-icon${tabPicking ? ' is-on' : ''}`} type="button" title={t('选择元素写备注（发给 Agent）')} aria-label={t('选择元素写备注（发给 Agent）')} disabled={home} onClick={() => togglePicking(tab.id)}><IconLocate size={14}/></button>
            <button className="right-icon" type="button" title={t('开发者工具')} aria-label={t('开发者工具')} disabled={home} onClick={() => void window.api.browser.devtools({ id: tab.id }).catch((err) => flashTip(String(err)))}><IconTerminal size={14}/></button>
            <button className="right-icon" type="button" title={t('在系统浏览器中打开')} aria-label={t('在系统浏览器中打开')} disabled={!/^https?:/i.test(tab.url)} onClick={() => void window.api.shell.openExternal(tab.url).then((r) => { if (r && !r.ok) flashTip(r.error ?? t('打开系统浏览器失败')); }).catch((err) => flashTip(String(err)))}><IconExternalLink size={14}/></button>
          </div>
        </>, hosts.toolbar) : null}
        </React.Fragment>;
      }) : null}
      {!bridge ? <>
      <div className="browser-header">        {/* 侧栏头部导航位（Files/Git 是面板历史 ‹ ›）：浏览器页语义即网页后退/前进——
            统一后退链：网页历史 ∪ 激活轨迹（新开标签可 ‹ 回上一个标签） */}
        <div className="browser-nav-btns">
          <button
            type="button"
            className="git-btn ghost tiny"
            title={t('后退')}
            disabled={!(payload.nav?.back ?? activeTab?.canGoBack)}
            onClick={() => navBtn('back')}
          >
            ‹
          </button>
          <button
            type="button"
            className="git-btn ghost tiny"
            title={t('前进')}
            disabled={!(payload.nav?.forward ?? activeTab?.canGoForward)}
            onClick={() => navBtn('forward')}
          >
            ›
          </button>
          <button
            type="button"
            className="git-btn ghost tiny"
            title={t('刷新')}
            disabled={!activeTab}
            onClick={() => navBtn('refresh')}
          >
            ↻
          </button>
        </div>
        <div className="browser-addr-wrap">
        <input
          ref={addrRef}
          className={`browser-addr${agentPresence.mounted ? ' has-agent' : ''}`}
          type="text"
          spellCheck={false}
          aria-label={t('地址栏')}
          placeholder={t('搜索或输入网址')}
          value={addr}
          disabled={!activeTab}
          onChange={(e) => setAddr(e.target.value)}
          onFocus={(e) => {
            addrFocusedRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            addrFocusedRef.current = false;
          }}
          onKeyDown={onAddrKeyDown}
        />
          {agentPresence.mounted && (
            <span
              className="browser-agent-chip mp-pop"
              data-mp-stage={agentPresence.stage}
              role="status"
              title={t('Agent 正在操作：{{action}}', { action: agentAction })}
            >
              <span className="browser-agent-dot" aria-hidden />
              <span className="browser-agent-text">
                {t('Agent 正在操作：{{action}}', { action: agentAction })}
              </span>
            </span>
          )}
        </div>
        <button
          type="button"
          className={`git-btn ghost tiny${picking ? ' is-on' : ''}`}
          title={picking ? t('取消选择元素（Esc）') : t('选择元素写备注（发给 Agent）')}
          disabled={!activeTab || homeActive}
          onClick={() => togglePicking()}
        >
          ⌖
        </button>
        <button
          type="button"
          className="git-btn ghost tiny"
          title={tabbarCollapsed ? t('展开标签栏') : t('收起标签栏')}
          onClick={toggleTabbar}
        >
          <IconPanelToggle size={13} placement="top" open={!tabbarCollapsed} />
        </button>
        <button
          type="button"
          className="git-btn ghost tiny"
          title={t('打开开发者工具')}
          disabled={!activeTab || homeActive}
          onClick={() => activeTab && void window.api.browser.devtools({ id: activeTab.id }).catch((err) => flashTip(String(err)))}
        >
          ⚙
        </button>
        <button
          type="button"
          className="git-btn ghost tiny"
          title={t('在系统浏览器中打开')}
          disabled={!activeTab || !/^https?:/i.test(activeTab.url)}
          onClick={() => activeTab && void window.api.shell.openExternal(activeTab.url).then((r) => { if (r && !r.ok) flashTip(r.error ?? t('打开系统浏览器失败')); }).catch((err) => flashTip(String(err)))}
        >
          ↗
        </button>
        <SideToolsSwitcher tab={sideTab} onSelect={onSideTab} onDropOnTab={onDropOnTab} />
      </div>
      </> : null}
      <div className="browser-main">
        <div className="browser-content">
          <div className="browser-host" ref={hostRef}>
            {payload.tabs
              .filter((tab) => preloadReady && mounted.has(tab.id))
              .map(tab => {
                const panelId = visibleBrowserTabs.get(tab.id);
                const visible = shown && (bridge ? !!panelId : tab.id === controlledId);
                const paneStyle = panelId ? bridge?.splitPanes?.get(panelId) : undefined;
                return <div className="right-browser-tab" key={tab.id} style={paneStyle}
                  data-right-split-tab={panelId} aria-hidden={!visible} {...(!visible ? { inert: '' } : {})}>
                  {isBrowserHomeUrl(tab.url) ? <BrowserHome key={tab.workspaceId ?? bridge?.model.workspaceId ?? ''} tabId={tab.id}
                    workspaceId={tab.workspaceId ?? bridge?.model.workspaceId ?? ''} sessionId={tab.sessionId ?? bridge?.model.sessionId ?? ''}
                    visible={visible} active={visible && active && tab.id === controlledId}/>
                    : uiSessionPageId(tab.url) ? <UiSessionPage sessionId={uiSessionPageId(tab.url)!} visible={visible}
                      onDraft={text => requestComposerInsert(text, { target: `cli-session:${uiSessionPageId(tab.url)!}`, replace: false })}/>
                    : <BrowserTabView tab={tab} active={visible} shown={shown} preloadPath={preloadPath}/>}
                  {visible && !workspaceActive ? <div className="browser-gesture-layer" aria-hidden data-browser-gesture-tab={tab.id}
                    onPointerMove={onGestureMove} onPointerDown={onGestureDown}/> : null}
                </div>;
              })}
            {crashPresence.mounted && activeTab && (
              <div className="browser-crash-overlay mp-pop" style={currentPaneStyle} data-mp-stage={crashPresence.stage} role="alert">
                <div className="browser-crash-card">
                  <div className="browser-crash-title">{t('页面已崩溃')}</div>
                  <div className="browser-crash-text">{t('连续多次崩溃，已停止自动恢复')}</div>
                  <button
                    type="button"
                    className="git-btn ghost"
                    onClick={() => void window.api.browser.retryCrash({ id: activeTab.id }).catch((err) => flashTip(String(err)))}
                  >
                    {t('重新加载')}
                  </button>
                </div>
              </div>
            )}
            {payload.tabs.length === 0 && (!bridge?.splitPanes || currentPaneStyle) && (
              <div className="browser-empty" style={currentPaneStyle}>
                <div className="browser-empty-text">{t('还没有打开的标签页')}</div>
                <button type="button" className="git-btn ghost" onClick={() => void openTab()}>
                  {t('新建标签页')}
                </button>
              </div>
            )}
          </div>
        </div>
        {!bridge && !tabbarCollapsed && (
          <>
            <div
              className="browser-tabbar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('调节标签栏宽度')}
              onPointerDown={onTabbarResizeDown}
            />
            <div className="browser-tabbar" style={{ width: tabbarW }}>
          <BrowserTabList
            tabs={payload.tabs}
            activeId={payload.activeId}
            onActivate={(id) => void window.api.browser.activate({ id }).catch((err) => flashTip(String(err)))}
            onCloseMany={(ids) => {
              void (async () => {
                for (const id of ids) {
                  try {
                    await window.api.browser.close({ id });
                  } catch (err) {
                    flashTip(String(err));
                  }
                }
              })();
            }}
          />
            <button
              type="button"
              className="git-btn ghost browser-tabbar-new"
              title={t('新建标签页')}
              onClick={() => void openTab()}
            >
              + {t('新建标签页')}
            </button>
            </div>
          </>
        )}
      </div>
      {noteCard &&
        createPortal(
          <BrowserNoteCard
            info={noteCard}
            note={noteCardNote}
            onNote={setNoteCardNote}
            onConfirm={confirmNote}
            onCancel={() => {
              setNoteCard(null);
              setNoteCardNote('');
            }}
          />,
          document.body
        )}
    </div>
  );
}

function RightBrowserLocation({ tab, agentChip }: { tab: BrowserTabsPayload['tabs'][number]; agentChip: React.ReactNode }) {
  const { t } = useTranslation(), { flashTip } = useUiStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const url = isBrowserHomeUrl(tab.url) || tab.url === 'about:blank' ? '' : tab.url;
  const display = readableBrowserAddress(url);
  return <div className={`right-browser-location${!editing && url ? ' has-address-display' : ''}`}>
    <IconGlobe size={14}/>
    <div className="right-browser-address-field">
      <input className="browser-addr" aria-label={t('地址栏')} placeholder={t('搜索或输入网址')} spellCheck={false} value={editing ? draft : url}
        onChange={event => setDraft(event.target.value)}
        onFocus={event => { setDraft(url); setEditing(true); event.currentTarget.select(); }}
        onBlur={() => setEditing(false)}
        onKeyDown={event => {
          if (event.key !== 'Enter') return;
          event.currentTarget.blur();
          void window.api.browser.navigate({ id: tab.id, input: draft }).catch(error => flashTip(String(error)));
        }}/>
      {!editing && url ? <span className="browser-address-display" title={url} aria-hidden>
        <span className="browser-address-scheme">{display.protocol}</span>
        <span className="browser-address-host">{display.host}</span>
        <span className="browser-address-path">{display.path}</span>
      </span> : null}
    </div>
    {agentChip}
  </div>;
}

/**
 * 单标签 webview：partition 共享登录态（主进程 browserSession 管 UA）；
 * allowpopups 使 window.open 到达主进程 setWindowOpenHandler（默认转内置新标签；
 * 带窗口特征且源于用户手势的 OAuth 弹窗放行原生窗口，见 main/browser/popupPolicy.ts）。
 * 非激活/不可见仅停放样式，保留固定非零布局，不移动 DOM 或重建 guest；
 * 停放页不接收用户输入，前台页直接使用 webview 的原生指针/键盘/IME。
 * 初始 src 固定 about:blank（React 固定值不随 tab.url 变）：立即 dom-ready 后上报
 * guestAttach，主进程 wire 完 console/网络监听再 wc.loadURL(tab.url)——webview 直接
 * src=tab.url 的自动导航会早于主进程接线，主文档请求捕不到（实测）。
 * 历史恢复用一次性 src 标记创建未导航 guest，由主进程在首次加载前绑定。
 * did-attach/dom-ready 时把 guest webContents id 报给主进程注册表（元素卸载时 detach）。
 */
function BrowserTabView({
  tab,
  active,
  shown,
  preloadPath
}: {
  tab: BrowserTabInfo;
  active: boolean;
  shown: boolean;
  preloadPath: string;
}): React.JSX.Element {
  const elRef = useRef<Electron.WebviewTag | null>(null);
  const attachedIdRef = useRef<number | null>(null);
  const attachEffectRef = useRef(0);
  const initialSrc = useRef(tab.panelRestorePending && tab.panelReplayRequest ? browserPanelReplaySrcPrefix + tab.panelReplayRequest : 'about:blank');
  const visible = active && shown;
  useEffect(() => {
    const el = elRef.current; if (!el) return;
    const appearance = (): void => { try { el.send('uiWidget:appearance', { ...uiWidgetAppearance(el), visible: active && shown, activationError: t('请点击或用键盘触发此操作') }); } catch { /* Wait for dom-ready. */ } };
    const updated = window.api.on('uiWidget:updated', event => {
      const parsed = parseExternalFileUrl(el.getURL());
      if (parsed && uiWidgetIdentity(parsed.absPath) === uiWidgetIdentity(event.path)) el.reloadIgnoringCache();
    });
    el.addEventListener('dom-ready', appearance);
    const offAppearance = subscribeAppearance(appearance), offFont = subscribeUiFont(appearance), offLocale = subscribeLocale(appearance); appearance();
    return () => { el.removeEventListener('dom-ready', appearance); offAppearance(); offFont(); offLocale(); updated(); };
  }, [active, shown]);
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const effect = ++attachEffectRef.current;
    const attach = (): void => {
      if (attachedIdRef.current != null) return;
      try {
        attachedIdRef.current = el.getWebContentsId();
      } catch {
        return;
      }
      void window.api.browser.guestAttach({ tabId: tab.id, webContentsId: attachedIdRef.current });
    };
    // 元素可能已过 did-attach（StrictMode 二挂/恢复）：能读到 id 就直接补报
    try {
      if (Number.isInteger(el.getWebContentsId())) attach();
    } catch {
      /* 尚未 attach，等 dom-ready */
    }
    // did-attach 早于页面加载（dom-ready 时内联脚本已跑完，初始 console 会漏捕获）；
    // dom-ready 兜底（如元素挂载时已过 did-attach）
    // getWebContentsId 需 dom-ready 之后才可用（did-attach 时调用必抛）；
    // 初始 src 固定 about:blank：立即 dom-ready → 上报 → 主进程 wire 完网络/console
    // 监听后 loadURL(tab.url)，保证首次导航可捕获
    el.addEventListener('dom-ready', attach);
    return () => {
      el.removeEventListener('dom-ready', attach);
      const webContentsId = attachedIdRef.current;
      // StrictMode replays effects while preserving the same connected guest.
      // Only an actual disconnected node may retire its authoritative binding.
      queueMicrotask(() => {
        if (attachEffectRef.current !== effect || el.isConnected || webContentsId == null) return;
        if (attachedIdRef.current === webContentsId) attachedIdRef.current = null;
        void window.api.browser.guestDetach({ tabId: tab.id, webContentsId });
      });
    };
  }, [tab.id]);
  return (
    <webview
      ref={elRef}
      className={`browser-webview${visible ? '' : ' is-background'}`}
      data-tab-id={tab.id}
      data-browser-presentation={visible ? 'foreground' : 'background'}
      aria-hidden={!visible}
      {...(visible ? {} : { inert: '' })}
      tabIndex={visible ? 0 : -1}
      src={initialSrc.current}
      partition="persist:browser"
      allowpopups={"true" as unknown as boolean}
      preload={preloadPath || undefined}
      style={{ visibility: visible ? 'visible' : 'hidden', ...visible ? {} : {
        position: 'fixed', inset: 'auto', left: 0, top: 0, width: 1280, height: 900,
        pointerEvents: 'none', zIndex: -1,
      } }}
    />
  );
}

/** 元素备注录入卡（壳复用 NoteCardShell，与二次编辑卡同源）：Ctrl+Enter/保存 存、Esc/点外取消；
 *  直接覆盖 live webview。二次编辑走输入框
 *  胶囊点击（WebNoteEntryHost），不经此卡 */
function BrowserNoteCard({
  info,
  note,
  onNote,
  onConfirm,
  onCancel
}: {
  info: PickedElement;
  note: string;
  onNote: (v: string) => void;
  onConfirm: (text?: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <NoteCardShell
      shot={info.shot}
      label={info.text ? `${info.tag}「${info.text}」` : info.tag}
      selector={info.selector}
      value={note}
      onValueChange={onNote}
      onConfirm={onConfirm}
      onCancel={onCancel}
      footer={t('保存即插入当前会话输入框（点胶囊可再编辑）')}
    />
  );
}
