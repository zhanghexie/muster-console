import { createHash } from 'node:crypto';
import type { SessionMeta } from '../../shared/types';
import type { ExtensionDomainInstanceIdentity } from '../../shared/extensionDomain';
import { sourcePathKey } from '../workspacePaths';

/** Stable within one sidebar instance and physical project root, regardless of its live session ID. */
export function extensionSidebarTaskRef(session: SessionMeta | undefined, identity: ExtensionDomainInstanceIdentity, scope: string): string | undefined {
  const root = session?.sourceRoot;
  if (!root || !session?.hidden || session.archived || session.workspaceId !== identity.workspaceId ||
      session.meta?.extensionAgent !== 'true' || session.meta.extensionId !== identity.extensionId ||
      session.meta.extensionInstanceId !== identity.extensionInstanceId ||
      (session.meta.extensionScope && session.meta.extensionScope !== scope)) return undefined;
  const key = [scope, identity.workspaceId, identity.extensionInstanceId, root.rootId, root.physicalPath ?? sourcePathKey(root.path)];
  return 'sidebar:' + createHash('sha256').update(JSON.stringify(key)).digest('hex');
}
