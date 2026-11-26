import { isRecordedGlobalVisibleRequest } from './globalVisibleActionDispatcher';

// This brand never crosses the tool boundary. A model cannot create it by
// returning a matching reason string or by copying a previously seen result.
const recordedOutcomes = new WeakSet<object>();

export function isRecordedDesktopOutcome(value: unknown): boolean {
  return !!value && typeof value === 'object' && recordedOutcomes.has(value);
}

/** Carry trusted proof through a host-owned result projection, never mint it. */
export function inheritRecordedDesktopOutcome<T extends { outcome: string }>(source: unknown, result: T): T {
  if (result.outcome === 'unknown' && (isRecordedGlobalVisibleRequest(source) || isRecordedDesktopOutcome(source))) {
    recordedOutcomes.add(result);
  }
  return result;
}
