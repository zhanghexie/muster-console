import { createHash } from 'node:crypto';
import type { DesktopEpochHistory } from './epochHistory';

type Entry = { taskId: string; generation: number };

/** Host-owned scheduler task identities for visible desktop use. */
export class VisibleSchedulerEpochs {
  private readonly current = new Map<string, Entry>();
  private readonly closing = new Set<string>();
  private readonly poisoned = new Set<string>();

  private taskId(owner: string, generation: number): string {
    return `scheduler:${createHash('sha256').update(JSON.stringify([owner, generation])).digest('hex')}`;
  }

  constructor(private readonly history: DesktopEpochHistory, private readonly visibilityEpoch: () => number | undefined) {
    if (!history || typeof history.generation !== 'function' || typeof history.record !== 'function' ||
        typeof history.owns !== 'function' || typeof history.endSession !== 'function' || typeof visibilityEpoch !== 'function') {
      throw new Error('Visible scheduler identity dependencies are required');
    }
  }

  /** An identity is minted only while the host's visible indicator is mounted. */
  async ensureCapture(owner: string, isCurrent: () => boolean, signal?: AbortSignal): Promise<string> {
    this.checkOwner(owner);
    if (typeof isCurrent !== 'function') throw new Error('Desktop caller validity is required');
    const visibility = this.visibilityEpoch();
    if (!Number.isSafeInteger(visibility) || visibility! < 0) throw new Error('Desktop indicator is not visible');
    const assertCurrent = (): void => {
      signal?.throwIfAborted();
      if (this.closing.has(owner) || this.poisoned.has(owner) || !isCurrent() || this.visibilityEpoch() !== visibility) {
        throw new Error('Desktop caller or indicator is no longer current');
      }
      signal?.throwIfAborted();
    };
    assertCurrent();
    const generation = this.history.generation(owner), prior = this.current.get(owner);
    let entry = prior && prior.generation === generation ? prior : undefined;
    if (!entry) {
      // Stable across host restarts so an unresolved action cannot be bypassed
      // by obtaining a fresh scheduler task identity.
      const taskId = this.taskId(owner, generation);
      if (!this.history.owns(owner, generation, taskId)) this.history.record(owner, generation, taskId);
      assertCurrent();
      if (this.history.generation(owner) !== generation) throw new Error('Desktop session generation changed');
      entry = { taskId, generation };
      this.current.set(owner, entry);
    }
    assertCurrent();
    if (this.current.get(owner) !== entry || this.history.generation(owner) !== generation) throw new Error('Desktop session generation changed');
    return entry.taskId;
  }

  currentBinding(owner: string): { epoch: string; anchor: string; generation: number } | null {
    this.checkOwner(owner);
    if (this.closing.has(owner) || this.poisoned.has(owner)) return null;
    const entry = this.current.get(owner);
    if (!entry || this.history.generation(owner) !== entry.generation) return null;
    return { epoch: entry.taskId, anchor: entry.taskId, generation: entry.generation };
  }

  /** Identity-only readback for a host-proven continuation; not a capture grant. */
  continuationBinding(owner: string): { epoch: string; anchor: string; generation: number } | null {
    this.checkOwner(owner);
    if (this.closing.has(owner) || this.poisoned.has(owner)) return null;
    const current = this.currentBinding(owner);
    if (current) return current;
    const generation = this.history.generation(owner), taskId = this.taskId(owner, generation);
    return this.history.owns(owner, generation, taskId) ? { epoch: taskId, anchor: taskId, generation } : null;
  }

  /** Invalidate synchronously; a failed durable revocation poisons this owner. */
  closeSession(owner: string): void {
    this.checkOwner(owner);
    this.closing.add(owner);
    this.current.delete(owner);
    try { this.history.endSession(owner); }
    catch (error) { this.poisoned.add(owner); throw error; }
    finally { this.closing.delete(owner); }
  }

  private checkOwner(owner: string): void {
    if (typeof owner !== 'string' || !owner.startsWith('orchestrator:') || owner.length <= 'orchestrator:'.length || owner.length > 256) {
      throw new Error('Invalid scheduler desktop owner');
    }
  }
}
