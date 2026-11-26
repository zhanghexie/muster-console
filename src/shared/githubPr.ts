import type { GitOperationScope } from './gitOperations';

export interface PrRepoScope extends GitOperationScope {
  repoPath: string;
}

export type GitHubConnection =
  | { state: 'unconfigured' }
  | { state: 'signedOut' }
  | { state: 'pending'; userCode: string; verificationUrl: string; expiresAt: number }
  | { state: 'connected'; login: string };

export interface GitHubAppConfig { clientId: string; slug: string }

export const GITHUB_PR_APP_PERMISSIONS = {
  pull_requests: 'write', contents: 'read', checks: 'read', statuses: 'read'
} as const;
export type GitHubPrPermission = keyof typeof GITHUB_PR_APP_PERMISSIONS;

export interface GitHubAppSetup {
  active: GitHubAppConfig | null;
  source: 'default' | 'custom' | 'none';
  hasDefault: boolean;
}

export interface GitHubAppInput { app: string; clientId?: string }

export interface PrRef { number: number; url: string }
export type PrFilter = 'authored' | 'reviewRequested';
export type PrChecksStatus = 'pass' | 'pending' | 'failure' | 'none' | 'unknown';
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export type PrAppAccess =
  | { state: 'ready' }
  | { state: 'install'; url: string }
  | { state: 'permissions'; url: string; missing: GitHubPrPermission[] }
  | { state: 'unavailable'; message: string };

export interface PrRepository {
  name: string;
  pushRepository: string | null;
  defaultBranch: string;
  url: string;
  autoReview: boolean;
  appAccess?: PrAppAccess;
}

export interface PrSummary extends PrRef {
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string | null;
  updatedAt: string;
  checks: PrChecksStatus;
  reviewDecision: PrReviewDecision | null;
  latestDiscussionAt: string | null;
}

export interface PrCheck {
  name: string;
  state: string;
  url: string | null;
}

export interface PrDiscussionEntry {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
  url: string | null;
  reviewState?: string;
}

export interface PrReviewThread {
  id: string;
  path: string;
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  resolved: boolean;
  outdated: boolean;
  comments: PrDiscussionEntry[];
  commentsTruncated: boolean;
}

export interface PrFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  truncated: boolean;
}

export interface PrVersion {
  repository: string;
  number: number;
  headSha: string;
  baseSha: string;
}

export interface PrDetail extends PrSummary, PrVersion {
  body: string;
  files: PrFile[];
  filesPage: number;
  filesHaveMore: boolean;
  checkEntries: PrCheck[];
  checksTruncated: boolean;
  discussion: PrDiscussionEntry[];
  threads: PrReviewThread[];
  threadCursor: string | null;
  workerName: string | null;
  draft: PrAiDraft | null;
}

export interface PrAiDraft {
  body: string;
  partial: boolean;
  createdAt: number;
}

export interface CreatePrInput {
  branch: string;
  base?: string;
  title: string;
  body: string;
  draft: boolean;
  repository: string;
  pushRepository: string;
}

export type PrReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface PrInlineDraft {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export interface SubmitPrReviewInput {
  version: PrVersion;
  event: PrReviewEvent;
  body: string;
  comments: PrInlineDraft[];
}

export type PrErrorKind =
  | 'configuration' | 'appLookup' | 'auth' | 'repo' | 'permission' | 'rateLimit' | 'changed' | 'network' | 'failed';

export type PrResult<T> = { ok: true; value: T } | {
  ok: false;
  kind: PrErrorKind;
  message: string;
  installUrl?: string;
};

export interface PrApi {
  appSetup(): Promise<PrResult<GitHubAppSetup>>;
  configureApp(input: GitHubAppInput | null): Promise<PrResult<GitHubConnection>>;
  connection(): Promise<PrResult<GitHubConnection>>;
  authorize(): Promise<PrResult<GitHubConnection>>;
  disconnect(): Promise<PrResult<GitHubConnection>>;
  repository(scope: PrRepoScope): Promise<PrResult<PrRepository>>;
  list(scope: PrRepoScope, filter: PrFilter, cursor?: string): Promise<PrResult<{ prs: PrSummary[]; cursor: string | null }>>;
  detail(scope: PrRepoScope, number: number): Promise<PrResult<PrDetail>>;
  files(scope: PrRepoScope, version: PrVersion, page: number): Promise<PrResult<{ files: PrFile[]; filesHaveMore: boolean }>>;
  threads(scope: PrRepoScope, version: PrVersion, cursor: string): Promise<PrResult<{ threads: PrReviewThread[]; threadCursor: string | null }>>;
  create(scope: PrRepoScope, input: CreatePrInput): Promise<PrResult<PrRef>>;
  forward(scope: PrRepoScope, version: PrVersion, ids: string[]): Promise<PrResult<{ workerName: string }>>;
  draft(scope: PrRepoScope, version: PrVersion): Promise<PrResult<PrAiDraft>>;
  publish(scope: PrRepoScope, input: SubmitPrReviewInput): Promise<PrResult<{ url: string | null }>>;
  setAutoReview(scope: PrRepoScope, repository: string, enabled: boolean): Promise<PrResult<{ enabled: boolean }>>;
}
