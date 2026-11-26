import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { currentGuiExecutionTurn } from '../../../agent/agentScope';
import type { CuaHostDeliverySlot } from '../../../desktop/cuaVisibleAction';
import type { CuaPersistedAction, CuaSemanticEffect } from '../../../desktop/cuaSemanticRuntime';
import type { DesktopDeliveryLease } from '../../../desktop/desktopTurns';
import type { VisibleAcknowledgementOutcome, VisibleIndicatorEpoch } from '../../../desktop/visibleActionCoordinator';
import type { Win32VisibleActor, Win32VisibleDeliverySlot, Win32VisibleEffect } from '../../../desktop/win32VisibleControl';
import type { GuiHostToolResult } from '../../tools/gateway';
import { acknowledgePiGlobalDelivery, bindPiGlobalDelivery, stagePiGlobalDelivery,
  type PiGlobalDeliveryAccess, type PiGlobalDeliveryStage } from '../../piGlobalDelivery';

type Context = { lease: DesktopDeliveryLease; indicatorEpoch: VisibleIndicatorEpoch;
  isIndicatorCurrent(epoch: VisibleIndicatorEpoch): boolean; isTargetCurrent(): boolean };
type Candidate = { invocationId: string; effect: string; kind: 'cua' | 'win32'; current(): boolean;
  acknowledge: Parameters<CuaHostDeliverySlot['stageDelivery']>[2]; global?: PiGlobalDeliveryStage };
type Turn = { generation: number; hostId: string; lifetime: AbortController; seen: Set<string>; calls: Map<string, Call> };
type Call = { owner: GuiPiDesktopDelivery; turn: Turn; id: string; name?: string; signal: AbortSignal; isCurrent(): boolean;
  lifetime: AbortController; active: boolean; poisoned: boolean; candidate?: Candidate; proof?: string; textDigest?: string; consuming: boolean };
export type PiPrivateToolResult = GuiHostToolResult & { desktopDeliveryProof?: string };
const calls = new AsyncLocalStorage<Call>();
const live = (fn: () => boolean): boolean => { try { return fn() === true; } catch { return false; } };
const unknown = (): VisibleAcknowledgementOutcome => ({ outcome: 'unknown', reason: 'current-changed' });

/** Presence only: a stale scope must never fall back to a different delivery engine. */
export function hasGuiPiDesktopDeliveryScope(): boolean { return calls.getStore() !== undefined; }

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
    if (!result.ok || typeof result.text !== 'string' || Buffer.byteLength(result.text, 'utf8') > 131072) return false;
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

function captureBase(actor: { sessionId: string; turnId: string; isCurrent(): boolean }, context: Context, extra: () => boolean) {
  const call = calls.getStore(), gui = currentGuiExecutionTurn();
  if (!call || !call.active || !call.owner.isLive(call) || !call.owner.hasGlobalBinding(call) || !gui || !gui.desktopTurnId || !gui.isDesktopCurrent ||
      gui.turnId !== call.turn.hostId || !actor || actor.sessionId !== gui.sessionId || actor.turnId !== gui.desktopTurnId ||
      typeof actor.isCurrent !== 'function' || context?.lease?.owner !== gui.sessionId || context.lease.turnId !== gui.desktopTurnId ||
      typeof context.lease.isCurrent !== 'function' || !context.lease.signal ||
      typeof context.isIndicatorCurrent !== 'function' || typeof context.isTargetCurrent !== 'function' || typeof extra !== 'function') {
    throw new Error('The originating GUI Pi desktop delivery context is unavailable');
  }
  const { lease, indicatorEpoch } = context;
  const indicatorCurrent = context.isIndicatorCurrent.bind(context), targetCurrent = context.isTargetCurrent.bind(context);
  const actorCurrent = actor.isCurrent.bind(actor);
  const current = () => call.owner.isLive(call) && live(gui.isDesktopCurrent!) && live(actorCurrent) &&
    live(() => lease.isCurrent()) && !lease.signal.aborted && live(() => indicatorCurrent(indicatorEpoch)) &&
    live(targetCurrent) && live(extra);
  if (!current()) throw new Error('The GUI Pi desktop delivery context is no longer current');
  const guardedLease: DesktopDeliveryLease = Object.freeze({ owner: lease.owner, turnId: lease.turnId,
    signal: AbortSignal.any([lease.signal, call.signal, call.lifetime.signal, call.turn.lifetime.signal]), isCurrent: current });
  return { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent };
}

