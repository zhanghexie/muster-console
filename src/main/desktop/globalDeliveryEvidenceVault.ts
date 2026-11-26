import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { globalWriteDigest, type GlobalWriteMarker } from './globalDesktopWriteStore';
import type { GlobalVisibleRequest } from './globalVisibleActionDispatcher';
import { boundedVisibleActionResult, type VisibleActionJson } from './visibleActionJson';

declare const stageBrand: unique symbol;

/** An opaque, host-only handle. Its object identity, not its properties, is authoritative. */
export interface GlobalDeliveryStage { readonly [stageBrand]: never }

/** All identities are supplied by the host, never parsed from model arguments. */
export interface GlobalDeliveryBinding {
  readonly engine: 'codex' | 'scheduler-pi' | 'gui-pi';
  /** Unique host connection or child-process generation, not a reusable process ID. */
  readonly connectionId: string;
  readonly hostTurnId: string;
  /** Native turn identity when available, otherwise the host's unique turn identity. */
  readonly engineTurnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface GlobalDeliveryObservation extends GlobalDeliveryBinding {
  /** Exact complete text established by the tracker from the engine event. */
  readonly outputText: string;
}

export interface GlobalDeliveryStager {
  /** isCurrent must be a host-owned, monotonic lifetime: it cannot become true again after invalidation. */
  stage(input: Readonly<{ marker: GlobalWriteMarker; value: unknown; signal: AbortSignal; isCurrent(): boolean }>): GlobalDeliveryStage;
  bindOutput(stage: GlobalDeliveryStage, input: Readonly<{ binding: GlobalDeliveryBinding;
    kind: 'cua' | 'win32'; outputText: string }>): void;
  discard(stage: GlobalDeliveryStage): void;
}

export interface GlobalDeliveryIssuer {
  /**
   * TRACKER CAPABILITY ONLY. Invoke after that engine's actual event has passed
   * its source, call, turn, lifetime and complete-result checks. The vault
   * compares the event binding and text again, but cannot establish event
   * provenance itself. Never expose this capability to a dispatcher, model,
   * tool argument, serialized output or untrusted process.
   */
  withVerifiedEvent<T>(stage: GlobalDeliveryStage, observed: GlobalDeliveryObservation, acknowledge: () => Promise<T>): Promise<T>;
}

export interface GlobalDeliveryVerifier {
  deliveryEvidence(request: GlobalVisibleRequest, operationId: string): string | undefined;
  verifyDelivery(input: Readonly<{ marker: GlobalWriteMarker; evidenceId: string }>): boolean;
}

type StageState = {
  readonly marker: GlobalWriteMarker;
  readonly valueKey: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly abort: () => void;
  state: 'staged' | 'bound' | 'consuming' | 'spent';
  binding?: GlobalDeliveryBinding;
  textHash?: string;
};
type Proof = { readonly stage: StageState; readonly id: string; active: boolean };
const hashPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validIdentity = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1024;

function markerSnapshot(raw: GlobalWriteMarker): GlobalWriteMarker {
  if (!raw || typeof raw !== 'object' || typeof raw.operationId !== 'string' || !uuidPattern.test(raw.operationId) ||
      ![raw.requestHash, raw.contextHash, raw.fingerprintHash, raw.resultHash, raw.tokenHash].every(value =>
        typeof value === 'string' && hashPattern.test(value)) || raw.phase !== 'known') {
    throw new Error('A known global desktop marker is required');
  }
  return Object.freeze({ operationId: raw.operationId, requestHash: raw.requestHash, contextHash: raw.contextHash,
    fingerprintHash: raw.fingerprintHash, phase: raw.phase, resultHash: raw.resultHash, tokenHash: raw.tokenHash });
}

function sameMarker(a: GlobalWriteMarker | null | undefined, b: GlobalWriteMarker): boolean {
  return !!a && a.operationId === b.operationId && a.requestHash === b.requestHash && a.contextHash === b.contextHash &&
    a.fingerprintHash === b.fingerprintHash && a.phase === b.phase && a.resultHash === b.resultHash && a.tokenHash === b.tokenHash;
}

function bindingSnapshot(raw: GlobalDeliveryBinding): GlobalDeliveryBinding {
  if (!raw || !['codex', 'scheduler-pi', 'gui-pi'].includes(raw.engine) ||
      ![raw.connectionId, raw.hostTurnId, raw.engineTurnId, raw.toolCallId, raw.toolName].every(validIdentity)) {
    throw new Error('Invalid host engine delivery binding');
  }
  return Object.freeze({ engine: raw.engine, connectionId: raw.connectionId, hostTurnId: raw.hostTurnId,
    engineTurnId: raw.engineTurnId, toolCallId: raw.toolCallId, toolName: raw.toolName });
}

function sameBinding(a: GlobalDeliveryBinding, b: GlobalDeliveryBinding): boolean {
  return a.engine === b.engine && a.connectionId === b.connectionId && a.hostTurnId === b.hostTurnId &&
    a.engineTurnId === b.engineTurnId && a.toolCallId === b.toolCallId && a.toolName === b.toolName;
}

// Hash UTF-16 code units, so distinct unpaired surrogates cannot collapse to
// the same UTF-8 replacement character. Keep complete text out of the vault.
function textHash(text: unknown): string {
  if (typeof text !== 'string' || text.length > 131072 || Buffer.byteLength(text, 'utf8') > 131072) {
    throw new Error('Invalid engine delivery text');
  }
  return createHash('sha256').update(text, 'utf16le').digest('hex');
}

function structuralKey(value: VisibleActionJson): string {
  const sort = (item: VisibleActionJson): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

function outputMatches(text: string, kind: 'cua' | 'win32', marker: GlobalWriteMarker, valueKey: string): boolean {
  try {
    const outer: unknown = JSON.parse(text);
    if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return false;
    const envelope = outer as Record<string, unknown>;
    if (envelope.ok !== true || Object.keys(envelope).some(key => key !== 'ok' && key !== 'result') ||
        !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) return false;
    const body = envelope.result as Record<string, unknown>;
    if (body.outcome !== 'dispatched' || body.invocationId !== marker.operationId) return false;
    if (kind === 'win32' && Object.keys(body).some(key => !['outcome', 'invocationId', 'value'].includes(key))) return false;
    const result = kind === 'win32' ? body.value : Object.fromEntries(Object.entries(body)
      .filter(([key]) => key !== 'outcome' && key !== 'invocationId'));
    return structuralKey(boundedVisibleActionResult(result)) === valueKey;
  } catch { return false; }
}

/**
 * Create once per shared global barrier. Only host wiring receives the complete
 * return value: hand the stager to the dispatch bridge, the verifier callbacks
 * to the dispatcher/barrier, and the issuer solely to a trusted engine tracker.
 * The proof exists only while that tracker awaits the matching acknowledgement.
 * An unconfirmed marker remains durable across vault/host restart.
 */
export function createGlobalDeliveryEvidenceVault(inspect: () => GlobalWriteMarker | null): Readonly<{
  stager: GlobalDeliveryStager; issuer: GlobalDeliveryIssuer; verifier: GlobalDeliveryVerifier; close(): void;
}> {
  if (typeof inspect !== 'function') throw new Error('A host global desktop marker reader is required');
  const stages = new WeakMap<GlobalDeliveryStage, StageState>();
  const scope = new AsyncLocalStorage<Proof>();
  const proofs = new Map<string, Proof>();
  let current: StageState | undefined;
  let closed = false;

  const live = (state: StageState): boolean => {
    const active = (): boolean => state.state !== 'spent';
    try {
      if (active() && !closed && !state.signal.aborted && state.isCurrent() === true && !state.signal.aborted && active()) return true;
    } catch { /* invalidate on an unreliable host lifetime */ }
    // Once any check observes invalidation, an in-flight proof must not revive
    // even if an erroneous callback subsequently returns true again.
    revoke(state);
    return false;
  };
  const revoke = (state: StageState): void => {
    state.state = 'spent';
    state.signal.removeEventListener('abort', state.abort);
    for (const [id, proof] of proofs) if (proof.stage === state) { proof.active = false; proofs.delete(id); }
  };
  const get = (handle: GlobalDeliveryStage): StageState => {
    const state = handle && stages.get(handle);
    if (!state || closed) throw new Error('Invalid or closed global delivery stage');
    return state;
  };
  const proofIsLive = (proof: Proof | undefined): proof is Proof => !!proof && proof.active &&
    proofs.get(proof.id) === proof && proof.stage.state === 'consuming' && live(proof.stage) && proof.active &&
    proofs.get(proof.id) === proof && proof.stage.state === 'consuming';
  const markerStillCurrent = (marker: GlobalWriteMarker): boolean => {
    try { return sameMarker(inspect(), marker); } catch { return false; }
  };

  const stager = Object.freeze<GlobalDeliveryStager>({
    stage(input) {
      if (closed || !input || !input.signal || typeof input.signal.aborted !== 'boolean' ||
          typeof input.signal.addEventListener !== 'function' || typeof input.signal.removeEventListener !== 'function' ||
          typeof input.isCurrent !== 'function') throw new Error('Invalid global delivery stage');
      const marker = markerSnapshot(input.marker), value = boundedVisibleActionResult(input.value);
      if (globalWriteDigest(JSON.stringify(value)) !== marker.resultHash || !markerStillCurrent(marker)) {
        throw new Error('Global delivery stage does not match the durable result');
      }
      // A failed/abandoned stage cannot be restaged for the same unresolved
      // operation. A changed marker permits bounded cleanup of old tombstones.
      if (current?.marker.operationId === marker.operationId || current?.state === 'consuming') {
        throw new Error('Global delivery stage already exists');
      }
      if (current) revoke(current);
      let state: StageState;
      const abort = () => revoke(state);
      state = { marker, valueKey: structuralKey(value), signal: input.signal, isCurrent: input.isCurrent.bind(input),
        abort, state: 'staged' };
      if (!live(state)) throw new Error('Global delivery stage is no longer current');
      const handle = Object.freeze(Object.create(null)) as GlobalDeliveryStage;
      stages.set(handle, state); current = state;
      input.signal.addEventListener('abort', abort, { once: true });
      if (!live(state) || !markerStillCurrent(marker)) { revoke(state); throw new Error('Global delivery stage changed'); }
      return handle;
    },
    bindOutput(handle, input) {
      const state = get(handle);
      if (state.state !== 'staged') throw new Error('Global delivery stage cannot be rebound');
      try {
        if (!input || (input.kind !== 'cua' && input.kind !== 'win32') || !live(state) || !markerStillCurrent(state.marker)) {
          throw new Error('Global delivery output is no longer current');
        }
        const binding = bindingSnapshot(input.binding), digest = textHash(input.outputText);
        if (!outputMatches(input.outputText, input.kind, state.marker, state.valueKey) || !live(state) || state.state !== 'staged') {
          throw new Error('Global delivery output does not match');
        }
        state.binding = binding; state.textHash = digest; state.state = 'bound';
      } catch (error) { revoke(state); throw error; }
    },
    discard(handle) { revoke(get(handle)); }
  });

  const issuer = Object.freeze<GlobalDeliveryIssuer>({
    async withVerifiedEvent(handle, observed, acknowledge) {
      const state = get(handle);
      // Reject concurrent/replayed calls without revoking an already-running
      // legitimate confirmation.
      if (state.state !== 'bound') throw new Error('Global delivery event is already consumed or unavailable');
      try {
        const binding = bindingSnapshot(observed), digest = textHash(observed?.outputText);
        if (typeof acknowledge !== 'function' || !state.binding || !sameBinding(binding, state.binding) ||
            digest !== state.textHash || !live(state) || !markerStillCurrent(state.marker) || !live(state) || state.state !== 'bound') {
          throw new Error('Global delivery event does not match the staged result');
        }
      } catch (error) { revoke(state); throw error; }
      state.state = 'consuming';
      const proof: Proof = { stage: state, id: randomBytes(32).toString('base64url'), active: true };
      proofs.set(proof.id, proof);
      try { return await scope.run(proof, acknowledge); }
      finally { revoke(state); }
    }
  });

  const verifier = Object.freeze<GlobalDeliveryVerifier>({
    deliveryEvidence(request, operationId) {
      try {
        const proof = scope.getStore();
        if (!proofIsLive(proof) || !request || operationId !== proof.stage.marker.operationId ||
            ![request.sessionId, request.taskId, request.action, request.target].every(validIdentity) ||
            typeof request.requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(request.requestId) ||
            typeof request.fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(request.fingerprint) ||
            globalWriteDigest(JSON.stringify([request.sessionId, request.taskId, request.action, request.target, request.requestId])) !== proof.stage.marker.contextHash ||
            globalWriteDigest(request.fingerprint.toLowerCase()) !== proof.stage.marker.fingerprintHash) return undefined;
        return proof.id;
      } catch { return undefined; }
    },
    verifyDelivery(input) {
      try {
        const proof = scope.getStore();
        // The barrier checks the stored marker inside its transaction. Do not
        // re-read it here: its final authorization occurs after DELETE but
        // before COMMIT, when the proof still must be valid.
        return proofIsLive(proof) && !!input && proof.id === input.evidenceId && sameMarker(input.marker, proof.stage.marker);
      } catch { return false; }
    }
  });

  return Object.freeze({ stager, issuer, verifier, close() { closed = true; if (current) revoke(current); } });
}
