import type { GlobalDeliveryIssuer, GlobalDeliveryStager } from './globalDeliveryEvidenceVault';
import type { GlobalWriteMarker } from './globalDesktopWriteStore';

/**
 * Host-only dependency injection for a single shared global write barrier.
 * Never expose these capabilities or the marker reader to a model or tool.
 * The bridge stages and binds results; only a trusted engine event tracker may
 * hold the issuer. The host must give the matching vault verifier to the
 * global dispatcher and barrier, and supply a monotonic live turn lease.
 */
export interface GlobalEngineDelivery {
  readonly stager: GlobalDeliveryStager;
  readonly issuer: GlobalDeliveryIssuer;
  inspectMarker(): GlobalWriteMarker | null;
}

/** A configured host must never silently fall back to local-only receipts. */
export function desktopEngineDeliveryFromContext(ctx: { desktopEngineDelivery?: () => GlobalEngineDelivery }): GlobalEngineDelivery | undefined {
  if (!ctx || ctx.desktopEngineDelivery === undefined) return undefined;
  if (typeof ctx.desktopEngineDelivery !== 'function') throw new Error('Desktop global delivery dependencies are invalid');
  const value = ctx.desktopEngineDelivery();
  if (!value || typeof value.inspectMarker !== 'function' || typeof value.stager?.stage !== 'function' ||
      typeof value.stager?.bindOutput !== 'function' || typeof value.stager?.discard !== 'function' ||
      typeof value.issuer?.withVerifiedEvent !== 'function') throw new Error('Desktop global delivery dependencies are invalid');
  return value;
}
