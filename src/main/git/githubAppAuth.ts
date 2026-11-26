import { t } from '../../shared/i18n';
import type { GitHubAppConfig, GitHubAppInput, GitHubAppSetup, GitHubConnection } from '../../shared/githubPr';
import { resolveGitHubApp } from './githubAppConfig';
import { githubFetch, githubStatusError, GitHubPrError, readGitHubJson, safeGitHubUrl, string } from './githubHttp';

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number | null;
}

export interface GitHubSession extends Tokens {
  clientId: string;
  login: string;
}

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  interval: number;
  nextPoll: number;
}

interface Options {
  app: GitHubAppConfig | null;
  fetcher: typeof fetch;
  readApp: () => GitHubAppConfig | null;
  saveApp: (value: GitHubAppConfig | null, clearSession: boolean) => void;
  read: () => GitHubSession | null;
  save: (value: GitHubSession | null) => void;
  assertStorage: () => void;
  now?: () => number;
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function token(value: unknown): string {
  const text = string(value);
  return text.length <= 4096 && !/\s|[\x00-\x1f]/.test(text) ? text : '';
}

export class GitHubAppAuth {
  private override: GitHubAppConfig | null | undefined;
  private session: GitHubSession | null | undefined;
  private pending: DeviceCode | null = null;
  private generation = 0;
  private starting: Promise<GitHubConnection> | null = null;
  private polling: Promise<void> | null = null;
  private refreshing: Promise<GitHubSession> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  appSetup(): GitHubAppSetup {
    if (this.override === undefined) this.override = this.options.readApp();
    const active = this.override ?? this.options.app;
    return { active, source: this.override ? 'custom' : active ? 'default' : 'none', hasDefault: !!this.options.app };
  }

  async configureApp(input: GitHubAppInput | null): Promise<GitHubConnection> {
    const generation = this.generation;
    const next = input === null ? null : await resolveGitHubApp(input, this.options.fetcher);
    this.assertCurrent(generation);
    let before: GitHubAppConfig | null | undefined;
    try { before = this.appSetup().active; }
    catch (error) {
      if (!(error instanceof GitHubPrError) || error.kind !== 'configuration') throw error;
    }
    const after = next ?? this.options.app;
    const changed = before === undefined || before?.clientId !== after?.clientId || before?.slug !== after?.slug;
    this.options.saveApp(next, changed);
    this.override = next;
    if (changed) {
      this.invalidate();
      this.session = null;
    }
    return this.connection();
  }

  private current(): GitHubSession | null {
    if (this.session === undefined) {
      const saved = this.options.read();
      this.session = saved?.clientId === this.appSetup().active?.clientId ? saved : null;
    }
    return this.session;
  }

  get installUrl(): string | undefined {
    const slug = this.appSetup().active?.slug;
    return slug ? `https://github.com/apps/${slug}/installations/new` : undefined;
  }

  async connection(): Promise<GitHubConnection> {
    if (!this.appSetup().active) return { state: 'unconfigured' };
    if (this.pending && this.pending.expiresAt <= this.now()) {
      this.pending = null;
      throw new GitHubPrError('auth', t('GitHub 授权码已过期，请重新连接'));
    }
    if (this.pending && this.pending.nextPoll <= this.now()) {
      if (!this.polling) {
        const polling = this.poll(this.pending, this.generation).finally(() => { if (this.polling === polling) this.polling = null; });
        this.polling = polling;
      }
      await this.polling;
    }
    const pending = this.pending;
    if (pending) {
      return { state: 'pending', userCode: pending.userCode, verificationUrl: pending.verificationUrl, expiresAt: pending.expiresAt };
    }
    const current = this.current();
    return current ? { state: 'connected', login: current.login } : { state: 'signedOut' };
  }

  async authorize(): Promise<GitHubConnection> {
    const app = this.appSetup().active;
    if (!app || this.pending || this.current()) return this.connection();
    this.options.assertStorage();
    if (!this.starting) {
      const starting = this.start(app.clientId, this.generation).finally(() => { if (this.starting === starting) this.starting = null; });
      this.starting = starting;
    }
    return this.starting;
  }

