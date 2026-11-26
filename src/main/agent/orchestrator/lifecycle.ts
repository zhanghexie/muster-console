/** Per-orchestrator ownership; no process-global shutdown state. */
type State = { closing: boolean; work: Set<Promise<unknown>>; cleanup: Set<Promise<void>>; errors: unknown[]; shutdown?: Promise<void> };
const states = new WeakMap<object, State>();
function state(owner: object): State {
  let value = states.get(owner);
  if (!value) { value = { closing: false, work: new Set(), cleanup: new Set(), errors: [] }; states.set(owner, value); }
  return value;
}
export function schedulerIsClosing(owner: object): boolean { return state(owner).closing; }

export function trackSchedulerWork<T>(owner: object, run: () => Promise<T>): Promise<T> {
  const current = state(owner);
  if (current.closing) return Promise.reject(new Error('Scheduler is shutting down'));
  // Register before executing run, including synchronous re-entrant shutdown.
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const task = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  current.work.add(task);
  void task.then(() => current.work.delete(task), () => current.work.delete(task));
  try { resolve(run()); } catch (error) { reject(error); }
  return task;
}

export function trackSchedulerCleanup(owner: object, task: Promise<void>): void {
  const current = state(owner);
  const pending = task.catch(error => {
    current.errors.push(error);
    console.error('[orchestrator] session cleanup failed', error);
  });
  current.cleanup.add(pending);
  void pending.then(() => current.cleanup.delete(pending));
}

/** Stop admission, cancel producers, settle work, then close writers and flush. */
export function shutdownScheduler(owner: object, stop: () => void, close: () => void, flush: () => Promise<void>): Promise<void> {
  const current = state(owner);
  if (current.shutdown) return current.shutdown;
  current.closing = true;
  current.shutdown = Promise.resolve().then(async () => {
    try { stop(); } catch (error) { current.errors.push(error); }
    await Promise.allSettled([...current.work]);
    try { close(); } catch (error) { current.errors.push(error); }
    await Promise.all([...current.cleanup]);
    try { await flush(); } catch (error) { current.errors.push(error); }
    if (current.errors.length) throw new AggregateError(current.errors, 'Scheduler shutdown failed');
  });
  return current.shutdown;
}
