/** 进程监视器只读快照：按 OS PID 建树，指标来自 Electron 的统一采样。 */

export interface ProcessMonitorNode {
  key: string;
  pid: number;
  parentPid: number | null;
  type: string;
  name: string;
  /** Human-facing role, independent of Electron's internal process type. */
  businessLabel?: string;
  serviceName?: string;
  role?: string;
  workspaceId?: string;
  workspaceName?: string;
  sessionId?: string;
  sessionName?: string;
  taskId?: string;
  taskLabel?: string;
  title?: string;
  url?: string;
  creationTime: number;
  cpuPercent: number;
  workingSetKb: number;
  privateKb?: number;
  sandboxed?: boolean;
  children: ProcessMonitorNode[];
}

export interface ProcessMonitorSnapshot {
  capturedAt: number;
  rootPid: number;
  processCount: number;
  historySize: number;
  historyCapacity: number;
  nodes: ProcessMonitorNode[];
  cpuHistory?: Array<{ capturedAt: number; values: Array<{ pid: number; cpuPercent: number }> }>;
}

export type ProcessMonitorProfileResult = {
  ok: true;
  kind: 'cpu-profile' | 'heap-snapshot';
  pid: number;
  path: string;
  sizeBytes: number;
  capturedAt: number;
  durationMs?: number;
} | { ok: false; error: string };

export type ProcessMonitorCpuStartResult = { ok: true; pid: number; startedAt: number; maxDurationMs: number } | { ok: false; error: string };

export interface OwnedProcessMonitorMeta {
  name: string;
  type: string;
  businessLabel?: string;
  serviceName?: string;
  role?: string;
  workspaceId?: string;
  workspaceName?: string;
  sessionId?: string;
  sessionName?: string;
  taskId?: string;
  taskLabel?: string;
  startedAt: number;
}

