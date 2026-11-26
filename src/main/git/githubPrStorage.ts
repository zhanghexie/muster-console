import fs from 'node:fs';
import path from 'node:path';
import type { GitHubAppConfig, PrAiDraft, PrRepoScope, PrVersion } from '../../shared/githubPr';
import { t } from '../../shared/i18n';
import { assertCredentialStorage } from '../agentApps/credentialPolicy';
import { writeTextAtomicSync } from '../atomicJson';
import { configuredGitHubApp } from './githubAppConfig';
import type { GitHubSession } from './githubAppAuth';
import { GitHubPrError, object, string } from './githubHttp';

export interface AutoReviewTarget {
  scope: PrRepoScope;
  repository: string;
  login: string;
}

type Cipher = Pick<Electron.SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString' | 'getSelectedStorageBackend'>;
interface AuthState { app: GitHubAppConfig | null; encryptedSession: string | null }

export function reviewVersionKey(login: string, version: PrVersion): string {
  return JSON.stringify([login.toLowerCase(), version.repository.toLowerCase(), version.number, version.headSha, version.baseSha]);
}

function readFile(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class GitHubPrStorage {
  private state?: { targets: AutoReviewTarget[]; drafts: Record<string, PrAiDraft> };
  private auth?: AuthState;

  constructor(private readonly root: string, private readonly cipher: Cipher, private readonly platform: NodeJS.Platform) {}

  assertStorage(): void {
    try { assertCredentialStorage(this.cipher.isEncryptionAvailable(), this.platform,
      this.platform === 'linux' ? this.cipher.getSelectedStorageBackend() : undefined); }
    catch {
      throw new GitHubPrError('configuration', t('系统凭据存储不可用。Windows 请登录系统账户，macOS 请解锁钥匙串，Linux 请启用 Secret Service 或 KWallet 后重试'));
    }
  }

  session(): GitHubSession | null {
    const { encryptedSession } = this.authData();
    if (!encryptedSession) return null;
    this.assertStorage();
    try {
      const stored = object(JSON.parse(this.cipher.decryptString(Buffer.from(encryptedSession, 'base64'))));
      const { clientId, login, access, refresh, expiresAt } = stored;
      if (typeof clientId !== 'string' || typeof login !== 'string' || typeof access !== 'string' || !access ||
          typeof refresh !== 'string' || !(expiresAt === null || typeof expiresAt === 'number' && Number.isFinite(expiresAt))) throw new Error();
      return { clientId, login, access, refresh, expiresAt };
    } catch {
      throw new GitHubPrError('auth', t('无法读取 GitHub 登录凭据，请断开连接后重新连接'));
    }
  }

  saveSession(session: GitHubSession | null): void {
    if (session) this.assertStorage();
    const encryptedSession = session ? this.cipher.encryptString(JSON.stringify(session)).toString('base64') : null;
    this.persistAuth({ app: this.authData().app, encryptedSession });
  }

  appConfig(): GitHubAppConfig | null { return this.authData().app; }

  saveAppConfig(app: GitHubAppConfig | null, clearSession: boolean): void {
    this.persistAuth({ app, encryptedSession: clearSession ? null : this.authData().encryptedSession });
  }

  private authData(): AuthState {
    if (this.auth) return this.auth;
    const raw = readFile(path.join(this.root, 'session'));
    // Older builds stored the encrypted session directly, without App settings.
    if (!raw?.trimStart().startsWith('{')) return this.auth = { app: null, encryptedSession: raw };
    try {
      const data = object(JSON.parse(raw));
      const app = object(data.app);
      const config = configuredGitHubApp(app.clientId, app.slug);
      if (data.version !== 1 || (data.app !== null && !config) ||
          (data.encryptedSession !== null && typeof data.encryptedSession !== 'string')) throw new Error();
      return this.auth = { app: config, encryptedSession: data.encryptedSession };
    } catch {
      throw new GitHubPrError('configuration', t('无法读取 GitHub App 设置，请重新配置'));
    }
  }

  private persistAuth(state: AuthState): void {
    const file = path.join(this.root, 'session');
    if (state.app || state.encryptedSession) writeTextAtomicSync(file, JSON.stringify({ version: 1, ...state }), { mode: 0o600 });
    else fs.rmSync(file, { force: true });
    this.auth = state;
  }

  targets(): AutoReviewTarget[] { return this.data().targets; }
  diskDraft(key: string): PrAiDraft | null { return this.data().drafts[key] ?? null; }

  setTarget(target: AutoReviewTarget, enabled: boolean): void {
    const data = this.data();
    const targets = data.targets.filter(entry =>
      entry.scope.workspaceId !== target.scope.workspaceId || entry.repository !== target.repository || entry.login !== target.login);
    if (enabled) targets.push(target);
    this.persist({ ...data, targets });
  }

  saveDraft(key: string, draft: PrAiDraft): void {
    const data = this.data();
    const entries = Object.entries(data.drafts).filter(([existing]) => existing !== key).slice(-79);
    entries.push([key, draft]);
    this.persist({ ...data, drafts: Object.fromEntries(entries) });
  }

  private data() {
    if (!this.state) {
      const raw = readFile(path.join(this.root, 'reviews.json'));
      if (!raw) return this.state = { targets: [], drafts: {} };
      try {
        const data = object(JSON.parse(raw));
        if (data.version !== 1 || !Array.isArray(data.targets)) throw new Error();
        const targets = data.targets.filter((entry: unknown): entry is AutoReviewTarget => {
          const target = object(entry), scope = object(target.scope);
          return !!string(target.repository) && !!string(target.login) &&
            !!string(scope.workspaceId) && !!string(scope.repoPath) && Number.isSafeInteger(scope.rootsRevision);
        });
        this.state = { targets, drafts: Object.fromEntries(Object.entries(object(data.drafts)).filter(
          (entry): entry is [string, PrAiDraft] => {
            const draft = object(entry[1]);
            return typeof draft.body === 'string' && typeof draft.partial === 'boolean' && typeof draft.createdAt === 'number';
          })) };
      } catch { throw new GitHubPrError('failed', t('GitHub 审查草稿存储无法读取')); }
    }
    return this.state;
  }

  private persist(next: NonNullable<GitHubPrStorage['state']>): void {
    writeTextAtomicSync(path.join(this.root, 'reviews.json'), JSON.stringify({ version: 1, ...next }), { mode: 0o600 });
    this.state = next;
  }
}
