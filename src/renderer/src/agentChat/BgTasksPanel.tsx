/**
 * 后台任务面板：与输入壳同宽的上弹浮层（portal 进 .chat-input-shell 渲染，
 * mp-pop mp-pop-up + usePresence；见 BgTasksArea 头注释）。
 * 单任务全宽详情；多任务左列表右详情。列表行可删除已完成记录，头部一键清除。
 * 三种详情：
 * - 子代理 = AgentTranscript（与主聊天同构，无输入条）；
 * - 后台终端 = TerminalView 直连 bg-* PTY（实时输出 + 可打字介入）；
 * - 定时器 = 倒计时卡。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BgTaskRecord } from '../../../shared/backgroundTasks';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import { t } from '../../../shared/i18n';
import { TerminalView } from '../components/TerminalView';
import { IconTrash } from '../components/icons';
import { ChatTranscript } from '../chatSurface/ChatTranscript';
import { guiTranscriptBinding } from '../chatSurface/guiMessageView';
import { useRuntimesStore, useSessionStore, useWorkspaceStore } from '../store';
import type { ChatAvatarContext } from '../../../shared/userAvatar';
import { bgTaskStateText } from './bgTaskStateText';

const KIND_ICON: Record<BgTaskRecord['kind'], string> = {
  subagent: '◉',
  shell: '⌘',
  timer: '⏱'
};

// ---------- 面板尺寸（右上角拖拽调整；localStorage 记忆，跨开合/重启） ----------
const BG_SIZE_KEY = 'bg-tasks-pop-size';
const BG_SIZE_MIN = { w: 380, h: 260 };

function loadSavedSize(): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(BG_SIZE_KEY);
    const v = raw ? (JSON.parse(raw) as { w: number; h: number }) : null;
    return v && v.w >= BG_SIZE_MIN.w && v.h >= BG_SIZE_MIN.h ? v : null;
  } catch {
    return null;
  }
}

let savedSize = loadSavedSize();
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function durationLabel(t: BgTaskRecord): string {
  const end = t.endedAt ?? Date.now();
  const sec = Math.max(0, Math.round((end - t.createdAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60 ? `${sec % 60}s` : ''}`;
}

/** 列表 meta：时长；已完成追加结束时刻（HH:mm） */
function metaLabel(task: BgTaskRecord): string {
  const dur = durationLabel(task);
  if (task.status === 'running' || !task.endedAt) return dur;
  const d = new Date(task.endedAt);
  return `${dur} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface TaskItemProps {
  task: BgTaskRecord;
  active: boolean;
  onSelect: () => void;
  /** 删除已完成记录（running 行不显示删除） */
  onRemove?: () => void;
}

function TaskListItem(props: TaskItemProps): React.JSX.Element {
  const { task, active } = props;
  const { t } = useTranslation();
  return (
    // 行内含删除按钮，根不能是 button（禁嵌套交互元素）；键盘经 Enter/Space 选中
    <div
      className={`bg-task-item${active ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={(e) => {
        // 行内按钮（删除）的按键不在行级拦截，否则会吃掉按钮的原生 Enter/Space 激活
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onSelect();
        }
      }}
      title={task.detail}
    >
      <span className="bg-task-item-icon" aria-hidden>
        {KIND_ICON[task.kind]}
      </span>
      <span className="bg-task-item-body">
        <span className="bg-task-item-label">{task.label}</span>
        <span className="bg-task-item-meta">{metaLabel(task)}</span>
      </span>
      {task.unread ? <span className="bg-task-item-unread" aria-label={t('有未读结果')} /> : null}
      {task.status !== 'running' && props.onRemove ? (
        <button
          type="button"
          className="bg-task-item-del"
          title={t('删除任务')}
          aria-label={t('删除任务')}
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.();
          }}
        >
          <IconTrash size={11} />
        </button>
      ) : null}
    </div>
  );
}

