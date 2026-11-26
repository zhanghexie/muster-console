import { captureWorkspaceExecutionContext } from '../../workspaceExecutionContext';
import { workspaceRootUsesFor } from '../../workspaceRootUses';
import type { HostCore, SessionEntry } from './internal';

/** Capture synchronously and hold every referenced root before the first async boundary. */
export function beginWorkspaceContext(host: HostCore, entry: SessionEntry): void {
  endWorkspaceContext(entry);
  const session = host.ctx.sessions.get(entry.sessionId);
  if (!session) return;
  const captured = captureWorkspaceExecutionContext(host.ctx.config.get(), session, host.ctx.sessions.rootDependencyRoster?.() ?? host.ctx.sessions.list?.());
  const context = host.store?.withAttachmentReadAccess?.(entry.sessionId, captured) ?? captured;
  entry.turnWorkspaceContext = context;
  if (!context) return;
  const releases = context.roots.map(root => workspaceRootUsesFor(host.ctx.config).acquire({
    workspaceId: context.workspaceId, rootId: root.rootId,
    kind: 'session', id: entry.sessionId, sessionId: entry.sessionId,
    label: session.name
  }));
  entry.releaseWorkspaceContext = () => { for (const release of releases) release(); };
}

export function endWorkspaceContext(entry: SessionEntry): void {
  const release = entry.releaseWorkspaceContext;
  entry.releaseWorkspaceContext = undefined;
  entry.turnWorkspaceContext = undefined;
  if (release && entry.connecting) void entry.connecting.finally(release).catch(() => {});
  else release?.();
}
