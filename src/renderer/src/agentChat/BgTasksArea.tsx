/**
 * 输入框上方的后台任务胶囊 + 上弹面板（一个会话一个实例，订阅一路推送）。
 * 显示规则：有任务记录即常驻胶囊（运行中=蓝、有未读=绿；完成态可在面板删除，
 * 清空后胶囊消失）。面板 portal 进 .chat-input-shell 渲染、与输入壳同宽对齐
 * （工具栏 container-type 是包含块，原地 absolute 锚不到壳，见 .bg-tasks-pop）。
 * 关闭面板时 markRead（未读徽标清零）。
 */
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../../shared/i18n';
import { usePresence, MOTION } from '../components/motion';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useBgTasks } from './useBgTasks';
import { bgTaskStateText } from './bgTaskStateText';
const BgTasksPanel = React.lazy(() =>
  import('./BgTasksPanel').then((m) => ({ default: m.BgTasksPanel }))
);

export function BgTasksArea(props: {
  sessionId: string;
  cwd?: string;
  workspaceId?: string;
}): React.JSX.Element | null {
  const { sessionId } = props;
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, MOTION.menuMs);
  // 只有面板挂载期间才订阅子代理消息整包（胶囊只用 tasks 快照）——顺序上必须先算
  // presence 再订阅
  const { tasks, messagesByTask } = useBgTasks(sessionId, presence.mounted);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 面板根（portal 渲染，不在胶囊子树里；外点判定要带上） */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const setPanelNode = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
  }, []);
  /** portal 宿主：最近的输入壳。组件可见前 return null（ref 为空），须跟随 visible 重试 */
  const [shellEl, setShellEl] = useState<HTMLElement | null>(null);
  const running = tasks.filter((task) => task.status === 'running').length;
  const unread = tasks.filter((task) => task.unread).length;
  // presence.mounted：删空任务后关闭时让退场动画播完再卸载
  const visible = tasks.length > 0 || open || presence.mounted;
  useEffect(() => {
    if (!visible || shellEl) return;
    const shell = rootRef.current?.closest('.chat-input-shell');
    if (shell instanceof HTMLElement) setShellEl(shell);
  }, [visible, shellEl]);

  // 外点关闭（胶囊 + portal 面板整体为根）
  const dismissRefs = useMemo(() => [rootRef, panelRef], []);
  useDismissOnOutsideClick(open, dismissRefs, () => {
    setOpen(false);
    void window.api.bgTasks.markRead(sessionId);
  });

  if (!visible) return null;

  const close = (): void => {
    setOpen(false);
    void window.api.bgTasks.markRead(sessionId);
  };

  const title = tasks.map((task) => `${bgTaskStateText(task)}：${task.label}`).join('\n');

  const panel = presence.mounted ? (
    <Suspense fallback={null}>
      <BgTasksPanel
        sessionId={sessionId}
        tasks={tasks}
        messagesByTask={messagesByTask}
        cwd={props.cwd}
        workspaceId={props.workspaceId}
        open={open}
        stage={presence.stage}
        onClose={close}
        outerRef={setPanelNode}
      />
    </Suspense>
  ) : null;

  return (
    <div className="agent-composer-bgtasks" ref={rootRef}>
      <button
        type="button"
        className={`bg-capsule${open ? ' is-open' : ''}${running > 0 ? ' is-running' : ''}${unread > 0 ? ' has-unread' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        title={title}
      >
        {running > 0 ? (
          <span className="bg-capsule-dot" aria-hidden />
        ) : unread > 0 ? (
          <span className="bg-capsule-dot is-done" aria-hidden />
        ) : null}
        <span className="bg-capsule-text">
          {running > 0 ? t('后台 {{n}}', { n: running }) : unread > 0 ? t('{{n}} 个结果', { n: unread }) : t('后台任务')}
        </span>
        {unread > 0 ? <span className="bg-capsule-badge">{unread}</span> : null}
      </button>
      {panel && shellEl ? createPortal(panel, shellEl) : panel}
    </div>
  );
}