  private async start(clientId: string, generation: number): Promise<GitHubConnection> {
    const data = await this.post('/login/device/code', { client_id: clientId });
    const deviceCode = token(data.device_code);
    const userCode = string(data.user_code);
    const verificationUrl = safeGitHubUrl(data.verification_uri, 'github.com');
    const expiresIn = seconds(data.expires_in);
    const interval = seconds(data.interval);
    if (!deviceCode || !/^[A-Z\d-]{4,20}$/.test(userCode) || !verificationUrl ||
        new URL(verificationUrl).pathname !== '/login/device' || !expiresIn || !interval) {
      throw new GitHubPrError('configuration', t('GitHub App 未启用设备授权，或配置有误'));
    }
    this.assertCurrent(generation);
    const now = this.now();
    this.pending = { deviceCode, userCode, verificationUrl, expiresAt: now + expiresIn * 1000,
      interval: interval * 1000, nextPoll: now + interval * 1000 };
    return this.connection();
  }

  private async poll(pending: DeviceCode, generation: number): Promise<void> {
    const clientId = this.appSetup().active!.clientId;
    pending.nextPoll = this.now() + pending.interval;
    const data = await this.post('/login/oauth/access_token', {
      client_id: clientId, device_code: pending.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    });
    if (this.pending !== pending || generation !== this.generation) return;
    if (data.error === 'authorization_pending') return;
    if (data.error === 'slow_down') {
      pending.interval = Math.max(pending.interval + 5000, (seconds(data.interval) ?? 0) * 1000);
      pending.nextPoll = this.now() + pending.interval;
      return;
    }
    if (data.error || !token(data.access_token)) {
      this.pending = null;
      throw new GitHubPrError('auth', t('GitHub 授权未完成，请重新连接'));
    }
    const tokens = this.tokens(data);
    try {
      const response = await githubFetch(this.options.fetcher, 'https://api.github.com/user',
        { headers: { Authorization: `Bearer ${tokens.access}`, 'User-Agent': 'Muster' } });
      if (!response.ok) throw githubStatusError(response);
      const login = string((await readGitHubJson(response)).login);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(login)) throw new GitHubPrError('auth', t('无法确认 GitHub 登录账号'));
      // The device code is single-use. Keep cancellation effective while resolving the viewer.
      if (this.pending === pending && generation === this.generation) this.store({ ...tokens, clientId, login });
    } finally { if (this.pending === pending) this.pending = null; }
  }

  private tokens(data: Record<string, unknown>): Tokens {
    const expiresIn = seconds(data.expires_in);
    return { access: token(data.access_token), refresh: token(data.refresh_token),
      expiresAt: expiresIn === null ? null : this.now() + expiresIn * 1000 };
  }

  async credentials(): Promise<{ login: string; token: string; generation: number }> {
    if (!this.appSetup().active) throw new GitHubPrError('configuration', t('请先配置 GitHub App'));
    const generation = this.generation;
    let current = this.current();
    if (!current) throw new GitHubPrError('auth', t('请先连接 GitHub'));
    if (current.expiresAt !== null && current.expiresAt <= this.now() + 60_000) {
      if (!this.refreshing) {
        const refreshing = this.refresh(current, generation).finally(() => { if (this.refreshing === refreshing) this.refreshing = null; });
        this.refreshing = refreshing;
      }
      current = await this.refreshing;
    }
    this.assertCurrent(generation);
    return { token: current.access, login: current.login, generation };
  }

  private async refresh(current: GitHubSession, generation: number): Promise<GitHubSession> {
    this.options.assertStorage();
    const data = current.refresh ? await this.post('/login/oauth/access_token', {
      client_id: current.clientId, grant_type: 'refresh_token', refresh_token: current.refresh
    }) : {};
    this.assertCurrent(generation);
    const tokens = this.tokens(data);
    if (!tokens.access || data.error) {
      this.disconnect();
      throw new GitHubPrError('auth', t('GitHub 登录已失效，请重新连接'));
    }
    const next = { ...current, ...tokens };
    this.store(next);
    return next;
  }

  assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new GitHubPrError('auth', t('GitHub 连接已变化，请重试'));
  }

  disconnect(): void {
    this.invalidate();
    if (this.session !== null) this.store(null);
  }

  private invalidate(): void {
    this.generation++;
    this.pending = null;
    this.starting = null;
    this.polling = null;
    this.refreshing = null;
  }

  private store(value: GitHubSession | null): void {
    this.options.save(value);
    this.session = value;
  }

  private async post(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await githubFetch(this.options.fetcher, `https://github.com${path}`, {
      method: 'POST', body: new URLSearchParams(params), headers: { Accept: 'application/json', 'User-Agent': 'Muster' }
    });
    if (!response.ok) throw githubStatusError(response);
    return readGitHubJson(response);
  }
}
