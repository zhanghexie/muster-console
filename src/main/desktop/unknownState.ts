/** Process-local complement to the durable journal. All mediated gates must share one instance. */
export class DesktopUnknownState {
  private readonly records = new Map<string, string | null>();

  has(taskId: string): boolean { return this.records.has(taskId); }

  mark(taskId: string, recordId: string | null): void {
    const existing = this.records.get(taskId);
    if (this.records.has(taskId) && existing !== recordId) {
      // An untracked coordinator failure is not resolved by reconciling a later marker.
      this.records.set(taskId, null);
    } else this.records.set(taskId, recordId);
  }

  clear(taskId: string, recordId: string): void {
    if (this.records.get(taskId) === recordId) this.records.delete(taskId);
  }
}
