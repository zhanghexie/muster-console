import type { DisplayCaptureTarget } from './displayCapture';

/** Host-only capture proof whose lifetime is bounded by the visible desktop-use indicator. */
export class VisibleScreenGuard {
  private readonly tasks = new Map<string, { taskId: string; generation: number; visibility: number }>();
  private nextGeneration = 0;
  constructor(private readonly indicatorEpoch: () => number | undefined) {}

  async authorize(owner: string, target: Readonly<DisplayCaptureTarget>, current: () => boolean, signal?: AbortSignal): Promise<number> {
    if (typeof owner !== 'string' || !owner.trim() || typeof current !== 'function' || !target ||
      [target.taskId, target.surfaceId, target.surfaceGeneration, target.geometryRevision].some(value => typeof value !== 'string' || !value.trim()) ||
      !Number.isSafeInteger(target.displayId) || target.displayId < 0 || !target.bounds ||
      ![target.bounds.x, target.bounds.y, target.bounds.width, target.bounds.height, target.scaleFactor].every(Number.isFinite) ||
      target.bounds.width <= 0 || target.bounds.height <= 0 || target.scaleFactor <= 0) throw new Error('Invalid visible desktop capture');
    signal?.throwIfAborted();
    const visibility = this.visibleEpoch();
    if (!current() || visibility === undefined) throw new Error('Desktop indicator is not visible');
    let entry = this.tasks.get(owner);
    if (!entry || entry.taskId !== target.taskId || entry.visibility !== visibility) {
      if (this.nextGeneration >= Number.MAX_SAFE_INTEGER) throw new Error('Desktop capture generation exhausted');
      if (!entry && this.tasks.size >= 512) this.tasks.delete(this.tasks.keys().next().value!);
      entry = { taskId: target.taskId, generation: ++this.nextGeneration, visibility };
      this.tasks.set(owner, entry);
    }
    signal?.throwIfAborted();
    if (!current() || this.visibleEpoch() !== visibility) throw new Error('Desktop indicator is not visible');
    return entry.generation;
  }

  isAuthorized(owner: string, taskId: string, generation: number): boolean {
    const entry = this.tasks.get(owner);
    return !!entry && this.visibleEpoch() === entry.visibility && entry.taskId === taskId && entry.generation === generation;
  }

  end(owner: string): void { this.tasks.delete(owner); }
  private visibleEpoch(): number | undefined {
    try {
      const value = this.indicatorEpoch();
      return Number.isSafeInteger(value) && value! >= 0 ? value : undefined;
    } catch { return undefined; }
  }
}
