import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionManifest } from '../../shared/extension';
import { captureExtensionPackageAsync, fingerprintExtensionSnapshot, saveExtensionPackageSnapshot, extensionSafetyEvidence, validateExtensionPackage } from './extensionPackageSnapshot';
import type { ExtensionPackageSnapshot } from './extensionPackageSnapshot';
import { checkExtensionPackageSyntax } from './extensionSyntax';

export interface ExtensionReviewCandidate {
  workspaceId: string;
  id: string;
  directory: string;
  expectedFingerprint?: string;
  signal?: AbortSignal;
  /** Covers revocation, deleted roots and changed caller ownership. */
  isCurrent?: () => boolean;
  isCurrentAsync?: () => Promise<boolean>;
}
export type ExtensionReviewDecision = { approved: true } | { approved: false; reason: string };
export type ExtensionReviewResult =
  | { status: 'approved'; fingerprint: string; snapshotDirectory: string; reused: boolean }
  | { status: 'rejected'; fingerprint: string; reason: string; reused: boolean }
  | { status: 'stale'; fingerprint: string; reason: string };
export interface ExtensionReviewRequest {
  candidate: ExtensionReviewCandidate;
  manifest: ExtensionManifest;
  snapshot: ExtensionPackageSnapshot;
  evidence?: string;
  evidenceError?: string;
  signal: AbortSignal;
}
type ReviewRecord = { decision: 'approved' | 'rejected'; reason?: string; fingerprint: string; timestamp: number };

function reviewKey(workspaceId: string, manifest: ExtensionManifest, fingerprint: string): string {
  const binding = manifest.project?.kind === 'relative' ? ['relative', manifest.project.path]
    : manifest.project?.kind === 'mapped' ? ['mapped', manifest.project.key] : null;
  return createHash('sha256').update(JSON.stringify([manifest.scope, manifest.id, fingerprint,
    manifest.scope === 'project' ? workspaceId : null, binding])).digest('hex');
}

/** Local review decisions. Invalid or unreadable records fail closed. */
export class ExtensionReviewStore {
  private records: Record<string, ReviewRecord>;
  constructor(private file: string) {
    if (!fs.existsSync(file)) { this.records = {}; return; }
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Extension review store is invalid');
    const document = value as { version?: unknown; records?: unknown };
    if (document.version !== 1 || !document.records || typeof document.records !== 'object' || Array.isArray(document.records)) throw new Error('Extension review store is invalid');
    this.records = {};
    for (const [key, raw] of Object.entries(document.records)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Extension review record is invalid');
      const record = raw as ReviewRecord;
      if (!['approved', 'rejected'].includes(record.decision) || !/^package-extension:[a-f0-9]{64}$/.test(record.fingerprint) || !Number.isFinite(record.timestamp) || (record.reason !== undefined && typeof record.reason !== 'string')) throw new Error('Extension review record is invalid');
      this.records[key] = record;
    }
  }
  get(key: string): ReviewRecord | undefined { return this.records[key]; }
  put(key: string, record: ReviewRecord): void {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^package-extension:[a-f0-9]{64}$/.test(record.fingerprint)) throw new Error('Invalid extension review identity');
    const next = { ...this.records, [key]: record };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: next }, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.records = next;
    } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
  }
}

/** Coalesces equal versions while independently rechecking every source. */
export class ExtensionReviewCoordinator {
  private inFlight = new Map<string, { promise: Promise<ExtensionReviewDecision>; controller: AbortController; users: number }>();
  private readonly reviewers = new Set<Promise<ExtensionReviewDecision>>();
  private syntaxInFlight = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private syntaxChecked = new Set<string>();
  private observed = new Map<string, { fingerprint: string; generation: number }>();
  private cancelGeneration = 0;
  private invalidations = new Map<string, number>();
  constructor(private store: ExtensionReviewStore, private packages: string, private review: (request: ExtensionReviewRequest) => Promise<ExtensionReviewDecision>,
    private isBundled: (manifest: ExtensionManifest, snapshot: ExtensionPackageSnapshot) => boolean = () => false) {}

  decision(workspaceId: string, manifest: ExtensionManifest, fingerprint: string): ReviewRecord | undefined {
    return this.store.get(reviewKey(workspaceId, manifest, fingerprint));
  }

  isApproved(workspaceId: string, manifest: ExtensionManifest, fingerprint: string): boolean {
    const record = this.decision(workspaceId, manifest, fingerprint);
    return record?.decision === 'approved' && record.fingerprint === fingerprint;
  }

