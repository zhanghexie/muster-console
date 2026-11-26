/**
 * 手机端应用壳（mobile-remote-interaction-plan）：三级页面栈宿主。
 * - 栈导航：L1 工作区列表 → L2 工作区详情 → L3 对话页；pop 的页面进 closing
 *   队列播完退场再卸载（MobilePageFrame/presence）；栈内容持久化，数据失效截断；
 * - needs_you：顶栏计数胶囊 → 半屏列表 → 深链直达对应 L3（switch+select）；
 * - 软键盘：visualViewport 高度同步根容器（iOS Safari 的 window 不随键盘缩）；
 * - 连接状态：网页网关断线横幅（webApiShim 状态 store；桌面壳恒已连接）；
 * - toast：flashTip/调度气泡的手机侧出口（桌面是 ChromeBar 气泡）；
 * - 全局确认/扩展弹窗（ui:confirm / ui:dialog）——远程审批的手机侧价值点；
 * - 文件抽屉（MobileFiles）：「⋯」菜单入口 + 会话文件链接（UiStore openWorkspaceFile
 *   槽的手机端消费闸口，桌面归 SideToolsPanel）。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { useTranslation } from 'react-i18next';
import { t } from '../../../shared/i18n';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ExtensionUiDialogLazy } from '../components/ExtensionUiDialogLazy';
import {
  getWebGatewayStatus,
  isWebGateway,
  subscribeWebGatewayStatus
} from '../webApiShim';
import {
  useChatStore,
  useSessionStore,
  useUiStore,
  useWorkspaceStore
} from '../store';
import { jumpToSession } from '../sessionJump';
import { MobilePageFrame } from './MobilePageFrame';
import { MobileSheet } from './MobileSheet';
import { MobileTurnReview } from './MobileTurnReview';
import { MobileFiles, type MobileFileTarget } from './MobileFiles';
import { MobileToast, type MobileToastAction } from './MobileToast';
import { useSessionStatusPush } from './useSessionStatusPush';
import {
  pageKeyOf,
  persistNav,
  readPersistedNav,
  type MobileChatTarget,
  type MobilePage
} from './nav';
import { listableSession, sessionZone } from './sessionStatus';
import { useHashDeepLink } from './useHashDeepLink';
import { WorkspaceListPage } from './pages/WorkspaceListPage';
import { WorkspaceDetailPage } from './pages/WorkspaceDetailPage';
import { ChatPage } from './pages/ChatPage';

/* ---------- 页面间导航上下文（顶栏徽标/提示出口） ---------- */

interface MobileNavValue {
  back: () => void;
  tip: (text: string) => void;
  openNeedsYou: () => void;
}

const MobileNavContext = createContext<MobileNavValue | null>(null);

function useMobileNav(): MobileNavValue {
  const v = useContext(MobileNavContext);
  if (!v) throw new Error(t('useMobileNav 必须在 MobileApp 内使用'));
  return v;
}

/* ---------- 顶栏（L1/L2 共用骨架；L3 自带状态胶囊自绘） ---------- */

function MobileTopbar(props: {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <header className="ma-topbar">
      {props.onBack ? (
        <button
          type="button"
          className="ma-topbar-btn"
          aria-label={props.backLabel ?? t('返回')}
          onClick={props.onBack}
        >
          <span className="ma-icon-back" aria-hidden />
        </button>
      ) : (
        <span className="ma-topbar-spacer" aria-hidden />
      )}
      <div className="ma-topbar-title">
        <span className="ma-topbar-name">{props.title}</span>
      </div>
      {props.children}
    </header>
  );
}

/** 「需要你」计数胶囊（L1/L2 顶栏） */
function NeedsYouBadge(): React.JSX.Element | null {
  const { t } = useTranslation();
  const nav = useMobileNav();
  const { sessions } = useSessionStore();
  const count = useMemo(
    () => sessions.filter((s) => listableSession(s) && sessionZone(s) === 'needsYou').length,
    [sessions]
  );
  if (count === 0) return null;
  return (
    <button type="button" className="ma-badge needs" onClick={nav.openNeedsYou}>
      {t('需要你 {{n}}', { n: count })}
    </button>
  );
}

function ConnDot(): React.JSX.Element | null {
  const status = useSyncExternalStore(subscribeWebGatewayStatus, getWebGatewayStatus);
  if (!isWebGateway() || status.connected) return null;
  return <span className="ma-conn-dot off" aria-label={status.note} />;
}

/* ---------- 主壳 ---------- */

