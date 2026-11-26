/**
 * Session-level delivery contract. The caller owns durable queueing and receipts;
 * the adapter owns its native channel and must distinguish rejection from an
 * uncertain submission. Retry policy and any duplicate handling belong to the caller.
 */
export type DeliveryPriority = 'normal' | 'preempt';
/** Optional busy-turn routes. Every managed session already has ordinary input. */
export interface DeliveryCapabilities {
  interject: boolean;
  snapshot: boolean;
}
export type DeliveryAttempt =
  | { status: 'confirmed' }
  | { status: 'submitted' }
  | { status: 'deferred'; reason: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'uncertain'; reason: string };
export type DeliveryOutcome = DeliveryAttempt | { status: 'queued'; reason: string };

export interface SessionDeliveryAdapter {
  capabilities: DeliveryCapabilities;
  isBusy(): boolean;
  /** Confirmation means input acceptance or a correlated turn receipt, never task completion. */
  wake(content: string, deliveryId: string): Promise<DeliveryAttempt>;
  interject?(content: string, deliveryId: string): Promise<DeliveryAttempt>;
  /** Persist enough information to resume the interrupted work before stopping. */
  snapshot?(deliveryId: string): Promise<string>;
  interrupt?(deliveryId: string): Promise<DeliveryAttempt>;
  /** Queueing must itself be durable; it does not mean delivery succeeded. */
  queue(content: string, deliveryId: string, reason: string): Promise<void>;
}

/** Select the safest available route without exposing harness details to callers. */
export async function deliverSession(
  adapter: SessionDeliveryAdapter,
  content: string,
  options: { priority: DeliveryPriority; deliveryId: string }
): Promise<DeliveryOutcome> {
  const { priority, deliveryId } = options;
  if (!adapter.isBusy()) return adapter.wake(content, deliveryId);

  if (priority === 'preempt' && adapter.capabilities.interject && adapter.interject) {
    const result = await adapter.interject(content, deliveryId);
    if (result.status !== 'unsupported') return result;
    // unsupported is a promise that no input was submitted.
  }
  if (priority === 'preempt' && adapter.capabilities.snapshot && adapter.snapshot && adapter.interrupt) {
    let snapshot: string;
    try { snapshot = await adapter.snapshot(deliveryId); }
    catch (error) { return { status: 'deferred', reason: error instanceof Error ? error.message : String(error) }; }
    const stopped = await adapter.interrupt(deliveryId);
    if (stopped.status !== 'confirmed') return stopped;
    return adapter.wake(`${content}\n\n[被抢占工作续接]\n${snapshot}`, deliveryId);
  }

  const reason = priority === 'normal' ? 'Waiting for the turn boundary' : 'No preemption channel; waiting for the turn boundary';
  await adapter.queue(content, deliveryId, reason);
  return { status: 'queued', reason };
}
