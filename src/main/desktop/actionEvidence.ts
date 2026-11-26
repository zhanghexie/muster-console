import { createHash } from 'node:crypto';
import { MAX_DESKTOP_GRANT_TTL_MS } from './grants';
import type { UnknownActionBoundary } from './unknownActionChain';

type EvidenceIdentity = Omit<UnknownActionBoundary, 'actionClass' | 'evidenceSha256'>;
type Entry = Readonly<EvidenceIdentity & { png: Buffer; sha256: string; expiresAt: number; sourceCurrent: () => boolean }>;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_ENTRIES = 32;

/** Host-only staging store. A trusted capture backend must own every registration. */
export class DesktopActionEvidence {
  private readonly entries = new Map<string, Entry>();
  private readonly generations = new Map<string, object>();
  private bytes = 0;
  constructor(private readonly decode: (png: Buffer) => Promise<{ width: number; height: number }>,
    private readonly now: () => number = Date.now) {
    if (typeof decode !== 'function' || typeof now !== 'function') throw new Error('Invalid evidence store');
  }

  private key(sessionId: string, taskId: string, captureId: string): string {
    if (![sessionId, taskId, captureId].every(value => typeof value === 'string' && !!value.trim() && value.length <= 256)) {
      throw new Error('Invalid evidence identity');
    }
    return JSON.stringify([sessionId, taskId, captureId]);
  }

  private current(key: string, entry: Entry): boolean {
    try { return this.entries.get(key) === entry && entry.expiresAt > this.now() && entry.sourceCurrent() === true &&
      this.entries.get(key) === entry && entry.expiresAt > this.now(); }
    catch { return false; }
  }

  /** Caller schedules bounded cleanup; no timer or background task is created here. */
  cleanup(): void {
    for (const [key, entry] of this.entries) if (!this.current(key, entry)) this.remove(key, entry);
  }

  private remove(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key); this.bytes -= entry.png.length;
    entry.png.fill(0);
  }

  /** Input is a host capture, never a model-supplied path, identity or image. */
  async register(sessionId: string, raw: EvidenceIdentity, png: Buffer, expiresAt: number,
    sourceCurrent: () => boolean, signal?: AbortSignal): Promise<string> {
    if (!raw || typeof sourceCurrent !== 'function' || !Buffer.isBuffer(png) || png.length < 45 || png.length > MAX_IMAGE_BYTES ||
        ![raw.appId, raw.processInstance, raw.surfaceId, raw.surfaceGeneration, raw.geometryRevision].every(value => typeof value === 'string' && !!value.trim() && value.length <= 256) ||
        !raw.region || ![raw.region.x, raw.region.y, raw.region.width, raw.region.height].every(Number.isSafeInteger) ||
        raw.region.x < 0 || raw.region.y < 0 || raw.region.width < 1 || raw.region.height < 1 ||
        !Number.isSafeInteger(raw.region.x + raw.region.width) || !Number.isSafeInteger(raw.region.y + raw.region.height)) throw new Error('Invalid desktop capture evidence');
    const key = this.key(sessionId, raw.taskId, raw.captureId), now = this.now();
    let generation = this.generations.get(sessionId);
    if (!generation) { generation = Object.freeze({}); this.generations.set(sessionId, generation); }
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > MAX_DESKTOP_GRANT_TTL_MS) throw new Error('Invalid evidence lifetime');
    signal?.throwIfAborted();
    if (sourceCurrent() !== true) throw new Error('Desktop capture is no longer current');
    const copy = Buffer.from(png), region = Object.freeze({ ...raw.region });
    const identity = { taskId: raw.taskId, appId: raw.appId, processInstance: raw.processInstance, surfaceId: raw.surfaceId,
      surfaceGeneration: raw.surfaceGeneration, captureId: raw.captureId, geometryRevision: raw.geometryRevision, region };
    const size = await this.decode(Buffer.from(copy));
    signal?.throwIfAborted();
    if (sourceCurrent() !== true || this.generations.get(sessionId) !== generation ||
        !Number.isSafeInteger(this.now()) || this.now() >= expiresAt) throw new Error('Desktop capture is no longer current');
    if (!size || size.width !== region.width || size.height !== region.height) throw new Error('Evidence image does not match its region');
    this.cleanup();
    const finalSourceCurrent = sourceCurrent(), finalNow = this.now();
    if (finalSourceCurrent !== true || this.generations.get(sessionId) !== generation || !Number.isSafeInteger(finalNow) || finalNow >= expiresAt) throw new Error('Desktop capture is no longer current');
    if (this.entries.has(key)) throw new Error('Evidence capture already exists');
    if (this.entries.size >= MAX_ENTRIES || this.bytes + copy.length > MAX_TOTAL_BYTES) throw new Error('Desktop evidence capacity reached');
    const sha256 = createHash('sha256').update(copy).digest('hex');
    const entry = Object.freeze({ ...identity, png: copy, sha256, expiresAt, sourceCurrent });
    this.entries.set(key, entry); this.bytes += copy.length;
    return sha256;
  }

  /** Use the same host-bound session for both the action gate and confirmation UI. */
  bind(sessionId: string): {
    verify: (boundary: Readonly<UnknownActionBoundary>, signal?: AbortSignal) => Promise<() => boolean>;
    preview: (boundary: Readonly<UnknownActionBoundary>) => Promise<EvidenceIdentity & { png: Buffer }>;
  } {
    const find = (boundary: Readonly<UnknownActionBoundary>): { key: string; entry: Entry } => {
      if (!boundary) throw new Error('Invalid evidence boundary');
      const key = this.key(sessionId, boundary.taskId, boundary.captureId), entry = this.entries.get(key);
      if (!entry || !this.current(key, entry) || entry.sha256 !== boundary.evidenceSha256 ||
          entry.appId !== boundary.appId || entry.processInstance !== boundary.processInstance || entry.surfaceId !== boundary.surfaceId ||
          entry.surfaceGeneration !== boundary.surfaceGeneration || entry.geometryRevision !== boundary.geometryRevision || !boundary.region ||
          (['x', 'y', 'width', 'height'] as const).some(field => entry.region[field] !== boundary.region[field])) throw new Error('Desktop evidence unavailable or changed');
      return { key, entry };
    };
    return {
      verify: async (boundary, signal) => { signal?.throwIfAborted(); const { key, entry } = find(boundary); return () => this.current(key, entry); },
      preview: async boundary => {
        const { entry } = find(boundary);
        return { taskId: entry.taskId, appId: entry.appId, processInstance: entry.processInstance,
          surfaceId: entry.surfaceId, surfaceGeneration: entry.surfaceGeneration, captureId: entry.captureId,
          geometryRevision: entry.geometryRevision, region: { ...entry.region }, png: Buffer.from(entry.png) };
      }
    };
  }

  endSession(sessionId: string): void {
    this.key(sessionId, 'validation', 'validation');
    this.generations.delete(sessionId);
    for (const [key, entry] of this.entries) if ((JSON.parse(key) as string[])[0] === sessionId) this.remove(key, entry);
  }
}