  invalidate(workspaceId: string, id: string): void {
    const source = JSON.stringify([workspaceId, id]);
    this.invalidations.set(source, (this.invalidations.get(source) ?? 0) + 1);
  }

  /** A change observed while scanning invalidates and cancels unfinished reviews. */
  async cancelPending(): Promise<void> {
    this.cancelGeneration++;
    this.observed.clear();
    const pending = [...this.inFlight.values()]; this.inFlight.clear();
    for (const item of pending) item.controller.abort();
    const syntax = [...this.syntaxInFlight.values()]; this.syntaxInFlight.clear();
    for (const item of syntax) item.controller.abort();
    await Promise.allSettled([...this.reviewers, ...syntax.map(item => item.promise)]);
  }

  private async checkSyntax(snapshot: ExtensionPackageSnapshot, signal?: AbortSignal): Promise<void> {
    if (this.syntaxChecked.has(snapshot.fingerprint)) return;
    let pending = this.syntaxInFlight.get(snapshot.fingerprint);
    if (!pending) {
      const controller = new AbortController();
      const promise = checkExtensionPackageSyntax(snapshot, controller.signal).then(() => {
        if (!controller.signal.aborted) {
          this.syntaxChecked.add(snapshot.fingerprint);
          if (this.syntaxChecked.size > 128) this.syntaxChecked.delete(this.syntaxChecked.values().next().value!);
        }
      });
      pending = { promise, controller }; this.syntaxInFlight.set(snapshot.fingerprint, pending);
      void promise.finally(() => { if (this.syntaxInFlight.get(snapshot.fingerprint) === pending) this.syntaxInFlight.delete(snapshot.fingerprint); }).catch(() => {});
    }
    if (!signal) { await pending.promise; return; }
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error('Extension syntax check was cancelled'));
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    });
    try { await Promise.race([pending.promise, cancelled]); }
    finally { signal.removeEventListener('abort', cancel); }
  }

  async submit(candidate: ExtensionReviewCandidate, options: { retryRejected?: boolean } = {}): Promise<ExtensionReviewResult> {
    if (!candidate.workspaceId || !candidate.id || !candidate.directory) throw new Error('Extension review candidate is missing an identity');
    const packageId = JSON.stringify([candidate.workspaceId, candidate.id]);
    const source = JSON.stringify([candidate.workspaceId, candidate.id, path.resolve(candidate.directory)]);
    const cancelGeneration = this.cancelGeneration;
    if (!this.observed.has(source)) this.observed.set(source, { fingerprint: '', generation: 0 });
    const captureInvalidation = this.invalidations.get(packageId) ?? 0;
    const invalidated = () => this.cancelGeneration !== cancelGeneration || (this.invalidations.get(packageId) ?? 0) !== captureInvalidation;
    const snapshot = await captureExtensionPackageAsync(candidate.directory);
    const manifest = validateExtensionPackage(snapshot, candidate.id);
    if (candidate.expectedFingerprint !== undefined && candidate.expectedFingerprint !== snapshot.fingerprint) throw new Error('Extension changed since it was opened for editing');
    if (candidate.signal?.aborted || invalidated() || (candidate.isCurrent && !candidate.isCurrent()))
      return { status: 'stale', fingerprint: snapshot.fingerprint, reason: '扩展或其所属项目在审核期间发生变化' };
    const previous = this.observed.get(source);
    const generation = previous?.fingerprint === snapshot.fingerprint ? previous.generation : (previous?.generation ?? 0) + 1;
    this.observed.set(source, { fingerprint: snapshot.fingerprint, generation });
    const key = reviewKey(candidate.workspaceId, manifest, snapshot.fingerprint);
    const stateCurrent = (): boolean => !candidate.signal?.aborted && !invalidated() && this.observed.get(source)?.generation === generation && (!candidate.isCurrent || candidate.isCurrent());
    const current = async (): Promise<boolean> => {
      if (!stateCurrent()) return false;
      try {
        if ((await captureExtensionPackageAsync(candidate.directory)).fingerprint !== snapshot.fingerprint || !stateCurrent()) return false;
        if (candidate.isCurrentAsync && !(await candidate.isCurrentAsync())) return false;
        return stateCurrent();
      } catch { return false; }
    };
    const stale = (): ExtensionReviewResult => ({ status: 'stale', fingerprint: snapshot.fingerprint, reason: '扩展或其所属项目在审核期间发生变化' });
    if (snapshot.files.some(file => /\.(mjs|cjs|js)$/i.test(file.path))) {
      try { await this.checkSyntax(snapshot, candidate.signal); }
      catch (error) { if (!(await current())) return stale(); throw error; }
      if (!(await current())) return stale();
    }
    const known = this.store.get(key);
    const activeReview = this.inFlight.get(key);
    if (this.isBundled(manifest, snapshot)) {
      if (!(await current())) return stale();
      // An older in-flight review cannot overwrite the product-owned decision.
      const superseded = this.inFlight.get(key);
      if (superseded) { superseded.controller.abort(); this.inFlight.delete(key); }
      const snapshotDirectory = await saveExtensionPackageSnapshot(this.packages, manifest.id, snapshot);
      if (!(await current()) || !this.isBundled(manifest, snapshot) || fingerprintExtensionSnapshot(snapshot) !== snapshot.fingerprint) return stale();
      const latest = this.store.get(key);
      if (latest?.decision !== 'approved') this.store.put(key, { decision: 'approved', fingerprint: snapshot.fingerprint, timestamp: Date.now() });
      return { status: 'approved', fingerprint: snapshot.fingerprint, snapshotDirectory, reused: latest?.decision === 'approved' };
    }
    if (known?.decision === 'rejected' && !options.retryRejected && !activeReview) {
      return await current() ? { status: 'rejected', fingerprint: snapshot.fingerprint, reason: known.reason ?? '审核未通过', reused: true } : stale();
    }
    if (known?.decision === 'approved') {
      if (!(await current())) return stale();
      const snapshotDirectory = await saveExtensionPackageSnapshot(this.packages, manifest.id, snapshot);
      return await current() ? { status: 'approved', fingerprint: snapshot.fingerprint, snapshotDirectory, reused: true } : stale();
    }
    let pending = activeReview;
    if (!pending) {
      let evidence: string | undefined;
      let evidenceError: string | undefined;
      try { evidence = extensionSafetyEvidence(snapshot); } catch (error) { evidenceError = String(error); }
      const controller = new AbortController();
      const request = { candidate, manifest, snapshot, evidence, evidenceError, signal: controller.signal };
      const promise = Promise.resolve().then(() => this.review(request));
      this.reviewers.add(promise);
      void promise.finally(() => this.reviewers.delete(promise)).catch(() => {});
      pending = { promise, controller, users: 0 };
      this.inFlight.set(key, pending);
    }
    const item = pending;
    item.users++;
    try {
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error('Extension review was cancelled'));
      if (item.controller.signal.aborted || candidate.signal?.aborted) cancel();
      else { item.controller.signal.addEventListener('abort', cancel, { once: true }); candidate.signal?.addEventListener('abort', cancel, { once: true }); }
    });
    let decision: ExtensionReviewDecision;
    try { decision = await Promise.race([item.promise, cancelled]); }
    catch (error) { if (item.controller.signal.aborted || candidate.signal?.aborted || !(await current())) return stale(); throw error; }
    finally { item.controller.signal.removeEventListener('abort', cancel); candidate.signal?.removeEventListener('abort', cancel); }
    if (item.controller.signal.aborted || !(await current()) || item.controller.signal.aborted || fingerprintExtensionSnapshot(snapshot) !== snapshot.fingerprint) return stale();
    if (!decision.approved) {
      const reason = String(decision.reason || '审核未通过').slice(0, 2000);
      this.store.put(key, { decision: 'rejected', reason, fingerprint: snapshot.fingerprint, timestamp: Date.now() });
      return { status: 'rejected', fingerprint: snapshot.fingerprint, reason, reused: false };
    }
    const snapshotDirectory = await saveExtensionPackageSnapshot(this.packages, manifest.id, snapshot);
    if (!(await current()) || item.controller.signal.aborted) return stale();
    this.store.put(key, { decision: 'approved', fingerprint: snapshot.fingerprint, timestamp: Date.now() });
    return { status: 'approved', fingerprint: snapshot.fingerprint, snapshotDirectory, reused: false };
    } finally {
      item.users--;
      if (item.users === 0 && this.inFlight.get(key) === item) {
        this.inFlight.delete(key);
        if (this.reviewers.has(item.promise)) item.controller.abort();
      }
    }
  }
}