/** 子代理详情：与主聊天同构的消息流（无输入条） */
function SubagentDetail(props: {
  taskId: string;
  parentSessionId: string;
  messages: GuiChatMessage[];
  status: BgTaskRecord['status'];
  cwd?: string;
  workspaceId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { workspaces } = useWorkspaceStore();
  const { sessions } = useSessionStore();
  const { runtimes } = useRuntimesStore();
  const avatarContext = useMemo<ChatAvatarContext>(() => {
    const ws = props.workspaceId
      ? workspaces.find((w) => w.id === props.workspaceId)
      : undefined;
    const session = sessions.find((s) => s.id === props.parentSessionId);
    const rt = session?.runtime
      ? runtimes.find((r) => r.id === session.runtime)
      : undefined;
    return {
      surfaceKind: 'gui-session',
      workspaceAvatar: ws?.avatar,
      workspaceName: ws?.name,
      runtimeId: session?.runtime,
      runtimeLabel: rt?.label,
      sessionName: session?.name
    };
  }, [props.workspaceId, props.parentSessionId, workspaces, sessions, runtimes]);
  // ChatTranscript 合同要求 model 引用稳定（rendered memo 依赖它），勿在渲染期重建
  const binding = useMemo(() => guiTranscriptBinding(props.parentSessionId), [props.parentSessionId]);
  return (
    <ChatTranscript<GuiChatMessage>
      className="bg-task-transcript"
      model={binding}
      messages={props.messages}
      busy={props.status === 'running'}
      sessionId={props.parentSessionId}
      historyId={`bg-task:${props.taskId}`}
      cwd={props.cwd}
      workspaceId={props.workspaceId}
      avatarContext={avatarContext}
      header={
        props.messages.length === 0 ? (
          <div className="empty-hint bg-task-empty">{t('子代理已启动，正在后台执行任务…')}</div>
        ) : null
      }
    />
  );
}

/** 定时器详情：倒计时卡 */
function TimerDetail(props: { task: BgTaskRecord; onCancel: () => void }): React.JSX.Element {
  const { task } = props;
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (task.status !== 'running' || !task.wakeAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [task.status, task.wakeAt]);
  const left = task.wakeAt ? Math.max(0, task.wakeAt - now) : 0;
  const min = Math.floor(left / 60000);
  const sec = Math.floor((left % 60000) / 1000);
  return (
    <div className="bg-timer">
      <div className="bg-timer-count" aria-hidden>
        {task.status === 'running' ? `${min}:${String(sec).padStart(2, '0')}` : '—'}
      </div>
      <div className="bg-timer-reason">{task.detail}</div>
      {task.status === 'running' ? (
        <button type="button" className="bg-btn" onClick={props.onCancel}>
          {t('取消定时')}
        </button>
      ) : (
        <div className="bg-task-result">{task.summary ?? bgTaskStateText(task)}</div>
      )}
    </div>
  );
}

export function BgTasksPanel(props: {
  sessionId: string;
  tasks: BgTaskRecord[];
  messagesByTask: Record<string, GuiChatMessage[]>;
  cwd?: string;
  workspaceId?: string;
  open: boolean;
  /** usePresence 的 stage（进出场；由宿主 Area 驱动） */
  stage: 'enter' | 'in' | 'out';
  onClose: () => void;
  /** 面板根节点外露（宿主 portal 渲染时用于外点判定） */
  outerRef?: (node: HTMLDivElement | null) => void;
}): React.JSX.Element | null {
  const { sessionId, tasks, messagesByTask, open, onClose } = props;
  // 订阅语言切换：bgTaskStateText 用非响应式 shared t，切语言时靠本组件重渲生效
  useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 拖拽后的显式尺寸（null = 用 CSS 默认拉伸） */
  const [size, setSize] = useState<{ w: number; h: number } | null>(savedSize);
  const popRef = useRef<HTMLDivElement | null>(null);
  const setRoot = (node: HTMLDivElement | null): void => {
    popRef.current = node;
    props.outerRef?.(node);
  };

  // 右上角拖拽：横向拖改宽（右缘跟手）、纵向拖改高（顶缘跟手，底边锚定在输入壳上缘）
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = popRef.current;
    if (!el) return;
    e.preventDefault();
    const startW = el.offsetWidth;
    const startH = el.offsetHeight;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent): void => {
      setSize({
        w: clamp(startW + (ev.clientX - sx), BG_SIZE_MIN.w, Math.max(BG_SIZE_MIN.w + 40, window.innerWidth - 60)),
        h: clamp(startH + (sy - ev.clientY), BG_SIZE_MIN.h, Math.max(BG_SIZE_MIN.h + 40, window.innerHeight - 140))
      });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSize((s) => {
        savedSize = s;
        try {
          localStorage.setItem(BG_SIZE_KEY, JSON.stringify(s));
        } catch {
          /* ignore */
        }
        return s;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 默认选中最新任务；列表变化时尽量保持
  const effectiveId = useMemo(() => {
    if (tasks.some((t) => t.id === activeId)) return activeId;
    return tasks[0]?.id ?? null;
  }, [tasks, activeId]);
  const active = tasks.find((t) => t.id === effectiveId) ?? null;

  const kill = (taskId: string): void => {
    void window.api.bgTasks.kill(taskId);
  };

  return (
    <div
      className="bg-tasks-pop mp-pop mp-pop-up"
      role="dialog"
      aria-label={t('后台任务')}
      data-mp-stage={props.stage}
      ref={setRoot}
      style={size ? { width: size.w, height: size.h } : undefined}
    >
      <div className="bg-tasks-head">
        <span className="bg-tasks-title">{t('后台任务')}</span>
        <span className="bg-tasks-spacer" />
        {tasks.some((task) => task.status !== 'running') ? (
          <button
            type="button"
            className="bg-btn ghost"
            onClick={() => void window.api.bgTasks.clearFinished(sessionId)}
          >
            {t('清除已完成')}
          </button>
        ) : null}
        <button type="button" className="bg-btn ghost" onClick={onClose}>
          {t('关闭面板')}
        </button>
      </div>
      {tasks.length === 0 ? (
        <div className="empty-hint bg-task-empty">
          {t('暂无后台任务。可以让 Agent 在后台跑命令或设定时提醒。')}
        </div>
      ) : (
        <div className="bg-tasks-body">
          <div className="bg-task-list">
            {tasks.map((t) => (
              <TaskListItem
                key={t.id}
                task={t}
                active={t.id === effectiveId}
                onSelect={() => setActiveId(t.id)}
                onRemove={() => void window.api.bgTasks.remove(t.id)}
              />
            ))}
          </div>
          {active ? (
            <div className="bg-task-detail">
              <div className="bg-task-head">
                <span className="bg-task-head-icon" aria-hidden>
                  {KIND_ICON[active.kind]}
                </span>
                <span className="bg-task-head-label">{active.label}</span>
                <span className={`bg-task-state is-${active.status}`}>{bgTaskStateText(active)}</span>
                <span className="bg-task-spacer" />
                {active.status === 'running' ? (
                  <button type="button" className="bg-btn danger" onClick={() => kill(active.id)}>
                    {active.kind === 'timer' ? t('取消') : t('终止')}
                  </button>
                ) : null}
              </div>
              {active.kind === 'subagent' ? (
                <SubagentDetail
                  taskId={active.id}
                  parentSessionId={sessionId}
                  messages={messagesByTask[active.id] ?? []}
                  status={active.status}
                  cwd={props.cwd}
                  workspaceId={props.workspaceId}
                />
              ) : active.kind === 'shell' ? (
                <div className="bg-task-terminal">
                  <TerminalView
                    sessionId={`bg-${active.id}`}
                    workspaceId={props.workspaceId}
                    linkSessionId={sessionId}
                    visible={open}
                    cwd={props.cwd}
                  />
                </div>
              ) : (
                <TimerDetail task={active} onCancel={() => kill(active.id)} />
              )}
              {active.status !== 'running' && active.kind !== 'timer' && active.summary ? (
                <div className="bg-task-result">{active.summary}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <div className="bg-tasks-resizer" onPointerDown={onResizeStart} title={t('拖动调整大小')} />
    </div>
  );
}
