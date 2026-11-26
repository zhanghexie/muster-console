/** 手机工作台通过 URL 片段定位当前工作区的会话。 */
export const SESSION_DEEP_LINK_PREFIX = '#/session/';

/**
 * 从 location.hash（或任意含深链的字符串）解析会话 id；无效返回 null。
 * 只取 prefix 后的第一段（容忍未来扩展子路径 / query）。
 */
export function parseSessionDeepLink(hash: string): string | null {
  const idx = hash.indexOf(SESSION_DEEP_LINK_PREFIX);
  if (idx < 0) return null;
  const seg = hash
    .slice(idx + SESSION_DEEP_LINK_PREFIX.length)
    .split('?')[0]!
    .split('/')[0]!;
  if (!seg) return null;
  try {
    return decodeURIComponent(seg) || null;
  } catch {
    return null;
  }
}

/** 手机 URL 的 hash 深链 → 工作区+会话（会话表尚未到位时返回 null，调用方等数据再试） */
export function resolveSessionFromHash(
  hash: string,
  sessions: ReadonlyArray<{ id: string; workspaceId?: string }>
): { sessionId: string; workspaceId: string } | null {
  const sessionId = parseSessionDeepLink(hash);
  if (!sessionId) return null;
  const s = sessions.find((x) => x.id === sessionId);
  const workspaceId = s?.workspaceId?.trim();
  if (!workspaceId) return null;
  return { sessionId, workspaceId };
}
