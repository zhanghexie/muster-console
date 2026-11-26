/** Tracks accepted asynchronous callbacks independently of their transport socket. */
export class AcceptedWork {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;

  get accepting(): boolean { return !this.stopped; }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Service is stopping'));
    const promise = Promise.resolve().then(work);
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  attach(controller: AbortController): () => void {
    if (this.stopped) controller.abort();
    else this.controllers.add(controller);
    return () => this.controllers.delete(controller);
  }

  stopAdmission(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
  }

  async drain(): Promise<void> {
    this.stopAdmission();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