export function MobileApp(): React.JSX.Element {
  const { t } = useTranslation();
  const {
    confirms,
    dialogs,
    respondDialog,
    openWorkspaceFile,
    clearOpenWorkspaceFile
  } = useUiStore();
  const { workspaces, activeWorkspaceId, switchWorkspace } = useWorkspaceStore();
  const { sessions } = useSessionStore();
  const { bubblesByWs } = useChatStore();

  const [pages, setPages] = useState<MobilePage[]>(
    () => readPersistedNav() ?? [{ kind: 'workspaces' }]
  );
  /** pop 出场中的页面（播完退场由 onExited 移除） */
  const [closing, setClosing] = useState<{ key: string; page: MobilePage }[]>([]);
  const [needsOpen, setNeedsOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; nonce: number; action?: MobileToastAction } | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesReq, setFilesReq] = useState<{
    wsId: string;
    target: MobileFileTarget | null;
    nonce: number;
  } | null>(null);
  const filesNonceRef = useRef(0);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const activeWsRef = useRef(activeWorkspaceId);
  activeWsRef.current = activeWorkspaceId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const toastTimerRef = useRef<number | null>(null);

  /* toast（flashTip/调度气泡/session-status 推送的手机出口；桌面走 ChromeBar 气泡） */
  const showToast = useCallback((text: string, action?: MobileToastAction): void => {
    if (!text.trim()) return;
    setToast({ text, nonce: Date.now(), action });
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2500);
  }, []);
  const tip = useCallback((text: string): void => showToast(text), [showToast]);
  useEffect(
    () => () => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    },
    []
  );

  /* 调度气泡 → toast：只报「变化且非待命」的文案（flashTip 与 ui:bubble 同一存储） */
  const bubbleText = activeWorkspaceId ? bubblesByWs[activeWorkspaceId]?.text : undefined;
  const prevBubbleRef = useRef<string | null>(null);
  useEffect(() => {
    const first = prevBubbleRef.current === null;
    prevBubbleRef.current = bubbleText ?? null;
    if (first || !bubbleText || bubbleText === t('待命')) return;
    tip(bubbleText);
  }, [bubbleText, tip, t]);

  /* 软键盘：visualViewport 高度/偏移同步根容器（仅 iOS Safari 等不缩 window 的浏览器必要） */
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const on = (): void => setVv({ h: v.height, top: v.offsetTop });
    v.addEventListener('resize', on);
    v.addEventListener('scroll', on);
    on();
    return () => {
      v.removeEventListener('resize', on);
      v.removeEventListener('scroll', on);
    };
  }, []);

  /* 栈持久化 + 数据失效截断（工作区/会话没了→退到有效前缀） */
  useEffect(() => {
    persistNav(pages);
  }, [pages]);
  useEffect(() => {
    if (workspaces.length === 0) return; // 元数据未到位前不判定
    setPages((prev) => {
      if (prev.length === 1) return prev;
      const valid: MobilePage[] = [prev[0]!];
      const p1 = prev[1];
      if (p1?.kind === 'workspace' && workspaces.some((w) => w.id === p1.wsId)) {
        valid.push(p1);
        const p2 = prev[2];
        if (
          p2?.kind === 'chat' &&
          p2.wsId === p1.wsId &&
          (p2.target.kind === 'dispatch' ||
            sessions.some((s) => s.id === (p2.target as { sessionId: string }).sessionId))
        ) {
          valid.push(p2);
        }
      }
      if (valid.length === prev.length) return prev;
      return valid;
    });
  }, [workspaces, sessions]);

  /* ── 导航 ── */

  const back = useCallback((): void => {
    const cur = pagesRef.current;
    if (cur.length <= 1) return;
    const popped = cur[cur.length - 1]!;
    setClosing((c) => [...c, { key: pageKeyOf(popped), page: popped }]);
    setPages(cur.slice(0, -1));
  }, []);

  /* History 集成：浏览器返回（Android/iOS 边滑手势、返回键）= 弹一页。
   * 本会话每下钻一级 pushState 一条；popstate 时弹栈。刷新恢复后没有多余
   * 历史条目（histExtra=0），此时顶栏返回走本地弹栈，不会把页面本身返回掉。 */
  const histExtraRef = useRef(0);
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const onPop = (): void => {
      histExtraRef.current = Math.max(0, histExtraRef.current - 1);
      backRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const pushHist = useCallback((n: number): void => {
    for (let i = 0; i < n; i++) {
      window.history.pushState({ maNav: true }, '');
      histExtraRef.current += 1;
    }
  }, []);

  /** 顶栏返回：先消耗本会话压入的历史条目（让浏览器做转场），没有则本地弹栈 */
  const navBack = useCallback((): void => {
    if (histExtraRef.current > 0) window.history.back();
    else back();
  }, [back]);

  /** 进入 L3：切区（桌面行为对齐——会话属于它的工作区）+ 会话选中，页面即时入栈 */
  const enterChat = useCallback(
    (wsId: string, target: MobileChatTarget): void => {
      if (target.kind === 'session') {
        void jumpToSession({
          sessionId: target.sessionId,
          workspaceId: wsId,
          activeWorkspaceId: activeWsRef.current,
          switchWorkspace
        });
      } else if (activeWsRef.current !== wsId) {
        void switchWorkspace(wsId);
      }
      const cur = pagesRef.current;
      const page: MobilePage = { kind: 'chat', wsId, target };
      if (cur.length >= 3) {
        setPages([...cur.slice(0, 2), page]); // 同层替换（深链兜底路径），不加历史
      } else {
        pushHist(1);
        setPages([...cur, page]);
      }
    },
    [switchWorkspace, pushHist]
  );

  const openWorkspace = useCallback(
    (wsId: string): void => {
      const cur = pagesRef.current;
      const top = cur[cur.length - 1]!;
      if (top.kind === 'workspace' && top.wsId === wsId) return;
      if (cur.length >= 2) {
        setPages([cur[0]!, { kind: 'workspace', wsId }]);
      } else {
        pushHist(1);
        setPages([...cur, { kind: 'workspace', wsId }]);
      }
    },
    [pushHist]
  );

  /** needs_you 深链：旧栈整栈退场，直落 L3（switch + select 对齐桌面看板跳转） */
  const deepLinkSession = useCallback(
    (wsId: string, sessionId: string): void => {
      setNeedsOpen(false);
      void jumpToSession({
        sessionId,
        workspaceId: wsId,
        activeWorkspaceId: activeWsRef.current,
        switchWorkspace
      });
      const next: MobilePage[] = [
        { kind: 'workspaces' },
        { kind: 'workspace', wsId },
        { kind: 'chat', wsId, target: { kind: 'session', sessionId } }
      ];
      // 同栈等价短路（openWorkspace 有同款 top 短路）：目标栈与当前栈完全一致
      // （needs_you 抽屉点当前正在看的会话）时只补选中，不重排栈——
      // 否则旧页进 closing 的同时同 key 新页入栈，瞬间双实例闪切 + 会话数据重取。
      const cur = pagesRef.current;
      const sameStack =
        cur.length === next.length && cur.every((p, i) => pageKeyOf(p) === pageKeyOf(next[i]!));
      if (sameStack) return;
      setClosing((c) => [
        ...c,
        ...cur.slice(1).map((p) => ({ key: pageKeyOf(p), page: p }))
      ]);
      const added = Math.max(0, next.length - cur.length);
      if (added > 0) pushHist(added);
      setPages(next);
    },
    [switchWorkspace, pushHist]
  );
  const deepLinkRef = useRef(deepLinkSession);
  deepLinkRef.current = deepLinkSession;

  // 飞书卡片「打开」落在 `#/session/<id>`：会话表到位后直落 L3（与 toast「查看」同路径）。
  // 挂载即 apply（冷启动带 hash 场景）+ 会话表到位后重试，见 useHashDeepLink。
  useHashDeepLink({ sessionsRef, sessions, onHit: deepLinkSession });

  /* ── 服务端推送（T1.2）：看板翻转帧 → 前台 toast；needs_you 可点深链。
   * 会话数据的同步更新不经此路——phase 写入点先 broadcast(sessions:changed 全量)
   * 再进总线，同一 WS 上两帧先后到达，看板角标（NeedsYouBadge/L2 行胶囊）随 store
   * 自动刷新；推送帧只负责「提示 + 入口」。 */
  useSessionStatusPush({
    onPush(push) {
      // 深链复用 needs_you 先例：done/error 仅提示，不带入口
      const toDeepLink = (): void => {
        const s = sessionsRef.current.find((x) => x.id === push.sessionId);
        const wsId = s?.workspaceId;
        if (wsId) deepLinkRef.current(wsId, push.sessionId);
      };
      showToast(
        push.label,
        push.phase === 'needs_you' ? { label: t('查看'), run: toDeepLink } : undefined
      );
    },
    isViewingSession(sessionId) {
      const top = pagesRef.current[pagesRef.current.length - 1];
      return (
        !!top &&
        top.kind === 'chat' &&
        top.target.kind === 'session' &&
        top.target.sessionId === sessionId
      );
    }
  });

  const nav = useMemo<MobileNavValue>(
    () => ({ back: navBack, tip, openNeedsYou: () => setNeedsOpen(true) }),
    [navBack, tip]
  );

  /* ── 文件抽屉 ── */

  /** 打开文件抽屉：target 缺省=浏览根目录（「⋯」菜单）；带目标=直落详情（链接） */
  const openFiles = useCallback((wsId: string, target?: MobileFileTarget): void => {
    filesNonceRef.current += 1;
    setFilesReq({ wsId, target: target ?? null, nonce: filesNonceRef.current });
    setFilesOpen(true);
  }, []);

  /* 会话文件链接的手机端消费闸口：ChatSurfaceView 点链接 → UiStore openWorkspaceFile
   * 一次性槽（桌面由 SideToolsPanel 消费；手机树没有它，这里接住开文件抽屉） */
  useEffect(() => {
    if (!openWorkspaceFile) return;
    clearOpenWorkspaceFile();
    const wsId = openWorkspaceFile.fileRef?.workspaceId ?? activeWorkspaceId;
    if (!wsId) return;
    openFiles(wsId, { path: openWorkspaceFile.path, line: openWorkspaceFile.line, fileRef: openWorkspaceFile.fileRef });
  }, [openWorkspaceFile, clearOpenWorkspaceFile, activeWorkspaceId, workspaces, openFiles]);

  /* ── needs_you 列表数据 ── */
  const needsRows = useMemo(
    () =>
      sessions
        .filter((s) => listableSession(s) && sessionZone(s) === 'needsYou')
        .map((s) => ({
          s,
          wsName: workspaces.find((w) => w.id === (s.workspaceId ?? ''))?.name ?? ''
        })),
    [sessions, workspaces]
  );

  /* ── 页面渲染 ── */

  const renderPage = (page: MobilePage, api: { top: boolean; active: boolean }): React.ReactNode => {
    switch (page.kind) {
      case 'workspaces':
        return (
          <WorkspaceListPage onOpenWorkspace={openWorkspace}>
            <MobileTopbar title="Muster Console">
              <ConnDot />
              <NeedsYouBadge />
            </MobileTopbar>
          </WorkspaceListPage>
        );
      case 'workspace': {
        const ws = workspaces.find((w) => w.id === page.wsId);
        return (
          <WorkspaceDetailPage
            wsId={page.wsId}
            onBack={navBack}
            onOpenChat={enterChat}
            onTip={tip}
          >
            <MobileTopbar title={ws?.name ?? t('工作区')} onBack={navBack}>
              <NeedsYouBadge />
            </MobileTopbar>
          </WorkspaceDetailPage>
        );
      }
      case 'chat': {
        const ws = workspaces.find((w) => w.id === page.wsId);
        return (
          <ChatPage
            wsId={page.wsId}
            cwd={ws?.path}
            target={page.target}
            active={api.active}
            interactionActive={api.top && api.active}
            onBack={navBack}
            onOpenFiles={openFiles}
          />
        );
      }
    }
  };

  return (
    <MobileNavContext.Provider value={nav}>
      <div
        className="ma-root"
        style={vv ? { height: vv.h, top: vv.top } : undefined}
      >
        {pages.map((page, i) => (
          <MobilePageFrame
            key={pageKeyOf(page)}
            active
            top={i === pages.length - 1}
            onExited={() => undefined}
          >
            {renderPage(page, { top: i === pages.length - 1, active: true })}
          </MobilePageFrame>
        ))}
        {closing.map(({ key, page }) => (
          <MobilePageFrame
            key={key}
            active={false}
            top={false}
            onExited={() => setClosing((c) => c.filter((x) => x.key !== key))}
          >
            {renderPage(page, { top: false, active: false })}
          </MobilePageFrame>
        ))}

        {toast ? (
          <MobileToast key={toast.nonce} text={toast.text} action={toast.action} />
        ) : null}

        <MobileSheet
          open={needsOpen}
          onClose={() => setNeedsOpen(false)}
          title={t('需要你处理')}
        >
          {needsRows.length === 0 ? (
            <div className="ma-sheet-note">{t('当前没有需要你处理的会话')}</div>
          ) : (
            needsRows.map(({ s, wsName }) => (
              <button
                type="button"
                key={s.id}
                className="ma-sheet-item"
                onClick={() => {
                  const wsId = s.workspaceId ?? '';
                  if (!wsId) return; // 无所属区的孤儿会话：留在列表，不深链
                  deepLinkSession(wsId, s.id);
                }}
              >
                <span className="ma-ws-info">
                  <span className="ma-ws-name">{s.name}</span>
                  <span className="ma-ws-sub">{wsName}</span>
                </span>
              </button>
            ))
          )}
        </MobileSheet>

        <ConfirmDialog request={confirms[0] ?? null} />
        <ExtensionUiDialogLazy request={dialogs[0] ?? null} onRespond={respondDialog} />

        <MobileFiles
          open={filesOpen}
          onClose={() => setFilesOpen(false)}
          wsId={filesReq?.wsId ?? activeWorkspaceId ?? ''}
          workspace={
            workspaces.find((w) => w.id === (filesReq?.wsId ?? activeWorkspaceId))
          }
          target={filesReq?.target ?? null}
          nonce={filesReq?.nonce ?? 0}
          onTip={tip}
        />
        <MobileTurnReview navigationKey={pageKeyOf(pages[pages.length - 1]!)} />
      </div>
    </MobileNavContext.Provider>
  );
}
