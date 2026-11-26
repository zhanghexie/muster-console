import { app, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parsePublishingOrigin } from '../../shared/extensionPublishing';
import type { ExtensionPublishingSession, ExtensionSubmission, ExtensionSubmissionReview } from '../../shared/extensionPublishing';
import { compareVersions } from '../metaAgent/hostSkillProvision';
import { boundedBytes, ExtensionCenterService } from './extensionCenter';
import { ExtensionPackageCatalog } from './extensionPackageCatalog';
import { captureExtensionPackageAsync, encodeExtensionPackage, fingerprintExtensionSnapshotAsync, validateExtensionPackage } from './extensionPackageSnapshot';
import { ExtensionSourceLayout } from './extensionSourceLayout';

const maxPackage = 25 * 1024 * 1024;
const versionPattern = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/;
const trialEnv = /^(PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY|USERPROFILE|APPDATA|LOCALAPPDATA)$/i;

export function configuredPublishingOrigin(): URL | undefined {
  const configured = process.env.MUSTER_EXTENSION_PUBLISH_URL?.trim();
  if (!configured) return undefined;
  return parsePublishingOrigin(configured);
}

export function approvedCommunityCatalogUrl(): string | undefined {
  try {
    const origin = configuredPublishingOrigin();
    return origin && new URL('/catalog.json', origin).href;
  } catch { return undefined; }
}

export class ExtensionPublishingClient {
  private signInFlight?: Promise<ExtensionPublishingSession>;

  constructor(private readonly layout: ExtensionSourceLayout, private readonly origin?: URL, private token?: string) {}

  private async request(route: string, data?: unknown, timeout = 30_000): Promise<Response> {
    if (!this.origin) throw new Error('Extension publishing is not configured');
    const response = await fetch(new URL(route, this.origin), {
      method: data === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401) this.token = undefined;
      const { error } = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(error ?? `Extension publishing request failed (${response.status})`);
    }
    return response;
  }

  private async json<T>(route: string, data?: unknown, timeout?: number): Promise<T> {
    return (await this.request(route, data, timeout)).json() as Promise<T>;
  }

  async session(): Promise<ExtensionPublishingSession> {
    return this.origin ? { ...await this.json<Omit<ExtensionPublishingSession, 'available'>>('/session', undefined, 5000), available: true }
      : { available: false, reviewer: false };
  }

  signIn(): Promise<ExtensionPublishingSession> {
    return this.signInFlight ??= this.signInGitHub().finally(() => { this.signInFlight = undefined; });
  }

