import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ExtensionSourceLayout, type ExtensionSourcePackage } from './extensionSourceLayout';
import type { ExtensionDevelopmentTrustSubject } from './extensionDevelopmentTrust';
import { SAMPLE_IDS, bundledSampleRoot, installBundledSamples } from './extensionSampleInstaller';
import { assertExtensionPackagePath, captureExtensionPackageAsync, fingerprintExtensionSnapshot, publishExtensionPackageDirectory, validateExtensionPackage, type ExtensionPackageSnapshot } from './extensionPackageSnapshot';
import type { ExtensionPackageCatalog } from './extensionPackageCatalog';
import { compareVersions } from '../metaAgent/hostSkillProvision';
import { EXTENSION_CENTER_CATEGORIES } from '../../shared/extensionCenter';
import type { ExtensionCenterCatalog, ExtensionCenterCatalogRelease, ExtensionCenterInstallResult, ExtensionCenterListing, ExtensionCenterPackageArtifact, ExtensionCenterRelease, ExtensionCenterUninstallResult } from '../../shared/extensionCenter';
export type { ExtensionCenterCatalog, ExtensionCenterCatalogRelease, ExtensionCenterInstallResult, ExtensionCenterPackageArtifact, ExtensionCenterRelease, ExtensionCenterUninstallResult } from '../../shared/extensionCenter';

interface ExtensionCenterServiceOptions {
  catalogUrl?: string | null;
  communityCatalogUrl?: string;
  token?: string;
  hostVersion?: string;
  fetchImpl?: typeof fetch;
  /** Override the remote catalog freshness window (primarily for focused tests). */
  catalogTtlMs?: number;
  /** Injectable clock keeps cache expiry deterministic without sleeping in tests. */
  now?: () => number;
}

export interface ExtensionCenterListOptions { force?: boolean }

const DEFAULT_CATALOG_TTL_MS = 30_000;

export const DEFAULT_EXTENSION_CENTER_URL = 'https://api.github.com/repos/zhanghexie/muster-extension-index/contents/catalog.json?ref=main';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const PACKAGE_FINGERPRINT = /^package-extension:[a-f0-9]{64}$/;
const NUMERIC_VERSION = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
// Consume the launch credential before child runtimes inherit the environment.
const launchToken = process.env.MUSTER_EXTENSION_CENTER_GITHUB_TOKEN?.trim() || undefined;
delete process.env.MUSTER_EXTENSION_CENTER_GITHUB_TOKEN;
class ExtensionCenterAccessError extends Error {}

function githubContentsOwner(url: URL): string | undefined {
  if (url.origin !== GITHUB_API_ORIGIN || url.username || url.password) return undefined;
  return /^\/repos\/([\w-]+)\/[\w.-]+\/contents\/.+$/i.exec(url.pathname)?.[1].toLowerCase();
}

