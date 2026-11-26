import { nativeWritePaths } from '../../../turnChanges/pathCapture';
import { TURN_FILE_LIMIT, type ReportedFileChange } from '../../../../shared/turnChanges';

/** Pair the external Pi tool result's own patch with its single reported path. */
export class ExternalPiReviewEvents {
  private readonly paths = new Map<string, string>();
  constructor(private readonly warn: (message: string) => void = () => {}) {}
  start(id: string, name: string, input: Record<string, unknown>): void {
    if (!id) return;
    if (!this.paths.has(id) && this.paths.size >= 512) { this.warn('外部 Pi 的审阅工具记录达到上限'); return; }
    const paths = [...new Set(nativeWritePaths(name, input).map(entry => entry.path))];
    if (paths.length === 1) this.paths.set(id, paths[0]);
  }
  finish(id: string, result: unknown): ReportedFileChange[] | undefined {
    const path = this.paths.get(id); this.paths.delete(id);
    const value = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
    const details = value.details && typeof value.details === 'object' && !Array.isArray(value.details) ? value.details as Record<string, unknown> : {};
    const patch = details.patch;
    if (!path || typeof patch !== 'string' || !patch) return undefined;
    return [Buffer.byteLength(patch) > TURN_FILE_LIMIT
      ? { path, kind: 'update', diff: '', diffOmitted: true }
      : { path, kind: 'update', diff: patch }];
  }
  clear(): void { this.paths.clear(); }
}
