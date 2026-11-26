import { AcceptedWork } from '../net/acceptedWork';

/** Own startup/background timers and the callbacks they have already accepted. */
export class ScheduledWork {
  private readonly work = new AcceptedWork();
  private readonly controller = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly onError: (error: unknown) => void) {}

  schedule(delay: number, callback: (signal: AbortSignal) => void | Promise<void>, repeat = false): void {
    if (!this.work.accepting) throw new Error('Scheduled work is stopping');
    const fire = () => {
      if (!repeat) this.timers.delete(timer);
      if (!this.work.accepting) return;
      void this.work.run(async () => {
        if (!this.controller.signal.aborted) await callback(this.controller.signal);
      }).catch(this.onError);
    };
    const timer = repeat ? setInterval(fire, delay) : setTimeout(fire, delay);
    timer.unref?.();
    this.timers.add(timer);
  }

  stopAdmission(): void {
    this.work.stopAdmission();
    this.controller.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async shutdown(): Promise<void> {
    this.stopAdmission();
    await this.work.drain();
  }
}