/** Static catalog service with scoped authentication for private GitHub repositories. */
export class ExtensionCenterService {
  private readonly catalogUrl: string | undefined;
  private readonly token: string | undefined;
  private readonly hostVersion: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly catalogTtlMs: number;
  private readonly now: () => number;
  private community?: ExtensionCenterService;
  private remoteCache?: { catalog: ExtensionCenterCatalog; loadedAt: number };
  private remoteFlight?: Promise<ExtensionCenterCatalog>;
  constructor(private readonly userData: string, private readonly globalRoot: string, private readonly catalog: ExtensionPackageCatalog, options: ExtensionCenterServiceOptions = {}) {
    this.catalogUrl = options.catalogUrl === null ? undefined : options.catalogUrl ?? (process.env.MUSTER_EXTENSION_CENTER_LOCAL === '1' ? undefined : process.env.MUSTER_EXTENSION_CENTER_URL?.trim() || DEFAULT_EXTENSION_CENTER_URL);
    this.token = options.token ?? launchToken;
    this.hostVersion = options.hostVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.catalogTtlMs = Number.isFinite(options.catalogTtlMs) ? Math.max(0, options.catalogTtlMs!) : DEFAULT_CATALOG_TTL_MS;
    this.now = options.now ?? Date.now;
    this.setCommunityCatalogUrl(options.communityCatalogUrl);
  }
  setCommunityCatalogUrl(url?: string): void {
    if (this.catalogUrl !== DEFAULT_EXTENSION_CENTER_URL) return;
    this.community = url ? new ExtensionCenterService(this.userData, this.globalRoot, this.catalog, {
      catalogUrl: url, token: '', hostVersion: this.hostVersion, fetchImpl: this.fetchImpl, catalogTtlMs: this.catalogTtlMs, now: this.now,
    }) : undefined;
  }
  async list(options: ExtensionCenterListOptions = {}): Promise<ExtensionCenterRelease[]> {
    return (await this.listCatalog(options)).releases;
  }
  isVerifiedRelease(subject: ExtensionDevelopmentTrustSubject): boolean {
    if (subject.scope !== 'global') return false;
    const installed = this.catalog.get('global', subject.extensionId);
    return !!installed?.officialRelease && installed.directory === subject.directory && installed.fingerprint === subject.fingerprint
      && this.supportsHost(installed.officialRelease.minHostVersion);
  }

  /** Recognize packages installed before release provenance was persisted. */
  async verifyInstalledRelease(subject: ExtensionDevelopmentTrustSubject): Promise<boolean> {
    if (this.catalogUrl !== DEFAULT_EXTENSION_CENTER_URL || subject.scope !== 'global' || SAMPLE_IDS.some(id => id === subject.extensionId)) return false;
    const installed = this.catalog.get('global', subject.extensionId);
    if (installed?.directory !== subject.directory || installed.fingerprint !== subject.fingerprint) return false;
    let index: ExtensionCenterCatalog;
    try { index = await this.readRemoteCatalogSingleFlight(false); }
    catch { return false; }
    const release = index.releases.find(item => item.extensionId === subject.extensionId && item.fingerprint === subject.fingerprint);
    if (!release || !this.isOfficialIndexEntry(release) || !this.supportsHost(release.minHostVersion)) return false;
    // The network check can take time. Recheck bytes before recording trust.
    const pkg = await this.catalog.discover({ scope: 'global', extensionId: subject.extensionId });
    if (pkg.fingerprint !== release.fingerprint || pkg.manifest.version !== release.version || pkg.descriptor.directory !== subject.directory) return false;
    await this.recordCenterInstall(pkg, release);
    return this.isVerifiedRelease(subject);
  }

  private supportsHost(minHostVersion?: string): boolean {
    return !minHostVersion || !!this.hostVersion && compareVersions(this.hostVersion, minHostVersion) >= 0;
  }

  private isOfficialIndexEntry(release: ExtensionCenterCatalogRelease): boolean {
    if (this.catalogUrl !== DEFAULT_EXTENSION_CENTER_URL || release.publisherId !== 'muster') return false;
    const url = new URL(release.packageUrl);
    return githubContentsOwner(url) === 'zhanghexie'
      && url.pathname.startsWith(`/repos/zhanghexie/muster-extension-${release.extensionId}/contents/releases/`)
      && /^[a-f0-9]{40}$/i.test(url.searchParams.get('ref') ?? '');
  }

  private async recordCenterInstall(pkg: ExtensionSourcePackage, release: ExtensionCenterCatalogRelease): Promise<void> {
    if (pkg.manifest.scope !== 'global') return;
    // Download provenance and permission to run are independent.
    const officialRelease = this.isOfficialIndexEntry(release) && !pkg.manifest.agent?.mcp.length
      ? { minHostVersion: release.minHostVersion }
      : undefined;
    try { await this.catalog.register(pkg, true, { officialRelease }); }
    catch (error) { console.warn('[extension-center] install source could not be persisted:', error); }
  }

