import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { currentGuiExecutionTurn } from '../../../agent/agentScope';
import type { CuaHostDeliverySlot } from '../../../desktop/cuaVisibleAction';
import type { CuaPersistedAction, CuaSemanticEffect } from '../../../desktop/cuaSemanticRuntime';
import type { DesktopDeliveryLease } from '../../../desktop/desktopTurns';
import type { VisibleIndicatorEpoch } from '../../../desktop/visibleActionCoordinator';
import type { Win32VisibleActor, Win32VisibleDeliverySlot, Win32VisibleEffect } from '../../../desktop/win32VisibleControl';
import type { GuiHostToolResult } from '../../tools/gateway';
import type { HostToolCallInterceptor } from '../acp/hostToolGateway';
import type { GlobalEngineDelivery } from '../../../desktop/globalEngineDelivery';
import type { GlobalDeliveryBinding, GlobalDeliveryStage, GlobalDeliveryStager } from '../../../desktop/globalDeliveryEvidenceVault';
import type { GlobalWriteMarker } from '../../../desktop/globalDesktopWriteStore';
import { CodexMcpToolDeliveryTracker } from './toolDelivery';

type Context = { lease: DesktopDeliveryLease; indicatorEpoch: VisibleIndicatorEpoch;
  isIndicatorCurrent(epoch: VisibleIndicatorEpoch): boolean; isTargetCurrent(): boolean };
type Candidate = { invocationId: string; effect: string; kind: 'cua' | 'win32'; current(): boolean;
  acknowledge: Parameters<CuaHostDeliverySlot['stageDelivery']>[2]; globalStage?: GlobalDeliveryStage;
  outputText?: string; registered?: boolean; acknowledged?: boolean };
type Turn = { hostId: string; connectionId: string; signal?: AbortSignal; lifetime: AbortController; threadId?: string; nativeId?: string;
  tracker: CodexMcpToolDeliveryTracker; calls: Map<string, Call> };
type Call = { owner: CodexDesktopDelivery; turn: Turn; id: string; name: string; arguments: Record<string, unknown>;
  signal: AbortSignal; isCurrent(): boolean; lifetime: AbortController; active: boolean; candidate?: Candidate };
const calls = new AsyncLocalStorage<Call>();
/** Presence only: capture still validates the full live host/tool binding. */
export function hasCodexDesktopDeliveryScope(): boolean { return calls.getStore() !== undefined; }
const live = (fn: () => boolean): boolean => { try { return fn() === true; } catch { return false; } };

function effectKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.ok !== 'boolean' || typeof item.delivery !== 'string' || typeof item.effect !== 'string' ||
      typeof item.verification !== 'string' || (item.code !== undefined && typeof item.code !== 'string')) return undefined;
  return JSON.stringify([item.ok, item.delivery, item.effect, item.verification, item.code ?? null]);
}

function win32EffectKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.delivery !== 'dispatched' || item.effect !== 'unverifiable' || item.verification !== 'not_performed' ||
      (item.pid !== undefined && (!Number.isSafeInteger(item.pid) || (item.pid as number) <= 0)) ||
      Object.keys(item).some(key => !['delivery', 'effect', 'verification', 'pid'].includes(key))) return undefined;
  return JSON.stringify([item.delivery, item.effect, item.verification, item.pid ?? null]);
}

