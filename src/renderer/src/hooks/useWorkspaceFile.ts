import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceFileConfig } from '../../../shared/metaAgent';
import { defaultWorkspaceFileConfig } from '../../../shared/metaAgent';

/**
 * 当前 active 工作区的 `.muster/workspace.json`。
 * mount / `workspaces:changed` 时 get；变更用 patch（绑定 workspaceId，防跨区竞态）。
 * 切换工作区时先 `ready=false`，避免面板用旧 cfg patch 进新工作区。
 */
export interface WorkspaceFilePatchOutcome {
  /** 主进程回执 ok（sideTools F-02：保存判定只看布尔，不做内容回读全等比较） */
  ok: boolean;
  /** ok=true 时为落盘归一后的配置；false 时为当前本地配置（未写） */
  config: WorkspaceFileConfig;
  /** 调用取消与实际写入失败分开，避免切换工作区时误报保存失败。 */
  reason?: 'not-ready' | 'stale-owner' | 'write-failed';
}
export type WorkspaceFilePatch = (partial: Partial<WorkspaceFileConfig>, ownerWorkspaceId?: string) => Promise<WorkspaceFilePatchOutcome>;

export function useWorkspaceFile(): {
  cfg: WorkspaceFileConfig;
  /** 当次 cfg 引用（A2-6-1：水合类 effect deps 不随任意 patch 抖动，经它读当次值） */
  cfgRef: React.MutableRefObject<WorkspaceFileConfig>;
  ready: boolean;
  workspaceId: string | null;
  /** Delayed callers pass their original owner; an old owner is cancelled, never redirected. */
  patch: WorkspaceFilePatch;
  reload: () => Promise<void>;
} {
  const [cfg, setCfg] = useState<WorkspaceFileConfig>(() => defaultWorkspaceFileConfig());
  const [ready, setReady] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const genRef = useRef(0);
  const workspaceIdRef = useRef<string | null>(null);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const reload = useCallback(async () => {
    const gen = ++genRef.current;
    setReady(false);
    readyRef.current = false;
    const next = await window.api.workspaceFile.get();
    if (gen !== genRef.current) return;
    setCfg(next.config);
    cfgRef.current = next.config;
    setWorkspaceId(next.workspaceId);
    workspaceIdRef.current = next.workspaceId;
    setReady(true);
    readyRef.current = true;
  }, []);

  useEffect(() => {
    void reload();
    return window.api.on('workspaces:changed', () => {
      void reload();
    });
  }, [reload]);

  const patch = useCallback(async (partial: Partial<WorkspaceFileConfig>, ownerWorkspaceId?: string): Promise<WorkspaceFilePatchOutcome> => {
    if (!readyRef.current) return { ok: false, config: cfgRef.current, reason: 'not-ready' };
    const id = workspaceIdRef.current;
    if (!id) return { ok: false, config: cfgRef.current, reason: 'not-ready' };
    if (ownerWorkspaceId != null && ownerWorkspaceId !== id) return { ok: false, config: cfgRef.current, reason: 'stale-owner' };
    const gen = genRef.current;
    const res = await window.api.workspaceFile.patch(partial, id).catch((error: unknown) => {
      if (gen !== genRef.current || workspaceIdRef.current !== id) return null;
      throw error;
    });
    if (!res || gen !== genRef.current || workspaceIdRef.current !== id) return { ok: false, config: cfgRef.current, reason: 'stale-owner' };
    if (!res.ok) return { ok: false, config: cfgRef.current, reason: 'stale-owner' };
    setCfg(res.config);
    cfgRef.current = res.config;
    return { ok: true, config: res.config };
  }, []);

  return { cfg, cfgRef, ready, workspaceId, patch, reload };
}
