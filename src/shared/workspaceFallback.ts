/**
 * 工作区 id 兜底链（渲染层多处使用，统一口径）：
 * 激活区 → 列表首区 → 哨兵 'default'。
 * 哨兵只在配置异常（无任何工作区）时出现，让按工作区键控的本地状态（面板史等）仍有键可用。
 */
export const FALLBACK_WORKSPACE_ID = 'default';

export function resolveWorkspaceId(
  activeId: string | null | undefined,
  workspaces: ReadonlyArray<{ id: string }>
): string {
  return activeId ?? workspaces[0]?.id ?? FALLBACK_WORKSPACE_ID;
}
