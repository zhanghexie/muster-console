import type { GlobalDeliveryBinding, GlobalDeliveryStage } from '../desktop/globalDeliveryEvidenceVault';
import type { GlobalEngineDelivery } from '../desktop/globalEngineDelivery';

/** Host-only capabilities. Never serialize these into an engine or tool result. */
export type PiGlobalDeliveryAccess = GlobalEngineDelivery;

export type PiGlobalDeliveryStage = {
  readonly access: PiGlobalDeliveryAccess;
  readonly handle: GlobalDeliveryStage;
  readonly binding: GlobalDeliveryBinding;
  readonly kind: 'cua' | 'win32';
  outputText?: string;
};

/** Called only after the dispatcher has persisted the known action result. */
export function stagePiGlobalDelivery(access: PiGlobalDeliveryAccess, binding: GlobalDeliveryBinding,
  kind: 'cua' | 'win32', invocationId: string, value: unknown, signal: AbortSignal,
  isCurrent: () => boolean): PiGlobalDeliveryStage {
  const marker = access.inspectMarker();
  if (!marker || marker.operationId !== invocationId) throw new Error('Global desktop result marker is unavailable');
  let valid = true;
  const current = (): boolean => {
    if (!valid) return false;
    try { valid = !signal.aborted && isCurrent() === true; } catch { valid = false; }
    return valid;
  };
  const handle = access.stager.stage({ marker, value, signal, isCurrent: current });
  return { access, handle, binding: Object.freeze({ ...binding }), kind };
}

/** Bind only the exact serialized result that passed the engine adapter's checks. */
export function bindPiGlobalDelivery(stage: PiGlobalDeliveryStage, outputText: string): void {
  stage.access.stager.bindOutput(stage.handle, { binding: stage.binding, kind: stage.kind, outputText });
  stage.outputText = outputText;
}

/** Call only from the tracker after native Pi delivery or a verified private worker proof. */
export function acknowledgePiGlobalDelivery<T>(stage: PiGlobalDeliveryStage, acknowledge: () => Promise<T>): Promise<T> {
  if (stage.outputText === undefined) throw new Error('Global desktop result was not bound to engine output');
  return stage.access.issuer.withVerifiedEvent(stage.handle, { ...stage.binding, outputText: stage.outputText }, acknowledge);
}