function matches(result: GuiHostToolResult, candidate: Candidate): boolean {
  try {
    if (!result.ok || typeof result.text !== 'string') return false;
    const outer: unknown = JSON.parse(result.text);
    if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return false;
    const envelope = outer as Record<string, unknown>, value = envelope.result;
    if (envelope.ok !== true || Object.keys(envelope).some(key => key !== 'ok' && key !== 'result') ||
        !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const body = value as Record<string, unknown>;
    if (body.outcome !== 'dispatched' || body.invocationId !== candidate.invocationId) return false;
    return candidate.kind === 'cua'
      ? Object.keys(body).every(key => ['outcome', 'invocationId', 'ok', 'delivery', 'effect', 'verification', 'code'].includes(key)) &&
        effectKey(body) === candidate.effect
      : Object.keys(body).every(key => ['outcome', 'invocationId', 'value'].includes(key)) && win32EffectKey(body.value) === candidate.effect;
  } catch { return false; }
}

/** Capture only from the authenticated gateway while its real host tool is executing. */
function captureBase(actor: { sessionId: string; turnId: string; isCurrent(): boolean }, context: Context, extra: () => boolean) {
  const call = calls.getStore(), gui = currentGuiExecutionTurn();
  if (!call || !call.active || !call.owner.isLive(call) || !gui || !gui.desktopTurnId || !gui.isDesktopCurrent ||
      !actor || actor.sessionId !== gui.sessionId || actor.turnId !== gui.desktopTurnId || typeof actor.isCurrent !== 'function' ||
      context?.lease?.owner !== gui.sessionId || context.lease.turnId !== gui.desktopTurnId ||
      typeof context.lease.isCurrent !== 'function' || !context.lease.signal ||
      typeof context.isIndicatorCurrent !== 'function' || typeof context.isTargetCurrent !== 'function' || typeof extra !== 'function') {
    throw new Error('The originating Codex desktop delivery context is unavailable');
  }
  const { lease, indicatorEpoch } = context;
  const indicatorCurrent = context.isIndicatorCurrent.bind(context), targetCurrent = context.isTargetCurrent.bind(context);
  const actorCurrent = actor.isCurrent.bind(actor);
  const current = () => call.owner.isLive(call) && live(gui.isDesktopCurrent!) && live(actorCurrent) &&
    live(() => lease.isCurrent()) && !lease.signal.aborted && live(() => indicatorCurrent(indicatorEpoch)) &&
    live(targetCurrent) && live(extra);
  if (!current()) throw new Error('The Codex desktop delivery context is no longer current');
  const guardedLease: DesktopDeliveryLease = Object.freeze({ owner: lease.owner, turnId: lease.turnId,
    signal: AbortSignal.any([lease.signal, call.signal, call.lifetime.signal, call.turn.lifetime.signal]), isCurrent: current });
  return { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent };
}

/** Capture only from the authenticated gateway while its real host tool is executing. */
export function captureCodexCuaDeliverySlot(request: Parameters<CuaPersistedAction>[0], context: Context): CuaHostDeliverySlot {
  if (!request || typeof request.isTargetCurrent !== 'function' || !request.targetGeneration) throw new Error('The Codex desktop target is unavailable');
  const { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent } =
    captureBase(request.actor, context, request.isTargetCurrent.bind(request));
  return Object.freeze({ lease: guardedLease, indicatorEpoch, isIndicatorCurrent: indicatorCurrent, isTargetCurrent: targetCurrent,
    stageDelivery(invocationId: string, value: CuaSemanticEffect, acknowledge: Candidate['acknowledge']): void {
      const effect = effectKey(value);
      if (!call.active || !current() || call.candidate || !/^[0-9a-f-]{36}$/i.test(invocationId) ||
          !effect || typeof acknowledge !== 'function') throw new Error('The Codex desktop delivery candidate is invalid');
      const globalStage = call.owner.stageGlobal(invocationId, value, guardedLease.signal, current);
      call.candidate = { invocationId, effect, kind: 'cua', current, acknowledge, ...(globalStage ? { globalStage } : {}) };
    } });
}

/** The Windows adapter's result shape differs from the Cua semantic result. */
export function captureCodexWin32DeliverySlot(actor: Win32VisibleActor,
  context: Context & Pick<Win32VisibleDeliverySlot, 'isPointOnTarget' | 'onUnknown'>): Win32VisibleDeliverySlot {
  if (typeof context?.onUnknown !== 'function' ||
      (context.isPointOnTarget !== undefined && typeof context.isPointOnTarget !== 'function')) {
    throw new Error('The Codex Windows desktop delivery context is unavailable');
  }
  const { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent } = captureBase(actor, context, () => true);
  return Object.freeze({ lease: guardedLease, indicatorEpoch, isIndicatorCurrent: indicatorCurrent, isTargetCurrent: targetCurrent,
    ...(context.isPointOnTarget ? { isPointOnTarget: context.isPointOnTarget.bind(context) } : {}), onUnknown: context.onUnknown.bind(context),
    stageDelivery(invocationId: string, value: Win32VisibleEffect, acknowledge: Candidate['acknowledge']): void {
      const effect = win32EffectKey(value);
      if (!call.active || !current() || call.candidate || !/^[0-9a-f-]{36}$/i.test(invocationId) ||
          !effect || typeof acknowledge !== 'function') throw new Error('The Codex Windows desktop delivery candidate is invalid');
      const globalStage = call.owner.stageGlobal(invocationId, value, guardedLease.signal, current);
      call.candidate = { invocationId, effect, kind: 'win32', current, acknowledge, ...(globalStage ? { globalStage } : {}) };
    } });
}

/** One instance belongs to one real GUI connection, and is armed only by its app-server turn. */
export class CodexDesktopDelivery implements HostToolCallInterceptor {
  private turn?: Turn;
  private closed = false;
  private readonly staging?: { stager: GlobalDeliveryStager; inspectMarker(): GlobalWriteMarker | null };
  private readonly makeTracker: () => CodexMcpToolDeliveryTracker;

  constructor(private readonly getHostTurn: () => string | undefined, private readonly report: (reason: string) => void,
    globalDelivery?: GlobalEngineDelivery) {
    if (globalDelivery !== undefined && (!globalDelivery || typeof globalDelivery.inspectMarker !== 'function' ||
        typeof globalDelivery.stager?.stage !== 'function' || typeof globalDelivery.stager?.bindOutput !== 'function' ||
        typeof globalDelivery.stager?.discard !== 'function' || typeof globalDelivery.issuer?.withVerifiedEvent !== 'function')) {
      throw new Error('Codex global delivery dependencies are invalid');
    }
    this.staging = globalDelivery ? { stager: globalDelivery.stager, inspectMarker: globalDelivery.inspectMarker.bind(globalDelivery) } : undefined;
    const issuer = globalDelivery?.issuer;
    this.makeTracker = () => new CodexMcpToolDeliveryTracker(issuer);
  }

  /** Host bridge only: stage the durable result, without granting issuer access. */
  stageGlobal(invocationId: string, value: unknown, signal: AbortSignal, isCurrent: () => boolean): GlobalDeliveryStage | undefined {
    if (!this.staging) return undefined;
    const marker = this.staging.inspectMarker();
    if (!marker || marker.operationId !== invocationId) throw new Error('The global Codex delivery marker does not match');
    return this.staging.stager.stage({ marker, value, signal, isCurrent });
  }

  begin(hostId: string, signal?: AbortSignal): void {
    if (this.closed || this.turn || !hostId || this.getHostTurn() !== hostId || signal?.aborted) throw new Error('Codex desktop turn is unavailable');
    this.turn = { hostId, connectionId: randomUUID(), signal, lifetime: new AbortController(), tracker: this.makeTracker(), calls: new Map() };
  }

  bind(hostId: string, threadId: string, nativeId: string): void {
    const turn = this.turn;
    if (!turn || turn.hostId !== hostId || !threadId || !nativeId || turn.threadId || turn.nativeId ||
        turn.lifetime.signal.aborted || turn.signal?.aborted || this.getHostTurn() !== hostId) throw new Error('Codex desktop turn identity is unavailable');
    turn.threadId = threadId; turn.nativeId = nativeId;
    for (const call of turn.calls.values()) if (call.candidate?.outputText) {
      try { this.register(call); } catch (error) { this.retire(call); throw error; }
    }
  }

  isLive(call: Call): boolean {
    return !this.closed && this.turn === call.turn && !call.turn.lifetime.signal.aborted && !call.turn.signal?.aborted &&
      !call.signal.aborted && !call.lifetime.signal.aborted && this.getHostTurn() === call.turn.hostId && live(call.isCurrent);
  }

  async run(input: { id: string; name: string; arguments: Record<string, unknown>; signal: AbortSignal;
    turnId?: string; isCurrent(): boolean }, execute: () => Promise<GuiHostToolResult>): Promise<GuiHostToolResult> {
    const turn = this.turn;
    // An unrelated or over-capacity invocation must never inherit a private
    // slot from an outer asynchronous tool call.
    if (!turn || input.turnId !== turn.hostId || turn.calls.size >= 256) return calls.exit(execute);
    if (turn.calls.has(input.id)) throw new Error('Duplicate Codex host tool call identity');
    const call: Call = { ...input, arguments: structuredClone(input.arguments), turn, owner: this,
      lifetime: new AbortController(), active: true };
    turn.calls.set(call.id, call);
    let awaiting = false;
    try {
      const result = await calls.run(call, execute);
      if (!call.candidate) return result;
      if (!call.candidate.current() || !matches(result, call.candidate)) {
        this.notify('semantic-result-unconfirmed');
        return { ok: false, text: 'Desktop action result is unconfirmed; inspect the unresolved action before retrying.' };
      }
      call.candidate.outputText = result.text;
      if (turn.nativeId) this.register(call);
      awaiting = true;
      return result;
    } catch (error) {
      if (call.candidate) this.notify('tool-failed-after-desktop-action');
      throw error;
    } finally {
      call.active = false;
      if (!awaiting) this.retire(call);
    }
  }

  /** Feed only live events from this connection after app-server thread/turn validation. */
  async observe(hostId: string, event: unknown): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.hostId !== hostId || !turn.nativeId) return;
    await turn.tracker.observe(event);
    for (const call of turn.calls.values()) if (call.candidate?.acknowledged) this.retire(call);
  }

  end(hostId: string): void {
    const turn = this.turn;
    if (!turn || turn.hostId !== hostId) return;
    this.turn = undefined;
    turn.lifetime.abort();
    for (const call of turn.calls.values()) call.lifetime.abort();
    turn.tracker.close();
    turn.calls.clear();
  }

  close(): void { this.closed = true; if (this.turn) this.end(this.turn.hostId); }

  private register(call: Call): void {
    const turn = call.turn, candidate = call.candidate;
    if (!candidate || candidate.registered || !candidate.outputText || !turn.threadId || !turn.nativeId || !candidate.current()) {
      throw new Error('Codex desktop delivery cannot be registered');
    }
    let global: { stage: GlobalDeliveryStage; binding: GlobalDeliveryBinding } | undefined;
    if (this.staging) {
      if (!candidate.globalStage) throw new Error('The global Codex delivery stage is unavailable');
      const binding: GlobalDeliveryBinding = Object.freeze({ engine: 'codex', connectionId: turn.connectionId,
        hostTurnId: turn.hostId, engineTurnId: turn.nativeId, toolCallId: call.id, toolName: call.name });
      this.staging.stager.bindOutput(candidate.globalStage, { binding, kind: candidate.kind, outputText: candidate.outputText });
      global = Object.freeze({ stage: candidate.globalStage, binding });
    }
    turn.tracker.expect({ threadId: turn.threadId, turnId: turn.nativeId, server: 'muster', tool: call.name,
      arguments: call.arguments, invocationId: candidate.invocationId, outputText: candidate.outputText,
      ...(global ? { global } : {}),
      isCurrent: candidate.current,
      acknowledge: async () => {
        const outcome = await candidate.acknowledge(`visible-action:${candidate.invocationId}`);
        if (outcome.outcome === 'acknowledged') candidate.acknowledged = true;
        return outcome;
      },
      onUnconfirmed: reason => { this.retire(call); this.notify(reason); } });
    candidate.registered = true;
  }

  private retire(call: Call): void {
    call.lifetime.abort();
    if (call.candidate?.globalStage && this.staging) {
      try { this.staging.stager.discard(call.candidate.globalStage); } catch { this.notify('global-delivery-cleanup-failed'); }
    }
    if (call.turn.calls.get(call.id) === call) call.turn.calls.delete(call.id);
  }
  private notify(reason: string): void { try { this.report(reason); } catch { /* diagnostic only */ } }
}
