/**
 * GUI Worker 聊天壳（Pi/Cursor）：会话流/输入框/状态条全部委托 ChatSurfaceView
 * （ChatSurface 合同，见 docs/plans/implemented/chat-surface-plan.md），本文件只剩壳级 UI——
 * 顶栏（引擎名 +「Harness 透明」开关）、批注编排（useSessionNotes）
 * 与空态欢迎语。协议适配在 agentSessionSurface，映射在 guiMessageView。
 * 轨迹页签已随账本退役（pi-trajectory-plan extension B3'）：透明标注内联在会话流里。
 */
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiActionsStore } from '../store';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import { useAgentSessionSurface } from '../chatSurface/agentSessionSurface';
import { useSessionReplay } from '../chatSurface/sessionReplay';
import { ChatSurfaceView } from '../chatSurface/ChatSurfaceView';
import { useSessionNotes } from '../chatSurface/useSessionNotes';
import { HarnessToggle } from '../chatSurface/harnessAnnotations';
import { AppLogo } from '../components/AppLogo';
import { getChatCapabilities } from '../../../shared/agentRuntimeCapabilities';

const EMPTY_HARNESS = { on: false, injections: [] as const };
export interface AgentPaneControl { on: boolean; toggle: () => void }

function AgentChatViewInner(props: {
  sessionId: string;
  visible: boolean;
  cwd?: string;
  workspaceId?: string;
  runtimeId?: string;
  runtimeLabel: string;
  /** 分屏模式下的占位矩形（相对 center-panel）；单开模式缺省走 CSS inset:0 */
  style?: React.CSSProperties;
  /** CenterPanel provides hover pane chrome; keep low-frequency controls in its menu. */
  compactHeader?: boolean;
  /** extension = 扩展面板侧栏：Composer 隐藏模式选择与权限档位。 */
  variant?: 'full' | 'extension';
  onPaneControl?: (sessionId: string, control: AgentPaneControl | null) => void;
}): React.JSX.Element {
  const { sessionId, visible, cwd, workspaceId, runtimeId, runtimeLabel } = props;
  const { t } = useTranslation();
  const store = useUiActionsStore();
  const viewRef = useRef<HTMLDivElement>(null);

  const liveSurface = useAgentSessionSurface({ sessionId, visible, runtimeId, variant: props.variant });
  const { surface, replayKey } = useSessionReplay(liveSurface);
  // 壳只关心空态边沿；正文增量与 busy/context 更新由 ChatSurfaceView 自己订阅。
  const getEmpty = useCallback(() => surface.getSnapshot().messages.length === 0, [surface]);
  const empty = useSyncExternalStore(surface.subscribe, getEmpty);

  const harnessView = useSyncExternalStore(
    surface.harness?.subscribe ?? (() => () => void 0),
    () => surface.harness?.get() ?? EMPTY_HARNESS
  );
  const harnessOn = harnessView.on;
  const canRecordRequests = getChatCapabilities(runtimeId ?? '').modelRequests === true;
  const toggleHarness = useCallback(() => surface.actions.setHarnessOn?.(!harnessOn), [surface.actions.setHarnessOn, harnessOn]);
  useEffect(() => {
    if (!props.compactHeader || !props.onPaneControl) return;
    props.onPaneControl(sessionId, { on: harnessOn, toggle: toggleHarness });
    return () => props.onPaneControl?.(sessionId, null);
  }, [props.compactHeader, props.onPaneControl, sessionId, harnessOn, toggleHarness]);

  const getMessageRole = useCallback(
    (messageId: string): 'user' | 'assistant' | undefined =>
      (surface.getSnapshot().messages as readonly GuiChatMessage[]).find((m) => m.id === messageId)?.role,
    [surface]
  );

  const notesHost = useSessionNotes({
    sessionId,
    getMessageRole,
    viewRef,
    flashTip: store.flashTip,
    requestOpenWorkspaceFile: store.requestOpenWorkspaceFile
  });

  const flashTip = store.flashTip;
  const onLocalCommand = useCallback(
    (kind: 'status' | 'statusVerbose' | 'stop' | 'help' | 'bind' | 'unbind') => {
      // /stop 已由 Composer 内部先调 onStop；其余调度命令在这里给出指引
      if (kind === 'stop') return;
      flashTip(
        t('{{cmd}} 是调度面板的命令；GUI Worker 会话直接发消息即可', {
          cmd: `/${kind === 'statusVerbose' ? 'status' : kind}`
        })
      );
    },
    [flashTip, t]
  );

  const header = useMemo(() => {
    if (empty) {
      return (
        <div className="empty-hint chat-welcome">
          <div className="empty-logo" aria-hidden>
            <AppLogo size={72} />
          </div>
          <div className="chat-welcome-copy">
          <p className="chat-welcome-title">{t('我是本会话的 GUI Worker，直接发消息开始干活。')}</p>
          <p className="hint-muted">
            {t('文件改动与命令按输入框左下角权限档位执行或弹卡确认；')}
            <kbd>/</kbd>
            {t(' 看命令，')}
            <kbd>@</kbd>
            {t(' 引用工作区文件；选中 AI 回复的文字可加批注。')}
          </p>
          </div>
        </div>
      );
    }
    return null;
  }, [empty, t]);

  return (
    <div
      className={`agent-chat-view xfade xfade-instant${visible ? ' is-shown' : ''}${harnessOn ? ' harness-on' : ''}`}
      ref={viewRef}
      data-session-id={sessionId}
      style={props.style}
    >
      {!props.compactHeader && <div className="agent-chat-topbar">
        <span className="agent-chat-runtime">{runtimeLabel}</span>
        <span className="agent-chat-spacer" />
        <HarnessToggle on={harnessOn} onChange={(on) => surface.actions.setHarnessOn?.(on)} />
      </div>}
      <ChatSurfaceView
        key={replayKey ?? 'live'}
        replayKey={replayKey}
        remindersEnabled={replayKey === undefined}
        modelRequestSessionId={canRecordRequests ? sessionId : undefined}
        surface={surface}
        cwd={cwd}
        workspaceId={workspaceId}
        header={header}
        notesHost={replayKey === undefined ? notesHost : undefined}
        harness={harnessView}
        onLocalCommand={onLocalCommand}
        findEnabled={visible}
        interactionActive={visible}
      />
    </div>
  );
}

export const AgentChatView = React.memo(AgentChatViewInner);