  private async signInGitHub(): Promise<ExtensionPublishingSession> {
    const { url, poll } = await this.json<{ url: string; poll: string }>('/login/start', {});
    const authorize = new URL(url);
    if (authorize.origin !== 'https://github.com' || authorize.pathname !== '/login/oauth/authorize' || authorize.username || authorize.password) {
      throw new Error('Invalid GitHub authorization address');
    }
    await shell.openExternal(authorize.href);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const result = await this.json<{ token?: string }>('/login/finish', { poll });
      if (result.token) { this.token = result.token; return this.session(); }
      await delay(1500);
    }
    throw new Error('GitHub sign-in expired');
  }

  async authorizeRepository(): Promise<void> {
    const { installUrl } = await this.session();
    if (!installUrl || !/^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(installUrl)) throw new Error('GitHub App installation is not configured');
    await shell.openExternal(installUrl);
  }

  mine(): Promise<ExtensionSubmission[]> { return this.json('/mine'); }
  queue(): Promise<ExtensionSubmission[]> { return this.json('/review'); }
  review(id: string): Promise<ExtensionSubmissionReview> { return this.json(`/review/${encodeURIComponent(id)}`); }

  async submit(extensionId: string, repository: string): Promise<ExtensionSubmission> {
    const packageInfo = await this.layout.discover({ scope: 'global', extensionId });
    const snapshot = await captureExtensionPackageAsync(packageInfo.descriptor.directory);
    const manifest = validateExtensionPackage(snapshot, extensionId);
    const previous = (await this.mine()).filter(row => row.extensionId === extensionId).at(-1);
    const sourceFingerprint = snapshot.fingerprint;
    let version = manifest.version ?? '1.0.0';
    if (!versionPattern.test(version)) throw new Error('Use a release version in X.Y.Z format');
    if (previous && compareVersions(version, previous.version) <= 0) {
      const [major, minor, patch] = previous.version.split('.').map(Number);
      version = previous.sourceFingerprint === sourceFingerprint ? previous.version : `${major}.${minor}.${patch + 1}`;
    }
    if (version !== manifest.version) {
      const file = snapshot.files.find(entry => entry.path === 'extension.json')!;
      file.bytes = Buffer.from(`${JSON.stringify({ ...JSON.parse(file.bytes.toString('utf8').replace(/^\uFEFF/, '')), version }, null, 2)}\n`);
      snapshot.fingerprint = await fingerprintExtensionSnapshotAsync(snapshot);
    }
    const artifact = encodeExtensionPackage(extensionId, snapshot);
    if (artifact.length > maxPackage) throw new Error('Extension package exceeds the 25 MiB limit');
    return this.json('/submit', { repository, version, artifact: artifact.toString('utf8'), sourceFingerprint }, 180_000);
  }

  async trial(id: string): Promise<void> {
    const { report: { release } } = await this.review(id);
    const response = await this.request(`/review/${encodeURIComponent(id)}/package`);
    const bytes = await boundedBytes(response, maxPackage);
    if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Candidate bytes changed');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-extension-trial-'));
    let launched = false;
    try {
      const userData = path.join(root, '.dev-sandbox', 'userData');
      const layout = new ExtensionSourceLayout({ userData });
      const packageUrl = pathToFileURL(path.join(root, 'candidate.json')).href;
      const catalogPath = path.join(root, 'catalog.json');
      await fs.writeFile(path.join(root, 'candidate.json'), bytes);
      await fs.writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, releases: [{ ...release, packageUrl }] }));
      const catalog = new ExtensionPackageCatalog({ layout });
      try {
        const center = new ExtensionCenterService(userData, layout.globalRoot, catalog, { catalogUrl: pathToFileURL(catalogPath).href, hostVersion: app.getVersion() });
        const result = await center.install(release.packageKey);
        if (!result.installed) throw new Error(result.error ?? 'Candidate installation failed');
      } finally { catalog.close(); }

      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => trialEnv.test(key)));
      const child = spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env,
        MUSTER_SANDBOX: '1', MUSTER_EXTENSION_TRIAL_ROOT: root, MUSTER_EXTENSION_TRIAL_ID: release.extensionId,
        MUSTER_EXTENSION_CENTER_URL: pathToFileURL(catalogPath).href,
      } });
      let diagnostics = '';
      child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-3000); });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      launched = true;
      child.once('close', () => void fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}));
      const deadline = Date.now() + 25_000;
      while (await fs.readFile(path.join(root, 'window-ready'), 'utf8').catch(() => '') !== release.extensionId) {
        if (child.exitCode !== null || child.signalCode || Date.now() >= deadline) {
          if (child.exitCode === null && !child.signalCode) child.kill();
          console.error('[extension-trial] window did not open', diagnostics);
          throw new Error('The trial window could not be opened');
        }
        await delay(150);
      }
      await this.json(`/review/${encodeURIComponent(id)}/trial`, { sha256: release.sha256 });
    } catch (error) {
      // An already running trial owns its profile until that instance exits.
      if (!launched) await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async decide(id: string, decision: 'approve' | 'return', reason?: string): Promise<ExtensionSubmission> {
    const { report } = await this.review(id);
    return this.json(`/review/${encodeURIComponent(id)}/${decision}`, { sha256: report.release.sha256, reason });
  }
}
