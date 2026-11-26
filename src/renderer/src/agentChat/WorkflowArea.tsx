/**
 * 调度输入栏旁的「工作流」胶囊 + 上弹面板（dynamic-workflow）。工作区有工作流、活跃 run
 * 或运行历史时常驻（工作流删光后仍可清理历史）；有问用户的待答问题时胶囊高亮并显示「待你答复」。面板 portal 进 .chat-input-shell，
 * 与后台任务面板同一布局与进出场（mp-pop mp-pop-up + usePresence）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../../shared/i18n';
import { usePresence, MOTION } from '../components/motion';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useWorkflowOverview } from './useWorkflowOverview';
import { WorkflowPanel } from './WorkflowPanel';

export function WorkflowArea(props: { workspaceId: string }): React.JSX.Element | null {
  const { workspaceId } = props;
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, MOTION.menuMs);
  const { overview, reload } = useWorkflowOverview(workspaceId);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const setPanelNode = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
  }, []);
  const [shellEl, setShellEl] = useState<HTMLElement | null>(null);
  const running = overview.active.filter((r) => !r.parentRunId).length;
  const humanAsks = overview.active.filter((r) => r.pendingAsk?.to === 'human').length;
  const visible =
    overview.workflows.length > 0 || overview.active.length > 0 || overview.recent.length > 0 || open || presence.mounted;

  useEffect(() => {
    if (!visible || shellEl) return;
    const shell = rootRef.current?.closest('.chat-input-shell');
    if (shell instanceof HTMLElement) setShellEl(shell);
  }, [visible, shellEl]);

  const dismissRefs = useMemo(() => [rootRef, panelRef], []);
  useDismissOnOutsideClick(open, dismissRefs, () => setOpen(false));

  if (!visible) return null;

  const panel = presence.mounted ? (
    <WorkflowPanel
      workspaceId={workspaceId}
      overview={overview}
      stage={presence.stage}
      onClose={() => setOpen(false)}
      onChanged={reload}
      outerRef={setPanelNode}
    />
  ) : null;

  return (
    <div className="agent-composer-bgtasks agent-composer-workflow" ref={rootRef}>
      <button
        type="button"
        className={`bg-capsule wf-capsule${open ? ' is-open' : ''}${running > 0 ? ' is-running' : ''}${humanAsks > 0 ? ' has-ask' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {running > 0 ? <span className={`bg-capsule-dot${humanAsks > 0 ? ' is-ask' : ''}`} aria-hidden /> : null}
        <span className="bg-capsule-text">
          {humanAsks > 0
            ? t('工作流待你答复')
            : running > 0
              ? t('工作流 {{n}}', { n: running })
              : t('工作流')}
        </span>
        {humanAsks > 0 ? <span className="bg-capsule-badge wf-capsule-badge">{humanAsks}</span> : null}
      </button>
      {panel && shellEl ? createPortal(panel, shellEl) : panel}
    </div>
  );
}
