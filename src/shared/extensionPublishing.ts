import type { ExtensionCenterCatalogRelease } from './extensionCenter';

export function parsePublishingOrigin(value: string): URL {
  const url = new URL(value);
  if (url.href !== `${url.origin}/` || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('Invalid extension publishing origin');
  }
  return url;
}

export interface ExtensionPublishingSession {
  available: boolean;
  login?: string;
  reviewer: boolean;
  installUrl?: string;
}

export interface ExtensionPublishingConnection {
  ok: true;
  origin?: string;
  local: boolean;
}

export type ExtensionPublishingLocalResult = { ok: true; canceled?: true } | { ok: false; error: string };

export interface ExtensionSubmission {
  id: string;
  extensionId: string;
  name: string;
  version: string;
  repository: string;
  commit: string;
  sourceFingerprint?: string;
  status: 'checking' | 'ready' | 'changes' | 'published';
  reason?: string;
}

export interface ExtensionSubmissionReview extends ExtensionSubmission {
  trialed: boolean;
  previous?: { version: string; commit: string; permissions: string[] };
  report: {
    release: ExtensionCenterCatalogRelease;
    permissions: string[];
    fileCount: number;
    syntaxChecked: number;
    mcp: string[];
    domainEntry?: string;
    commandEntry?: string;
  };
}

export interface ExtensionPublishingApi {
  connection(): Promise<ExtensionPublishingConnection>;
  startLocal(): Promise<ExtensionPublishingLocalResult>;
  stopLocal(): Promise<ExtensionPublishingLocalResult>;
  session(): Promise<ExtensionPublishingSession>;
  signIn(): Promise<ExtensionPublishingSession>;
  authorizeRepository(): Promise<void>;
  mine(): Promise<ExtensionSubmission[]>;
  submit(extensionId: string, repository: string): Promise<ExtensionSubmission>;
  queue(): Promise<ExtensionSubmission[]>;
  review(id: string): Promise<ExtensionSubmissionReview>;
  trial(id: string): Promise<void>;
  decide(id: string, decision: 'approve' | 'return', reason?: string): Promise<ExtensionSubmission>;
  previewTarget(): Promise<string | null>;
}
