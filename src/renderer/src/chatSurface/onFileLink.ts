/**
 * 会话消息里的路径/链接点击 → 打开文件面板（两表面共用）：
 * 接受 muster-file: href、file:// URI、相对/绝对路径三种形态；相对路径相对会话 cwd 解析，
 * 点不开 toast、不抛异常。会话内 HTTP(S) URL 由 ChatLinkBoundary 路由到内置浏览器；
 * 这里保留 localhost 映射作为旧调用方的兼容路径。
 */
import { isLocalhostHttpUrl, localFileFromUrl, resolvePathCandidate } from '../../../shared/terminalSelectionText';
import { parseWorkspaceFileHref } from '../../../shared/linkifyWorkspacePaths';

interface FileLinkHost {
  cwd?: string;
  requestOpenWorkspaceFile: (args: { path: string; line?: number; col?: number }) => void;
  flashTip: (text: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

/** file:// URI → 本地路径（渲染层无 node:url，Windows 盘符手工剥前导斜杠） */
function fileUriToPath(uri: string): string | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'file:') return null;
    let p = decodeURIComponent(u.pathname);
    if (u.hostname && u.hostname !== 'localhost') p = `//${u.hostname}${p}`;
    else if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return null;
  }
}

/** Parse the same file forms for in-app navigation and explicit system actions. */
export function parseChatFileTarget(href: string): { path: string; line?: number; col?: number } | null {
  if (href.startsWith('muster-file:')) return parseWorkspaceFileHref(href);
  if (/^file:\/\//i.test(href)) {
    const path = fileUriToPath(href);
    return path ? { path } : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;
  try {
    return href ? { path: decodeURIComponent(href) } : null;
  } catch {
    return null;
  }
}

/** Preserve POSIX absolute paths, including /e/..., in POSIX workspaces. */
export function resolveChatFilePath(path: string, cwd?: string): string | null {
  const windowsCwd = !!cwd && (/^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith('\\\\'));
  if (path.startsWith('/') && !/^\/[a-z]:[\\/]/i.test(path) && (!windowsCwd || path.startsWith('//'))) return path;
  return resolvePathCandidate(path, cwd);
}

async function openExternal(href: string, host: FileLinkHost): Promise<void> {
  void window.api.shell
    .openExternal(href)
    .then((r) => {
      if (!r.ok) host.flashTip(r.error || host.t('无法打开链接'));
    })
    .catch(() => undefined);
}

export async function handleChatFileLink(href: string, host: FileLinkHost): Promise<void> {
  // mailto/tel 等非文件协议不进文件面板（上游已挡，这里兜底）
  if (/^(mailto|tel|callto|sms):/i.test(href)) return;
  if (isLocalhostHttpUrl(href)) {
    const local = localFileFromUrl(href, host.cwd);
    if (local) {
      // 磁盘级存在判断（工作区内外都算）：存在 → 交给预览闸口；不存在 → 浏览器
      let stats: Record<string, { exists: boolean }> = {};
      try {
        stats = await window.api.shell.statPaths([local]);
      } catch {
        stats = {};
      }
      if (stats[local]?.exists) {
        host.requestOpenWorkspaceFile({ path: local });
      } else {
        await openExternal(href, host);
      }
      return;
    }
    await openExternal(href, host);
    return;
  }
  const target = parseChatFileTarget(href);
  if (!target) { host.flashTip(host.t('无法确定文件路径')); return; }
  const resolved = resolveChatFilePath(target.path, host.cwd) ?? target.path;
  // 存在性/工作区内外统一由 SideToolsPanel 闸口判定：
  // 工作区内直接开；找不到时完整路径做磁盘级判断，存在即外部只读预览
  host.requestOpenWorkspaceFile({
    path: resolved,
    line: target.line,
    col: target.col
  });
}
