import { randomUUID } from 'node:crypto';

export interface SemanticSurfaceIdentity {
  surfaceId: string;
  surfaceGeneration: string;
  /** Adapter-maintained revision; changes whenever the semantic tree may have changed. */
  semanticRevision: string;
}
interface Snapshot<T> { identity: SemanticSurfaceIdentity; expiresAt: number; nodes: Map<string, T> }

/** Opaque semantic references are valid only for one bounded, unchanged host observation. */
export class DesktopSemanticRefs<T> {
  private snapshots = new Map<string, Snapshot<T>>();
  constructor(private readonly now: () => number = Date.now) {}

  create(identity: SemanticSurfaceIdentity, nodes: readonly T[], ttlMs: number): { snapshotId: string; refs: string[]; expiresAt: number } {
    if (typeof identity?.surfaceId !== 'string' || !identity.surfaceId.trim() ||
        typeof identity.surfaceGeneration !== 'string' || !identity.surfaceGeneration.trim() ||
        typeof identity.semanticRevision !== 'string' || !identity.semanticRevision.trim() ||
        !Array.isArray(nodes) || nodes.length > 1000 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000) {
      throw new Error('Invalid desktop semantic snapshot');
    }
    this.prune();
    if (this.snapshots.size >= 100) throw new Error('Desktop semantic snapshot capacity exceeded');
    const snapshotId = randomUUID(), expiresAt = this.now() + ttlMs;
    const indexed = new Map<string, T>();
    const refs = nodes.map(node => { const ref = randomUUID(); indexed.set(ref, node); return ref; });
    this.snapshots.set(snapshotId, { identity: { ...identity }, expiresAt, nodes: indexed });
    return { snapshotId, refs, expiresAt };
  }

  resolve(snapshotId: string, ref: string, current: SemanticSurfaceIdentity): T {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.expiresAt <= this.now() || !current ||
        snapshot.identity.surfaceId !== current.surfaceId || snapshot.identity.surfaceGeneration !== current.surfaceGeneration ||
        snapshot.identity.semanticRevision !== current.semanticRevision || !snapshot.nodes.has(ref)) {
      throw new Error('Stale or invalid desktop semantic reference; observe again');
    }
    return snapshot.nodes.get(ref)!;
  }

  revokeSurface(surfaceId: string): void {
    for (const [id, snapshot] of this.snapshots) if (snapshot.identity.surfaceId === surfaceId) this.snapshots.delete(id);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(id);
  }
}
