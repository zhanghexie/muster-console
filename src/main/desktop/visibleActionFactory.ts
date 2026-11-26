import { WriteOutbox } from './writeOutbox';
import { DesktopTaskLock } from './taskLock';
import { VisibleActionBarrier } from './visibleActionBarrier';
import { VisibleActionCoordinator } from './visibleActionCoordinator';

/**
 * Use the same outbox file and lock directory for every desktop writer.
 * The host must let all in-flight calls settle before closing this runtime.
 */
export function createVisibleActionRuntime(outboxFile: string, lockDirectory: string): {
  coordinator: VisibleActionCoordinator;
  close(): void;
} {
  const outbox = new WriteOutbox(outboxFile);
  let barrier: VisibleActionBarrier | undefined;
  try {
    barrier = new VisibleActionBarrier(outboxFile);
    const coordinator = new VisibleActionCoordinator(outbox, new DesktopTaskLock(lockDirectory), barrier);
    const ownedBarrier = barrier;
    let closed = false;
    return {
      coordinator,
      close(): void {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try { ownedBarrier.close(); } catch (error) { failures.push(error); }
        try { outbox.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Visible action runtime could not close');
      }
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try { barrier?.close(); } catch (cleanup) { failures.push(cleanup); }
    try { outbox.close(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, 'Visible action runtime could not start or close');
    throw error;
  }
}
