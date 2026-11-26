/**
 * Host-owned identity for an Agent session attached to one extension instance.
 * This metadata is deliberately independent from the Pi driver so the session
 * can later use another harness without changing the extension contract.
 */
export interface ExtensionAgentSessionMeta {
  kind: 'extension-agent';
  extensionId: string;
  extensionInstanceId: string;
  workspaceId: string;
  sourceRootId?: string;
  packageFingerprint: string;
  surfaceId: string;
  runtimeId: 'pi';
}

export interface ExtensionAgentSessionBinding extends ExtensionAgentSessionMeta {
  sessionId: string;
}

export function isExtensionAgentSessionMeta(value: unknown): value is ExtensionAgentSessionMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.kind === 'extension-agent'
    && typeof item.extensionId === 'string' && item.extensionId.length > 0
    && typeof item.extensionInstanceId === 'string' && item.extensionInstanceId.length > 0
    && typeof item.workspaceId === 'string' && item.workspaceId.length > 0
    && (item.sourceRootId === undefined || typeof item.sourceRootId === 'string')
    && typeof item.packageFingerprint === 'string' && item.packageFingerprint.length > 0
    && typeof item.surfaceId === 'string' && item.surfaceId.length > 0
    && item.runtimeId === 'pi';
}

export function extensionAgentSessionKey(meta: Pick<ExtensionAgentSessionMeta, 'extensionId' | 'extensionInstanceId' | 'workspaceId' | 'surfaceId'>): string {
  return [meta.workspaceId, meta.extensionId, meta.extensionInstanceId, meta.surfaceId].join(':');
}

export function sameExtensionAgentSession(a: ExtensionAgentSessionMeta | undefined, b: ExtensionAgentSessionMeta | undefined): boolean {
  return !!a && !!b
    && a.kind === b.kind
    && a.extensionId === b.extensionId
    && a.extensionInstanceId === b.extensionInstanceId
    && a.workspaceId === b.workspaceId
    && a.sourceRootId === b.sourceRootId
    && a.packageFingerprint === b.packageFingerprint
    && a.surfaceId === b.surfaceId
    && a.runtimeId === b.runtimeId;
}
