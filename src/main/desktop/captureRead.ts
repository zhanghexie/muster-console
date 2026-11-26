import type { DesktopCaptureArtifacts } from './captureArtifacts';
import type { TrustedDisplayActor } from './displayService';

/** Bound session/task identity must be supplied by the host, never by the model. */
export async function readCaptureArtifact(raw: TrustedDisplayActor, captureId: string,
  storeFor: (actor: Readonly<TrustedDisplayActor>) => Pick<DesktopCaptureArtifacts, 'get'>,
  audit: (actor: Readonly<TrustedDisplayActor>, captureId: string, result: 'allowed' | 'denied') => Promise<void>,
  signal?: AbortSignal): Promise<Awaited<ReturnType<DesktopCaptureArtifacts['get']>>> {
  if (!raw || typeof raw.sessionId !== 'string' || !raw.sessionId.trim() || typeof raw.taskId !== 'string' || !raw.taskId.trim() ||
      typeof raw.isCurrent !== 'function' || typeof captureId !== 'string' || !captureId.trim() ||
      typeof storeFor !== 'function' || typeof audit !== 'function') throw new Error('Invalid capture read request');
  const actor = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, isCurrent: raw.isCurrent.bind(raw) });
  const assertCurrent = (): void => { signal?.throwIfAborted(); if (!actor.isCurrent()) throw new Error('Desktop caller is no longer current'); };
  try {
    assertCurrent();
    const result = await storeFor(actor).get(actor.taskId, captureId);
    assertCurrent();
    await audit(actor, captureId, 'allowed');
    assertCurrent();
    return result;
  } catch (error) {
    try { await audit(actor, captureId, 'denied'); }
    catch (auditError) { throw new AggregateError([error, auditError], 'Capture read failed and denial audit could not be recorded'); }
    throw error;
  }
}

/** Resolve a historical scheduler task from host-owned metadata, never a model-provided task ID. */
export async function readHistoricalCapture(raw: Pick<TrustedDisplayActor, 'sessionId' | 'isCurrent'>, captureId: string,
  storeFor: (actor: Readonly<Pick<TrustedDisplayActor, 'sessionId' | 'isCurrent'>>) => Pick<DesktopCaptureArtifacts, 'get' | 'ownerHash'>,
  history: { findArtifactTask(sessionId: string, taskHash: string): string | undefined; ownsArtifact(sessionId: string, taskId: string): boolean },
  audit: (actor: Readonly<Pick<TrustedDisplayActor, 'sessionId' | 'isCurrent'>>, captureId: string, result: 'allowed' | 'denied') => Promise<void>,
  signal?: AbortSignal): Promise<Awaited<ReturnType<DesktopCaptureArtifacts['get']>>> {
  if (!raw || typeof raw.sessionId !== 'string' || !raw.sessionId.trim() || typeof raw.isCurrent !== 'function' ||
      typeof captureId !== 'string' || !captureId.trim() || typeof storeFor !== 'function' ||
      typeof history?.findArtifactTask !== 'function' || typeof history.ownsArtifact !== 'function' || typeof audit !== 'function') {
    throw new Error('Invalid historical capture request');
  }
  const actor = Object.freeze({ sessionId: raw.sessionId, isCurrent: raw.isCurrent.bind(raw) });
  const assertCurrent = (): void => { signal?.throwIfAborted(); if (!actor.isCurrent()) throw new Error('Desktop caller is no longer current'); };
  try {
    assertCurrent();
    const store = storeFor(actor), ownerHash = await store.ownerHash(captureId);
    assertCurrent();
    const taskId = history.findArtifactTask(actor.sessionId, ownerHash);
    if (!taskId || !history.ownsArtifact(actor.sessionId, taskId)) throw new Error('Capture is outside this session history');
    const result = await store.get(taskId, captureId);
    assertCurrent();
    if (!history.ownsArtifact(actor.sessionId, taskId)) throw new Error('Capture history is no longer current');
    await audit(actor, captureId, 'allowed');
    assertCurrent();
    if (!history.ownsArtifact(actor.sessionId, taskId)) throw new Error('Capture history is no longer current');
    return result;
  } catch (error) {
    try { await audit(actor, captureId, 'denied'); }
    catch (auditError) { throw new AggregateError([error, auditError], 'Historical capture read failed and denial audit could not be recorded'); }
    throw error;
  }
}
