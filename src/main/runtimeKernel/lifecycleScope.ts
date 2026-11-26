export type LifecycleDisposer = () => void | Promise<void>;

/**
 * Owns listeners, timers, child processes and write queues for one runtime domain.
 * Disposal is idempotent and runs in reverse registration order.
 */
export class LifecycleScope {
  private readonly disposers: LifecycleDisposer[] = [];
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private draining = false;
  private readonly cleanupErrors: unknown[] = [];

  constructor(readonly id: string, private readonly parent?: LifecycleScope) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  child(id: string): LifecycleScope {
    this.assertOpen();
    const child = new LifecycleScope(id, this);
    this.add(() => child.dispose());
    return child;
  }

  add(disposer: LifecycleDisposer): () => void {
    this.disposers.push(disposer);
    if (this.disposed) {
      // Late acquisition joins the active drain instead of escaping as a void
      // Promise. After a completed drain it creates a new observable barrier.
      if (!this.draining) {
        this.beginDrain();
        void this.disposal!.catch(error => console.error(`[lifecycle:${this.id}] late cleanup failed`, error));
      }
      return () => {};
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.disposers.indexOf(disposer);
      if (index >= 0) this.disposers.splice(index, 1);
    };
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.beginDrain();
    return this.disposal!;
  }

  private beginDrain(): void {
    this.draining = true;
    this.disposal = Promise.resolve().then(() => this.disposeResources());
  }

  private async disposeResources(): Promise<void> {
    // Pop dynamically: a disposer can await a constructor/startup continuation
    // which registers another resource before that disposer returns.
    while (this.disposers.length) {
      const disposer = this.disposers.pop()!;
      try { await disposer(); }
      catch (error) { this.cleanupErrors.push(error); }
    }
    this.draining = false;
    if (this.cleanupErrors.length === 1) throw this.cleanupErrors[0];
    if (this.cleanupErrors.length > 1) throw new AggregateError(this.cleanupErrors, `Lifecycle scope ${this.id} disposal failed`);
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error(`Lifecycle scope ${this.id} is already disposed`);
    if (this.parent?.isDisposed) throw new Error(`Lifecycle parent ${this.parent.id} is already disposed`);
  }
}
