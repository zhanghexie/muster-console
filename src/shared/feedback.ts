/** Shared, user-reviewable feedback. Credentials never leave the main process. */
export type FeedbackKind = 'bug' | 'improvement';
export type FeedbackStatus = 'pending' | 'submitting' | 'opened' | 'uncertain' | 'submitted' | 'duplicate' | 'rejected';
export type FeedbackProvider = 'gitlab' | 'github';

export interface FeedbackDraft {
  kind: FeedbackKind;
  title: string;
  area: string;
  context: string;
  actual: string;
  expected: string;
  steps: string;
  impact: string;
  evidence: string;
  suggestion: string;
}

export interface FeedbackEntry extends FeedbackDraft {
  id: string;
  revision: number;
  status: FeedbackStatus;
  createdAt: number;
  updatedAt: number;
  sources: string[];
  appVersion: string;
  environment?: string;
  submissionTarget?: FeedbackTarget;
  issueUrl?: string;
  error?: string;
  /** User-edited Issue body; when present it replaces the original structured fields. */
  editedBody?: string;
  /** The draft has been compared with the remote history by an AI. */
  aiChecked?: boolean;
  aiHistory?: { local: string; remote: string };
}

export interface FeedbackTarget { provider: FeedbackProvider; repository: string }
export interface FeedbackSnapshot {
  entries: FeedbackEntry[];
}
export type ManualFeedbackInput = FeedbackDraft & { environment: string };
export interface ManualFeedbackResult { id: string; snapshot: FeedbackSnapshot }
export interface FeedbackCredentialStatus { configured: boolean }

export interface FeedbackMatch { id: string; title: string; status: string; url?: string; exact: boolean; source: 'local' | 'remote' }
export interface FeedbackReview { reviewId: string; revision: number; matches: FeedbackMatch[]; body: string; copyBody?: boolean }
export interface FeedbackProposalResult { id: string; title: string; disposition: 'created' | 'existing'; matches: FeedbackMatch[] }
export interface FeedbackHistoryItem {
  id: string;
  source: 'local' | 'remote';
  revision?: number;
  needsAiCheck?: boolean;
  title: string;
  status: string;
  body: string;
  bodyTruncated?: boolean;
  url?: string;
}
export interface FeedbackHistoryPage {
  checkId: string;
  items: FeedbackHistoryItem[];
  hasMore: boolean;
  remoteAvailable: boolean;
  remoteError?: string;
}
export interface FeedbackHistoryDetail {
  checkId: string;
  source: 'local' | 'remote';
  id: string;
  text: string;
  nextOffset?: number;
}

/** Public issue tracker for product feedback. */
export const DEFAULT_FEEDBACK_TARGET: FeedbackTarget = {
  provider: 'github', repository: 'https://github.com/zhanghexie/muster-console'
};