/** Available only while this supervised Pi worker's host tool is executing. */
export function captureGuiPiCuaDeliverySlot(request: Parameters<CuaPersistedAction>[0], context: Context): CuaHostDeliverySlot {
  if (!request || typeof request.isTargetCurrent !== 'function' || !request.targetGeneration) throw new Error('The GUI Pi desktop target is unavailable');
  const { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent } =
    captureBase(request.actor, context, request.isTargetCurrent.bind(request));
  return Object.freeze({ lease: guardedLease, indicatorEpoch, isIndicatorCurrent: indicatorCurrent, isTargetCurrent: targetCurrent,
    stageDelivery(invocationId: string, value: CuaSemanticEffect, acknowledge: Candidate['acknowledge']): void {
      const effect = effectKey(value);
      if (!call.active || !current() || call.candidate || !/^[0-9a-f-]{36}$/i.test(invocationId) || !effect || typeof acknowledge !== 'function') {
        call.poisoned = true; call.lifetime.abort(); throw new Error('The GUI Pi desktop delivery candidate is invalid');
      }
      call.candidate = { invocationId, effect, kind: 'cua', current, acknowledge };
      try { call.candidate.global = call.owner.stageGlobal(call, call.candidate, value, guardedLease.signal); }
      catch (error) { call.poisoned = true; call.lifetime.abort(); throw error; }
    } });
}

export function captureGuiPiWin32DeliverySlot(actor: Win32VisibleActor,
  context: Context & Pick<Win32VisibleDeliverySlot, 'isPointOnTarget' | 'onUnknown'>): Win32VisibleDeliverySlot {
  if (typeof context?.onUnknown !== 'function' ||
      (context.isPointOnTarget !== undefined && typeof context.isPointOnTarget !== 'function')) throw new Error('The GUI Pi Windows desktop delivery context is unavailable');
  const { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent } = captureBase(actor, context, () => true);
  return Object.freeze({ lease: guardedLease, indicatorEpoch, isIndicatorCurrent: indicatorCurrent, isTargetCurrent: targetCurrent,
    ...(context.isPointOnTarget ? { isPointOnTarget: context.isPointOnTarget.bind(context) } : {}), onUnknown: context.onUnknown.bind(context),
    stageDelivery(invocationId: string, value: Win32VisibleEffect, acknowledge: Candidate['acknowledge']): void {
      const effect = win32EffectKey(value);
      if (!call.active || !current() || call.candidate || !/^[0-9a-f-]{36}$/i.test(invocationId) || !effect || typeof acknowledge !== 'function') {
        call.poisoned = true; call.lifetime.abort(); throw new Error('The GUI Pi Windows delivery candidate is invalid');
      }
      call.candidate = { invocationId, effect, kind: 'win32', current, acknowledge };
      try { call.candidate.global = call.owner.stageGlobal(call, call.candidate, value, guardedLease.signal); }
      catch (error) { call.poisoned = true; call.lifetime.abort(); throw error; }
    } });
}

/** Parent-owned candidates; the one-time proof travels only on private worker IPC. */
export class GuiPiDesktopDelivery {
  private turn?: Turn;
  private closed = false;
  private readonly connectionId = randomUUID();
  constructor(private readonly getHostTurn: () => string | undefined, private readonly connectionCurrent: () => boolean,
    private readonly report: (reason: string) => void, private readonly timeoutMs = 5000,
    private readonly globalDelivery?: PiGlobalDeliveryAccess) {}

  hasGlobalBinding(call: Call): boolean {
    return !this.globalDelivery || (typeof call.name === 'string' && !!call.name.trim() && call.name.length <= 1024);
  }
  /** Called by the private action slot only after its known result was persisted. */
  stageGlobal(call: Call, candidate: Candidate, value: unknown, signal: AbortSignal): PiGlobalDeliveryStage | undefined {
    if (!this.globalDelivery) return undefined;
    if (!call.name || !candidate.current()) throw new Error('GUI Pi global delivery context changed');
    return stagePiGlobalDelivery(this.globalDelivery, { engine: 'gui-pi', connectionId: this.connectionId,
      hostTurnId: call.turn.hostId, engineTurnId: String(call.turn.generation), toolCallId: call.id, toolName: call.name },
    candidate.kind, candidate.invocationId, value, signal, candidate.current);
  }

