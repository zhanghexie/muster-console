/**
 * 手机端 L3 对话页（mobile-remote-interaction-plan）：调度 Agent 与 GUI Worker
 * 会话共用。会话流/输入框 100% 复用 ChatSurfaceView（ChatSurface 合同）——手机端
 * 的差异只允许出现在壳层（顶栏/操作菜单/转场），视图与输入条与桌面同一份代码
 * （输入框加新功能手机端自动跟进）。会话协议只存在于适配器层，本文件是壳，
 * 不直连任何会话流 IPC（test/surface-parity.mjs 护栏）。
 *
 * 调度 Agent 按 plan 只保留对话 + 清空 + 文件列表抽屉入口；派活/看板/终端不进
 * 手机端。会话里的文件链接经 ChatSurfaceView → UiStore 槽由 MobileApp 接进文件
 * 抽屉（本文件不参与链接解析）。T5.6：GUI 文本回复走邮箱存信；pty 会话仅
 * MobilePtyReply（无终端、无审批）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runtimeSurface } from '../../../../shared/types';
import type { ChatImageAttachment, SessionMeta } from '../../../../shared/types';
import { formatHelpText } from '../../../../shared/workbenchCommands';
import {
  ensureOrchestratorHistory,
  setOrchestratorFallbackWs,
  useOrchestratorSurface
} from '../../chatSurface/orchestratorSurface';
import { useAgentSessionSurface } from '../../chatSurface/agentSessionSurface';
import { ChatSurfaceView, useChatSurfaceSnapshot } from '../../chatSurface/ChatSurfaceView';
import { useRuntimesStore, useSessionStore } from '../../store';
import { MobileSheet } from '../MobileSheet';
import { MobilePtyReply } from '../MobilePtyReply';
import { sessionCapsule, type SessionCapsuleInfo } from '../sessionStatus';
import { AppLogo } from '../../components/AppLogo';
import type { MobileChatTarget } from '../nav';

export function ChatPage(props: {
  wsId: string;
  cwd?: string;
  target: MobileChatTarget;
  /** 在栈中（退场动画期间 false：冻结实况） */
  active: boolean;
  interactionActive?: boolean;
  onBack: () => void;
  /** 「⋯」菜单「文件列表」入口（MobileApp 开文件抽屉） */
  onOpenFiles: (wsId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const isDispatch = props.target.kind === 'dispatch';

  /* ── 调度表面（每工作区一桶）── */
  const dispatchSurface = useOrchestratorSurface(isDispatch ? props.wsId : null);
  useEffect(() => {
    if (isDispatch && props.active) void ensureOrchestratorHistory(props.wsId);
  }, [isDispatch, props.wsId, props.active]);
  useEffect(() => {
    if (!isDispatch) return;
    // token/thinking/tool 事件不带 workspaceId，兜底随本页工作区走（与桌面面板同款）
    setOrchestratorFallbackWs(props.wsId);
    return () => setOrchestratorFallbackWs(null);
  }, [isDispatch, props.wsId]);

  /* ── GUI 会话表面（一会话一实例）── */
  const { sessions } = useSessionStore();
  const { runtimes } = useRuntimesStore();
  const sessionId = props.target.kind === 'session' ? props.target.sessionId : null;
  const session: SessionMeta | null = useMemo(
    () => sessions.find((s) => s.id === sessionId) ?? null,
    [sessions, sessionId]
  );
  const ptyOnly = useMemo(() => {
    if (!session) return false;
    const entry = session.runtime ? runtimes.find((r) => r.id === session.runtime) : undefined;
    return runtimeSurface(entry) !== 'chat';
  }, [session, runtimes]);
  const guiSurface = useAgentSessionSurface({
    sessionId: sessionId ?? 'none',
    visible: !!sessionId && !ptyOnly,
    runtimeId: session?.runtime ?? undefined
  });

  const surface = isDispatch ? dispatchSurface : sessionId && !ptyOnly ? guiSurface : null;
  // 快照订阅与桌面 AgentFloat 同款（消息空态/忙碌胶囊）；流式期间视图本身就在逐帧渲染
  const snap = useChatSurfaceSnapshot(surface);
  const title = isDispatch ? t('调度 Agent') : (session?.name ?? t('会话'));
  const sessionCap = useMemo(() => (session ? sessionCapsule(session) : null), [session]);

  const onClear = useCallback((): void => {
    setMenuOpen(false);
    setConfirmClear(true);
  }, []);
  const doClear = useCallback((): void => {
    void surface?.actions.clear();
    setConfirmClear(false);
  }, [surface]);
  const onCopyName = useCallback((): void => {
    void navigator.clipboard?.writeText(title).catch(() => undefined);
    setMenuOpen(false);
  }, [title]);

  const onOpenFiles = useCallback((): void => {
    setMenuOpen(false);
    props.onOpenFiles(props.wsId);
  }, [props.onOpenFiles, props.wsId]);

  /* 调度命令：/stop /help 直答；/bind 等桌面能力给出指引；/status 简要态 */
  const onLocalCommand = useCallback<
    NonNullable<Parameters<typeof ChatSurfaceView>[0]['onLocalCommand']>
  >(
    (kind) => {
      if (!dispatchSurface) return;
      if (kind === 'stop') {
        dispatchSurface.actions.stop();
        return;
      }
      if (kind === 'help') {
        dispatchSurface.actions.localEcho?.(formatHelpText());
        return;
      }
      if (kind === 'bind' || kind === 'unbind') {
        dispatchSurface.actions.localEcho?.(
          t('请在已授权的 Channel 对话中使用 /bind 或 /unbind 选择远程会话。')
        );
        return;
      }
      const busyNow = dispatchSurface.getSnapshot().busy;
      dispatchSurface.actions.localEcho?.(
        t('调度 Agent：{{state}}', { state: busyNow ? t('工作中') : t('待命') })
      );
    },
    [dispatchSurface, t]
  );

  const onGuiSend = useCallback(
    async (text: string, images?: ChatImageAttachment[]) => {
      if (!sessionId) return;
      if (images?.length) return guiSurface.actions.send(text, images);
      const res = await window.api.sessions.sendMessage({ sessionId, text });
      if (!res.ok) throw new Error(res.message);
    },
    [guiSurface, sessionId]
  );

  const dispatchHeader = useMemo(() => {
    if (!dispatchSurface || snap.messages.length > 0) return null;
    return (
      <div className="empty-hint chat-welcome">
        <div className="empty-logo" aria-hidden>
          <AppLogo size={40} />
        </div>
        {t('我是调度 Agent。手机上可以直接对话；派活、看板等完整能力请在电脑端使用。')}
      </div>
    );
  }, [dispatchSurface, snap.messages.length, t]);

  const guiHeader = useMemo(() => {
    if (!guiSurface || snap.messages.length > 0) return null;
    return (
      <div className="empty-hint chat-welcome">
        <div className="empty-logo" aria-hidden>
          <AppLogo size={40} />
        </div>
        {t('我是本会话的 GUI Worker，直接发消息开始干活。')}
      </div>
    );
  }, [guiSurface, snap.messages.length, t]);

  return (
    <div className="ma-page-body ma-chat-page">
      <header className="ma-topbar">
        <button
          type="button"
          className="ma-topbar-btn"
          aria-label={t('返回')}
          onClick={props.onBack}
        >
          <span className="ma-icon-back" aria-hidden />
        </button>
        <div className="ma-topbar-title">
          <span className="ma-topbar-name">{title}</span>
          {isDispatch ? (
            <span className="ma-mini-capsule work">
              {snap.busy ? t('工作中') : t('待命')}
            </span>
          ) : sessionCap ? (
            <span className={`ma-mini-capsule ${miniCapsuleClass(sessionCap)}`}>
              {sessionCap.label}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="ma-topbar-btn"
          aria-label={t('更多操作')}
          onClick={() => setMenuOpen(true)}
        >
          <span className="ma-icon-more" aria-hidden />
        </button>
      </header>

      <div className="ma-chat-main">
        {ptyOnly && sessionId ? (
          <MobilePtyReply sessionId={sessionId} />
        ) : surface ? (
          <ChatSurfaceView
            surface={surface}
            cwd={props.cwd}
            workspaceId={props.wsId}
            live={props.active}
            interactionActive={props.interactionActive}
            header={isDispatch ? dispatchHeader : guiHeader}
            onLocalCommand={isDispatch ? onLocalCommand : undefined}
            onSend={sessionId && !isDispatch ? onGuiSend : undefined}
          />
        ) : (
          <div className="ma-empty">{t('会话不可用，请返回重试')}</div>
        )}
      </div>

      <MobileSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={title}>
        <button type="button" className="ma-sheet-item" onClick={onOpenFiles}>
          {t('文件列表')}
        </button>
        {!ptyOnly ? (
          <button type="button" className="ma-sheet-item danger" onClick={onClear}>
            {t('清空会话')}
          </button>
        ) : null}
        {!isDispatch ? (
          <button type="button" className="ma-sheet-item" onClick={onCopyName}>
            {t('复制会话名')}
          </button>
        ) : null}
      </MobileSheet>

      <MobileSheet open={confirmClear} onClose={() => setConfirmClear(false)} title={t('清空会话')}>
        <div className="ma-sheet-note">
          {t('清空后当前对话上下文将丢失（不影响 Worker 会话与文件）。确定清空？')}
        </div>
        <div className="ma-sheet-row">
          <button type="button" className="ma-sheet-btn" onClick={() => setConfirmClear(false)}>
            {t('取消')}
          </button>
          <button type="button" className="ma-sheet-btn danger" onClick={doClear}>
            {t('清空')}
          </button>
        </div>
      </MobileSheet>
    </div>
  );
}

/** 会话胶囊 kind → 顶栏迷你胶囊类（mobile.css .ma-mini-capsule*） */
function miniCapsuleClass(cap: SessionCapsuleInfo): string {
  if (cap.exited) return 'arch';
  switch (cap.kind) {
    case 'active':
      return 'work';
    case 'waiting':
      return 'needs';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return '';
  }
}
