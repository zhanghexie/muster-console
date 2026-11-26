/** 统一从 unknown 取出可读错误文案。 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export type ToolResult<T = unknown> =
  | { ok: true; result?: T }
  | { ok: false; error: string; cancelled?: boolean };

/**
 * 「绝对路径在所有源根之外」的结构化错误码（files-panel F-02）：主进程
 * withWorkspaceFileTarget 抛 OutsideWorkspaceRootsError（reason 携带本码），
 * IPC 结果带回 reason；渲染层据此判定外部只读通道，不再匹配英文报错文案。
 */
export const OUTSIDE_WORKSPACE_ROOTS_REASON = 'outside-workspace-roots';

/** 判 unknown 是否携带区外结构化信号（主进程 throw 侧）。 */
export function isOutsideWorkspaceRootsError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { reason?: unknown }).reason === OUTSIDE_WORKSPACE_ROOTS_REASON
  );
}

/** 区外只读通道判定（IPC 结果侧）：结构化 reason 优先，英文原文案保留兜底（旧契约兼容）。 */
export function isOutsideWorkspaceRootsResult(result: { error?: string; reason?: string }): boolean {
  return (
    result.reason === OUTSIDE_WORKSPACE_ROOTS_REASON ||
    (typeof result.error === 'string' && result.error.includes('outside workspace roots'))
  );
}
