import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowOverview } from '../../../shared/workflow';

const EMPTY: WorkflowOverview = { workflows: [], active: [], recent: [] };

/** 工作流概览：首帧拉取 + workflow:changed 推送后重拉（同工作区才拉） */
export function useWorkflowOverview(workspaceId: string | null | undefined): {
  overview: WorkflowOverview;
  reload: () => void;
} {
  const [overview, setOverview] = useState<WorkflowOverview>(EMPTY);
  const gen = useRef(0);

  const reload = useCallback(() => {
    const fetchOverview = window.api?.workflow?.overview;
    if (!workspaceId || typeof fetchOverview !== 'function') {
      setOverview(EMPTY);
      return;
    }
    const my = ++gen.current;
    void fetchOverview(workspaceId)
      .then((r) => {
        if (my === gen.current) setOverview(r ?? EMPTY);
      })
      .catch(() => {
        if (my === gen.current) setOverview(EMPTY);
      });
  }, [workspaceId]);

  useEffect(() => {
    reload();
    if (!workspaceId) return;
    const off = window.api?.on?.('workflow:changed', (payload: { workspaceId?: string }) => {
      if (payload?.workspaceId === workspaceId) reload();
    });
    return () => {
      off?.();
    };
  }, [workspaceId, reload]);

  return { overview, reload };
}
