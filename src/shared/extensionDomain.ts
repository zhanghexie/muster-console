import type { ExtensionManifest } from './extensionManifest';

/** The host identity that scopes one domain runtime instance. */
export interface ExtensionDomainInstanceIdentity {
  extensionId: string;
  extensionInstanceId: string;
  workspaceId: string;
  sourceRootId?: string;
  packageFingerprint: string;
  surfaceId: string;
}

export interface ExtensionDomainContext {
  identity: ExtensionDomainInstanceIdentity;
  manifest: ExtensionManifest;
  sessionId?: string;
  /** Durable sidebar target for project artifacts. Regular tasks use sessionId. */
  taskRef?: string;
  actor: 'human' | 'agent';
  requestId: string;
  signal: AbortSignal;
  expectedVersion?: number;
}

export interface ExtensionDomainSnapshot<State = unknown> {
  version: number;
  state: State;
  selection?: unknown;
  view?: unknown;
  availableCommands: string[];
  capturedAt: string;
}

export interface ExtensionDomainEvent {
  type: string;
  extensionId: string;
  extensionInstanceId: string;
  workspaceId: string;
  version: number;
  requestId: string;
  actor: 'human' | 'agent';
  payload?: unknown;
}

export interface ExtensionDomainActionResult {
  ok: true;
  version: number;
  result?: unknown;
  diff?: unknown;
  undo?: unknown;
}

export interface ExtensionDomainRuntime {
  getSnapshot(context: ExtensionDomainContext): Promise<ExtensionDomainSnapshot>;
  query(name: string, args: unknown, context: ExtensionDomainContext): Promise<unknown>;
  execute(name: string, args: unknown, context: ExtensionDomainContext): Promise<ExtensionDomainActionResult>;
  subscribe(listener: (event: ExtensionDomainEvent) => void): () => void;
  close?(): Promise<void> | void;
}

export interface ExtensionDomainRuntimeFactory {
  create(input: { identity: ExtensionDomainInstanceIdentity; manifest: ExtensionManifest }): Promise<ExtensionDomainRuntime> | ExtensionDomainRuntime;
}

export function extensionDomainInstanceKey(identity: ExtensionDomainInstanceIdentity): string {
  return [identity.workspaceId, identity.extensionId, identity.extensionInstanceId, identity.surfaceId].join(':');
}