  async listCatalog(options: ExtensionCenterListOptions = {}): Promise<ExtensionCenterListing> {
    if (!this.community) return this.listPrimaryCatalog(options);
    const [primary, community] = await Promise.all([this.listPrimaryCatalog(options), this.community.listCatalog(options)]);
    const officialIds = new Set(primary.releases.map(release => release.extensionId));
    return { ...primary, releases: [...primary.releases, ...community.releases.filter(release => release.packageUrl && !officialIds.has(release.extensionId))] };
  }

  private async listPrimaryCatalog(options: ExtensionCenterListOptions): Promise<ExtensionCenterListing> {
    if (!this.catalogUrl) return { source: 'bundled', releases: await this.listBundled() };
    const cached = this.remoteCache;
    let catalog: ExtensionCenterCatalog;
    try {
      catalog = await this.readRemoteCatalogSingleFlight(options.force === true);
    } catch (error) {
      if (!cached) {
        if (error instanceof ExtensionCenterAccessError) throw error;
        console.warn(`[extension-center] remote catalog unavailable, using bundled fallback: ${error instanceof Error ? error.message : String(error)}`);
        return { source: 'bundled', releases: await this.listBundled() };
      }
      console.warn(`[extension-center] remote catalog unavailable, using cached catalog: ${error instanceof Error ? error.message : String(error)}`);
      catalog = cached.catalog;
    }
    const url = new URL(this.catalogUrl);
    const source = url.protocol === 'file:' ? 'file' : githubContentsOwner(url) ? 'github' : 'remote';
    return { source, releases: catalog.releases.map(release => this.decorate(release)) };
  }
  async install(packageKey: string): Promise<ExtensionCenterInstallResult> {
    const release = (await this.list()).find(item => item.packageKey === packageKey);
    if (!release) throw new Error('Extension center release was not found');
    if (release.packageUrl) {
      if (!release.sha256) throw new Error('Extension package SHA-256 is missing');
      return this.installRemote({ ...release, packageUrl: release.packageUrl, sha256: release.sha256 });
    }
    const update = release.installed && release.installedVersion !== release.version;
    if (release.installed && !update) return { packageKey, extensionId: release.extensionId, installed: true, skipped: true, updated: false };
    return this.installBundled(release, update);
  }
  async uninstall(packageKey: string): Promise<ExtensionCenterUninstallResult> {
    const release = (await this.list()).find(item => item.packageKey === packageKey);
    if (!release) throw new Error('Extension center release was not found');
    if (!release.installed) return { packageKey, extensionId: release.extensionId, uninstalled: false, skipped: true };
    const target = new ExtensionSourceLayout({ userData: this.userData, globalRoot: this.globalRoot }).global(release.extensionId).directory;
    const installed = await this.currentInstalled(target);
    if (!installed) return { packageKey, extensionId: release.extensionId, uninstalled: false, skipped: true };
    if (installed.fingerprint !== release.fingerprint) throw new Error('当前扩展内容与中心版本不一致，请先恢复中心版本后再卸载');
    await fs.promises.rm(target, { recursive: true, force: false });
    return { packageKey, extensionId: release.extensionId, uninstalled: true, skipped: false };
  }
  private async listBundled(): Promise<ExtensionCenterRelease[]> {
    const sourceRoot = bundledSampleRoot();
    if (!sourceRoot) return [];
    const sourceLayout = new ExtensionSourceLayout({ userData: this.userData, globalRoot: sourceRoot });
    const releases: ExtensionCenterRelease[] = [];
    for (const extensionId of SAMPLE_IDS) {
      try {
        const source = await sourceLayout.discover({ scope: 'global', extensionId });
        const installed = this.catalog.get('global', extensionId);
        releases.push({ packageKey: `muster/${extensionId}`, publisherId: 'muster', extensionId, name: source.manifest.name, category: 'productivity', ...(source.manifest.description ? { description: source.manifest.description } : {}), version: source.manifest.version ?? '0.0.0', fingerprint: source.fingerprint, sourceKind: 'center', installed: !!installed, ...(installed?.version ? { installedVersion: installed.version } : {}) });
      } catch { /* Invalid bundled packages are surfaced by existing diagnostics. */ }
    }
    return releases;
  }
  private async installBundled(release: ExtensionCenterRelease, update: boolean): Promise<ExtensionCenterInstallResult> {
    const sourceRoot = bundledSampleRoot();
    if (!sourceRoot) throw new Error('Local extension center catalog is unavailable');
    const result = await installBundledSamples(this.userData, this.globalRoot, sourceRoot, [release.extensionId], { overwriteExisting: update });
    const error = result.errors.find(item => item.extensionId === release.extensionId);
    if (error) return { packageKey: release.packageKey, extensionId: release.extensionId, installed: false, skipped: false, updated: false, error: error.error };
    return { packageKey: release.packageKey, extensionId: release.extensionId, installed: result.installed.includes(release.extensionId), skipped: result.skipped.includes(release.extensionId), updated: update && result.installed.includes(release.extensionId) };
  }
  private async installRemote(release: ExtensionCenterCatalogRelease): Promise<ExtensionCenterInstallResult> {
    if (!this.supportsHost(release.minHostVersion)) {
      throw new Error(`This extension requires Muster ${release.minHostVersion} or later`);
    }
    const descriptor = this.catalog.layout.global(release.extensionId);
    const target = descriptor.directory;
    const current = await this.currentInstalled(target);
    if (current?.fingerprint === release.fingerprint) {
      const pkg = await this.catalog.discover({ scope: 'global', extensionId: release.extensionId });
      if (pkg.fingerprint === release.fingerprint && pkg.manifest.version === release.version) {
        await this.recordCenterInstall(pkg, release);
      }
      return { packageKey: release.packageKey, extensionId: release.extensionId, installed: true, skipped: true, updated: false };
    }
    if (current && !release.previousFingerprints?.includes(current.fingerprint)) {
      throw new Error('A local extension with the same ID has different contents. Export or move that copy before installing the center release.');
    }
    const response = await this.fetchResource(release.packageUrl, 256 * 1024 * 1024, 30_000);
    if (!response.ok) throw new Error(`Extension package download failed (${response.status})`);
    const bytes = await boundedBytes(response, 256 * 1024 * 1024);
    if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Extension package SHA-256 does not match catalog');
    const artifact = parseArtifact(bytes);
    if (artifact.extensionId !== release.extensionId || artifact.fingerprint !== release.fingerprint) throw new Error('Extension package identity does not match catalog');
    const snapshot: ExtensionPackageSnapshot = { directories: artifact.directories, files: artifact.files.map(file => ({ path: file.path, bytes: Buffer.from(file.bytesBase64, 'base64'), executable: !!file.executable })), excluded: [], fingerprint: artifact.fingerprint };
    if (fingerprintExtensionSnapshot(snapshot) !== release.fingerprint) throw new Error('Extension package fingerprint does not match catalog');
    const manifest = validateExtensionPackage(snapshot, release.extensionId);
    if (manifest.version !== release.version) throw new Error('Extension manifest version does not match catalog');
    await fs.promises.mkdir(this.globalRoot, { recursive: true });
    await publishExtensionPackageDirectory(target, snapshot, { root: this.globalRoot, ...(current ? { expectedFingerprint: current.fingerprint } : {}) });
    await this.recordCenterInstall({ descriptor, manifest, fingerprint: snapshot.fingerprint, files: snapshot.files.map(file => file.path) }, release);
    return { packageKey: release.packageKey, extensionId: release.extensionId, installed: true, skipped: false, updated: !!current };
  }
  private async currentInstalled(directory: string): Promise<ExtensionPackageSnapshot | undefined> {
    try { return await captureExtensionPackageAsync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private decorate(release: ExtensionCenterCatalogRelease): ExtensionCenterRelease {
    const installed = this.catalog.get('global', release.extensionId);
    return { ...release, sourceKind: 'center', installed: !!installed, ...(installed?.version ? { installedVersion: installed.version } : {}) };
  }
  private async readRemoteCatalogSingleFlight(force: boolean): Promise<ExtensionCenterCatalog> {
    const cached = this.remoteCache;
    if (!force && cached && this.now() - cached.loadedAt < this.catalogTtlMs) return cached.catalog;
    if (this.remoteFlight) return this.remoteFlight;
    const request = this.readRemoteCatalog();
    this.remoteFlight = request;
    try {
      const remote = await request;
      this.remoteCache = { catalog: remote, loadedAt: this.now() };
      return remote;
    } finally {
      if (this.remoteFlight === request) this.remoteFlight = undefined;
    }
  }
  private async readRemoteCatalog(): Promise<ExtensionCenterCatalog> {
    if (!this.catalogUrl) throw new Error('Extension center catalog is not configured');
    const catalogUrl = new URL(this.catalogUrl);
    const githubOwner = githubContentsOwner(catalogUrl);
    const response = await this.fetchResource(this.catalogUrl, 4 * 1024 * 1024, 5_000);
    if (!response.ok) {
      if (githubOwner && [401, 403, 404].includes(response.status)) {
        throw new ExtensionCenterAccessError(`GitHub extension catalog is inaccessible (${response.status}). Set MUSTER_EXTENSION_CENTER_GITHUB_TOKEN to a GitHub token with Contents read access and restart Muster.`);
      }
      throw new Error(`Extension center catalog request failed (${response.status})`);
    }
    let raw: unknown;
    try { raw = JSON.parse(await boundedText(response, 4 * 1024 * 1024)); } catch { throw new Error('Extension center catalog is not valid JSON'); }
    if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== 1 || !Array.isArray((raw as { releases?: unknown }).releases)) throw new Error('Extension center catalog schema is invalid');
    const extensionIds = new Set<string>();
    const releases = (raw as { releases: unknown[] }).releases.map(validateRelease).map(release => {
      const packageUrl = new URL(release.packageUrl);
      if (packageUrl.origin !== catalogUrl.origin) throw new Error('Extension package URL must use the catalog origin');
      if (githubOwner && githubContentsOwner(packageUrl) !== githubOwner) throw new Error('Extension package URL must use the catalog GitHub owner and Contents API');
      if (release.screenshots?.some(screenshot => new URL(screenshot).origin !== catalogUrl.origin)) throw new Error('Extension screenshot URL must use the catalog origin');
      if (extensionIds.has(release.extensionId)) throw new Error(`Duplicate extension ID in catalog: ${release.extensionId}`);
      extensionIds.add(release.extensionId);
      return release;
    });
    return { schemaVersion: 1, releases };
  }
  private fetchResource(url: string, maxBytes: number, timeoutMs: number): Promise<Response> {
    if (url.startsWith('file://')) return readLocalResource(url, maxBytes);
    const owner = githubContentsOwner(new URL(url));
    const catalogOwner = this.catalogUrl && githubContentsOwner(new URL(this.catalogUrl));
    const headers = new Headers({ Accept: owner ? 'application/vnd.github.raw+json' : 'application/json' });
    if (owner && owner === catalogOwner && this.token) headers.set('Authorization', `Bearer ${this.token}`);
    return this.fetchImpl(url, { headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  }
}

function validateRelease(value: unknown): ExtensionCenterCatalogRelease {
  if (!value || typeof value !== 'object') throw new Error('Extension center release is invalid');
  const input = value as Record<string, unknown>;
  const text = (key: string, max = 512): string => { const item = input[key]; if (typeof item !== 'string' || !item || item.length > max || item.includes('\0')) throw new Error(`Extension center release ${key} is invalid`); return item; };
  const optionalText = (key: string, max: number): string | undefined => input[key] === undefined ? undefined : text(key, max);
  const optionalUrl = (key: string): string | undefined => {
    const value = optionalText(key, 4096);
    if (value && !/^https:\/\//i.test(value) && !/^file:\/\//i.test(value)) throw new Error(`Extension center release ${key} must use https or file`);
    return value;
  };
  const packageUrl = text('packageUrl', 4096);
  if (!/^https?:\/\//i.test(packageUrl) && !/^file:\/\//i.test(packageUrl)) throw new Error('Extension package URL must use http(s) or file');
  const sha256 = text('sha256', 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Extension package SHA-256 is invalid');
  const fingerprint = text('fingerprint', 128);
  if (!PACKAGE_FINGERPRINT.test(fingerprint)) throw new Error('Extension package fingerprint is invalid');
  const previousFingerprints = input.previousFingerprints;
  if (previousFingerprints !== undefined && (!Array.isArray(previousFingerprints) || previousFingerprints.length > 100
    || previousFingerprints.some(value => typeof value !== 'string' || !PACKAGE_FINGERPRINT.test(value)))) {
    throw new Error('Extension center release previousFingerprints is invalid');
  }
  const minHostVersion = optionalText('minHostVersion', 128);
  if (minHostVersion && !NUMERIC_VERSION.test(minHostVersion)) throw new Error('Extension center release minHostVersion is invalid');
  const packageKey = text('packageKey');
  const publisherId = text('publisherId', 128), extensionId = text('extensionId', 128);
  if (packageKey !== `${publisherId}/${extensionId}` || !/^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9-]{0,63}$/.test(packageKey)) throw new Error('Extension center package identity is invalid');
  const updatedAt = optionalText('updatedAt', 64);
  if (updatedAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(updatedAt)) throw new Error('Extension center release updatedAt is invalid');
  const publisherName = optionalText('publisherName', 256);
  const publisherUrl = optionalUrl('publisherUrl');
  const repositoryUrl = optionalUrl('repositoryUrl');
  const homepageUrl = optionalUrl('homepageUrl');
  const license = optionalText('license', 128);
  const category = EXTENSION_CENTER_CATEGORIES.find(item => item === input.category);
  const releaseNotes = optionalText('releaseNotes', 16 * 1024);
  const readme = optionalText('readme', 128 * 1024);
  const screenshots = input.screenshots === undefined ? undefined : (() => {
    if (!Array.isArray(input.screenshots) || input.screenshots.length > 8) throw new Error('Extension center release screenshots are invalid');
    return input.screenshots.map((item, index) => {
      if (typeof item !== 'string' || !item || item.length > 4096 || (!/^https:\/\//i.test(item) && !/^file:\/\//i.test(item))) throw new Error(`Extension center release screenshots[${index}] is invalid`);
      return item;
    });
  })();
  return {
    packageKey,
    publisherId,
    extensionId,
    name: text('name'),
    ...(category ? { category } : {}),
    ...(input.description === undefined ? {} : { description: text('description', 4096) }),
    version: text('version', 128),
    fingerprint,
    ...(previousFingerprints ? { previousFingerprints } : {}),
    packageUrl,
    sha256,
    ...(minHostVersion ? { minHostVersion } : {}),
    ...(publisherName ? { publisherName } : {}),
    ...(publisherUrl ? { publisherUrl } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(homepageUrl ? { homepageUrl } : {}),
    ...(license ? { license } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(readme ? { readme } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(screenshots ? { screenshots } : {})
  };
}

function parseArtifact(bytes: Buffer): ExtensionCenterPackageArtifact {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { return parseZipArtifact(bytes); }
  if (!raw || typeof raw !== 'object') throw new Error('Extension package artifact is invalid');
  const artifact = raw as Partial<ExtensionCenterPackageArtifact>;
  if (artifact.schemaVersion !== 1 || typeof artifact.extensionId !== 'string' || typeof artifact.fingerprint !== 'string' || !Array.isArray(artifact.directories) || !Array.isArray(artifact.files)) throw new Error('Extension package artifact schema is invalid');
  const directories = artifact.directories.map(directory => { if (typeof directory !== 'string') throw new Error('Extension package artifact directory is invalid'); assertExtensionPackagePath(directory); return directory; });
  const files = artifact.files.map(file => { if (!file || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.bytesBase64 !== 'string') throw new Error('Extension package artifact file is invalid'); assertExtensionPackagePath(file.path); const bytes = Buffer.from(file.bytesBase64, 'base64'); if (!bytes.length && file.bytesBase64) throw new Error('Extension package artifact file encoding is invalid'); return { path: file.path, bytesBase64: bytes.toString('base64'), ...(file.executable ? { executable: true } : {}) }; });
  return { schemaVersion: 1, extensionId: artifact.extensionId, fingerprint: artifact.fingerprint, directories, files };
}

function parseZipArtifact(bytes: Buffer): ExtensionCenterPackageArtifact {
  const directories: string[] = [], files: Array<{ path: string; bytesBase64: string }> = [];
  let total = 0;
  const eocd = findZipEnd(bytes);
  if (!eocd) throw new Error('Extension package artifact is not valid JSON or ZIP');
  const count = bytes.readUInt16LE(eocd + 10), directorySize = bytes.readUInt32LE(eocd + 12), directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (directoryOffset + directorySize > bytes.length || count > 20_000) throw new Error('Extension package ZIP directory is invalid');
  let cursor = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Extension package ZIP directory is invalid');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), compressedSize = bytes.readUInt32LE(cursor + 20), uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), localOffset = bytes.readUInt32LE(cursor + 42);
    if (flags & 1 || compressedSize > 256 * 1024 * 1024 || uncompressedSize > 256 * 1024 * 1024) throw new Error('Extension package ZIP entry is unsupported');
    const rawPath = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const normalized = rawPath.replace(/\\/g, '/');
    if (normalized.endsWith('/')) { const directory = normalized.slice(0, -1); if (directory) { assertExtensionPackagePath(directory); directories.push(directory); } }
    else {
      assertExtensionPackagePath(normalized);
      if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Extension package ZIP entry is invalid');
      const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28), dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
      const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : undefined;
      if (!content || content.length !== uncompressedSize) throw new Error('Extension package ZIP compression is unsupported');
      total += content.length;
      if (files.length >= 20_000 || total > 256 * 1024 * 1024) throw new Error('Extension package exceeds capture limits');
      files.push({ path: normalized, bytesBase64: Buffer.from(content).toString('base64') });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!files.some(file => file.path === 'extension.json')) throw new Error('Extension package manifest is missing');
  let extensionId: string;
  try {
    const manifest = JSON.parse(Buffer.from(files.find(file => file.path === 'extension.json')!.bytesBase64, 'base64').toString('utf8')) as { id?: unknown };
    if (typeof manifest.id !== 'string' || !manifest.id) throw new Error('missing id');
    extensionId = manifest.id;
  } catch { throw new Error('Extension package manifest is not valid JSON'); }
  const snapshot: ExtensionPackageSnapshot = { directories, files: files.map(file => ({ path: file.path, bytes: Buffer.from(file.bytesBase64, 'base64'), executable: false })), excluded: [], fingerprint: '' };
  snapshot.fingerprint = fingerprintExtensionSnapshot(snapshot);
  return { schemaVersion: 1, extensionId, fingerprint: snapshot.fingerprint, directories, files };
}

function findZipEnd(bytes: Buffer): number | undefined {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset--) if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  return undefined;
}

export async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error('Extension package exceeds download limit');
  const reader = response.body?.getReader();
  if (!reader) { const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > maxBytes) throw new Error('Extension package exceeds download limit'); return bytes; }
  const chunks: Buffer[] = []; let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error('Extension package exceeds download limit'); }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  return (await boundedBytes(response, maxBytes)).toString('utf8');
}

async function readLocalResource(url: string, maxBytes: number): Promise<Response> {
  try {
    const file = fileURLToPath(new URL(url));
    const bytes = await fs.promises.readFile(file);
    if (bytes.length > maxBytes) return new Response('Resource too large', { status: 413 });
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  } catch { return new Response('Resource not found', { status: 404 }); }
}