  begin(generation: number, hostId: string): void {
    if (this.closed || this.turn || !Number.isSafeInteger(generation) || generation < 1 || !hostId ||
        this.getHostTurn() !== hostId || !live(this.connectionCurrent)) throw new Error('GUI Pi desktop turn is unavailable');
    this.turn = { generation, hostId, lifetime: new AbortController(), seen: new Set(), calls: new Map() };
  }
  isLive(call: Call): boolean {
    return !this.closed && this.turn === call.turn && !call.turn.lifetime.signal.aborted && !call.signal.aborted &&
      !call.lifetime.signal.aborted && !call.poisoned && this.getHostTurn() === call.turn.hostId &&
      live(this.connectionCurrent) && live(call.isCurrent);
  }
  async run(input: { generation: number | undefined; id: string; name?: string; signal: AbortSignal; isCurrent(): boolean },
    execute: () => Promise<GuiHostToolResult>): Promise<PiPrivateToolResult> {
    const turn = this.turn;
    if (!turn || input.generation !== turn.generation || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 1024 ||
        turn.seen.size >= 4096 || turn.calls.size >= 256) return calls.exit(execute);
    if (turn.seen.has(input.id)) {
      const previous = turn.calls.get(input.id);
      if (previous) { previous.poisoned = true; this.retire(previous); }
      throw new Error('Duplicate GUI Pi host tool call identity');
    }
    turn.seen.add(input.id);
    const call: Call = { ...input, owner: this, turn, lifetime: new AbortController(), active: true, poisoned: false, consuming: false };
    turn.calls.set(call.id, call);
    let awaiting = false;
    try {
      const result = await calls.run(call, execute);
      if (!call.candidate) return result;
      if (!call.candidate.current() || !matches(result, call.candidate)) {
        this.notify('desktop-result-unconfirmed');
        return { ok: false, text: 'Desktop action result is unconfirmed; inspect the unresolved action before retrying.' };
      }
      if (call.candidate.global) bindPiGlobalDelivery(call.candidate.global, result.text);
      call.proof = randomBytes(32).toString('base64url');
      call.textDigest = createHash('sha256').update(result.text, 'utf16le').digest('hex');
      awaiting = true;
      return { ...result, desktopDeliveryProof: call.proof };
    } catch (error) {
      if (call.candidate) this.notify('tool-failed-after-desktop-action');
      throw error;
    } finally {
      call.active = false;
      if (!awaiting) this.retire(call);
    }
  }
  async acknowledge(generation: number | undefined, id: unknown, proof: unknown, textDigest: unknown,
    signal: AbortSignal): Promise<VisibleAcknowledgementOutcome> {
    const call = typeof id === 'string' ? this.turn?.calls.get(id) : undefined;
    if (!call || call.turn.generation !== generation || typeof proof !== 'string' || proof !== call.proof ||
        typeof textDigest !== 'string' || textDigest !== call.textDigest ||
        call.consuming || !call.candidate || signal.aborted || !call.candidate.current()) return unknown();
    call.consuming = true;
    const cancel = (): void => { call.lifetime.abort(); };
    signal.addEventListener('abort', cancel, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      if (signal.aborted) { cancel(); return unknown(); }
      const cancelled = new Promise<VisibleAcknowledgementOutcome>(resolve => {
        const onAbort = (): void => resolve(unknown());
        call.lifetime.signal.addEventListener('abort', onAbort, { once: true });
        if (call.lifetime.signal.aborted) onAbort();
      });
      const timed = new Promise<VisibleAcknowledgementOutcome>(resolve => {
        timer = setTimeout(() => { cancel(); resolve(unknown()); }, this.timeoutMs);
        timer.unref?.();
      });
      const candidate = call.candidate;
      const acknowledge = () => candidate.acknowledge(`visible-action:${candidate.invocationId}`);
      const outcome = await Promise.race([candidate.global ? acknowledgePiGlobalDelivery(candidate.global, acknowledge) : acknowledge(), cancelled, timed]);
      if (!call.candidate.current()) { this.notify('desktop-acknowledgement-invalidated'); return unknown(); }
      if (outcome.outcome !== 'acknowledged') this.notify('desktop-acknowledgement-unknown');
      return outcome;
    } catch {
      this.notify('desktop-acknowledgement-failed');
      return { outcome: 'unknown', reason: 'acknowledgement-failed' };
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      this.retire(call);
    }
  }
  abandon(generation: number | undefined, id: unknown, proof: unknown): void {
    const call = typeof id === 'string' ? this.turn?.calls.get(id) : undefined;
    if (!call || call.turn.generation !== generation || typeof proof !== 'string' || proof !== call.proof) return;
    this.retire(call); this.notify('desktop-result-not-confirmed');
  }
  end(): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined; turn.lifetime.abort();
    for (const call of turn.calls.values()) {
      call.lifetime.abort();
      if (call.candidate) this.notify('desktop-result-not-confirmed');
    }
    turn.calls.clear();
  }
  close(): void { this.closed = true; this.end(); }
  private retire(call: Call): void { call.lifetime.abort(); if (call.turn.calls.get(call.id) === call) call.turn.calls.delete(call.id); }
  private notify(reason: string): void { try { this.report(reason); } catch { /* diagnostic only */ } }
}
