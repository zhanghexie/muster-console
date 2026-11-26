import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { CuaHostDeliverySlot } from '../desktop/cuaVisibleAction';
import type { CuaPersistedAction, CuaSemanticEffect } from '../desktop/cuaSemanticRuntime';
import type { DesktopDeliveryLease } from '../desktop/desktopTurns';
import type { VisibleIndicatorEpoch } from '../desktop/visibleActionCoordinator';
import type { Win32VisibleActor, Win32VisibleDeliverySlot, Win32VisibleEffect } from '../desktop/win32VisibleControl';
import { PiToolDeliveryTracker } from '../agentSession/piToolDelivery';
import { acknowledgePiGlobalDelivery, bindPiGlobalDelivery, stagePiGlobalDelivery,
  type PiGlobalDeliveryAccess, type PiGlobalDeliveryStage } from '../agentSession/piGlobalDelivery';
import { currentSchedulerDesktopExecutionTurn, runAsCapturedSchedulerDesktopTurn, type SchedulerDesktopExecutionTurn } from './agentScope';
import { withDesktopCaptureImageScope, type DesktopCaptureImage } from '../desktop/captureImageScope';
import { isDesktopLookCall } from '../desktop/lookInvocation';

type ToolOutput = { content: Array<{ type: 'text'; text: string } | DesktopCaptureImage>; details: Record<string, never> };
type SlotContext = { lease: DesktopDeliveryLease; indicatorEpoch: VisibleIndicatorEpoch;
  isIndicatorCurrent(epoch: VisibleIndicatorEpoch): boolean; isTargetCurrent(): boolean };
type Candidate = { invocationId: string; effect: string; kind: 'cua' | 'win32';
  current(): boolean; acknowledge: Parameters<CuaHostDeliverySlot['stageDelivery']>[2]; global?: PiGlobalDeliveryStage };
type Call = { id: string; name: string; signal?: AbortSignal; turn?: Readonly<SchedulerDesktopExecutionTurn>;
  active: boolean; poisoned: boolean; lifetime: AbortController; candidate?: Candidate; owner: SchedulerPiDelivery };

const calls = new AsyncLocalStorage<Call>();
/** Presence only: capture still validates the full live host/tool binding. */
export function hasSchedulerPiDesktopDeliveryScope(): boolean { return calls.getStore() !== undefined; }
const failed = (): ToolOutput => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false,
  error: 'Desktop action result is unconfirmed; inspect the unresolved action before retrying.' }) }], details: {} });
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

function deliveredEffect(output: ToolOutput, candidate: Candidate): boolean {
  try {
    if (!output || output.content.length !== 1 || output.content[0]?.type !== 'text' || typeof output.content[0].text !== 'string') return false;
    const payload: unknown = JSON.parse(output.content[0].text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const outer = payload as Record<string, unknown>;
    const result = outer.result;
    if (outer.ok !== true || Object.keys(outer).some(key => key !== 'ok' && key !== 'result') ||
        !result || typeof result !== 'object' || Array.isArray(result)) return false;
    const body = result as Record<string, unknown>;
    if (body.outcome !== 'dispatched' || body.invocationId !== candidate.invocationId) return false;
    return candidate.kind === 'cua'
      ? Object.keys(body).every(key => ['outcome', 'invocationId', 'ok', 'delivery', 'effect', 'verification', 'code'].includes(key)) &&
        effectKey(body) === candidate.effect
      : Object.keys(body).every(key => ['outcome', 'invocationId', 'value'].includes(key)) && win32EffectKey(body.value) === candidate.effect;
  } catch { return false; }
}

/** Called only by a host semantic-action bridge while the originating Pi tool is executing. */
function captureBase(actor: { sessionId: string; turnId: string; isCurrent(): boolean }, context: SlotContext, extra: () => boolean) {
  const call = calls.getStore();
  if (!call || !call.active || call.poisoned || !call.owner.canStage(call) || !context ||
      !actor || actor.sessionId !== call.turn?.sessionId || actor.turnId !== call.turn.desktopTurnId ||
      typeof actor.isCurrent !== 'function' || typeof extra !== 'function' ||
      !context.lease || typeof context.lease.isCurrent !== 'function' || !context.lease.signal ||
      context.lease.owner !== actor.sessionId || context.lease.turnId !== actor.turnId ||
      typeof context.isIndicatorCurrent !== 'function' || typeof context.isTargetCurrent !== 'function') {
    throw new Error('The originating scheduler Pi delivery context is unavailable');
  }
  const { lease, indicatorEpoch } = context;
  const indicatorCurrent = context.isIndicatorCurrent.bind(context), targetCurrent = context.isTargetCurrent.bind(context);
  const actorCurrent = actor.isCurrent.bind(actor);
  const current = () => call.owner.canStage(call) && live(actorCurrent) && live(() => lease.isCurrent()) && !lease.signal.aborted &&
    live(() => indicatorCurrent(indicatorEpoch)) && live(targetCurrent) && live(extra);
  if (!current()) throw new Error('The scheduler desktop delivery context is no longer current');
  // The coordinator awaits its task lock. Its own current checks must still
  // see a late Pi abort, duplicate ID or session close after receipt observation.
  const guardedLease: DesktopDeliveryLease = Object.freeze({
    owner: lease.owner, turnId: lease.turnId,
    signal: AbortSignal.any([lease.signal, call.signal!, call.lifetime.signal]), isCurrent: current
  });
  return { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent };
}

/** Called only by a host semantic-action bridge while the originating Pi tool is executing. */
export function captureSchedulerPiCuaDeliverySlot(request: Parameters<CuaPersistedAction>[0], context: SlotContext): CuaHostDeliverySlot {
  if (!request || typeof request.isTargetCurrent !== 'function' || !request.targetGeneration) throw new Error('The scheduler desktop target is unavailable');
  const { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent } =
    captureBase(request.actor, context, request.isTargetCurrent.bind(request));
  return Object.freeze({ lease: guardedLease, indicatorEpoch, isIndicatorCurrent: indicatorCurrent, isTargetCurrent: targetCurrent,
    stageDelivery(invocationId: string, value: CuaSemanticEffect, acknowledge: Candidate['acknowledge']): void {
      const effect = effectKey(value);
      if (!call.active || !current() || call.candidate || typeof invocationId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(invocationId) || !effect || typeof acknowledge !== 'function') {
        call.poisoned = true;
        throw new Error('The scheduler desktop delivery candidate is invalid');
      }
      call.candidate = { invocationId, effect, kind: 'cua', current, acknowledge };
      try { call.candidate.global = call.owner.stageGlobal(call, call.candidate, value, guardedLease.signal); }
      catch (error) { call.poisoned = true; call.lifetime.abort(); throw error; }
    }
  });
}

/** Bind a Windows coordinate/focus/launch result to the same native Pi turn. */
export function captureSchedulerPiWin32DeliverySlot(actor: Win32VisibleActor,
  context: SlotContext & Pick<Win32VisibleDeliverySlot, 'isPointOnTarget' | 'onUnknown'>): Win32VisibleDeliverySlot {
  if (typeof context?.onUnknown !== 'function' ||
      (context.isPointOnTarget !== undefined && typeof context.isPointOnTarget !== 'function')) {
    throw new Error('The scheduler Windows desktop delivery context is unavailable');
  }
  const { call, current, guardedLease, indicatorEpoch, indicatorCurrent, targetCurrent } = captureBase(actor, context, () => true);
  return Object.freeze({ lease: guardedLease, indicatorEpoch, isIndicatorCurrent: indicatorCurrent, isTargetCurrent: targetCurrent,
    ...(context.isPointOnTarget ? { isPointOnTarget: context.isPointOnTarget.bind(context) } : {}), onUnknown: context.onUnknown.bind(context),
    stageDelivery(invocationId: string, value: Win32VisibleEffect, acknowledge: Candidate['acknowledge']): void {
      const effect = win32EffectKey(value);
      if (!call.active || !current() || call.candidate || typeof invocationId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(invocationId) || !effect || typeof acknowledge !== 'function') {
        call.poisoned = true;
        throw new Error('The scheduler Windows desktop delivery candidate is invalid');
      }
      call.candidate = { invocationId, effect, kind: 'win32', current, acknowledge };
      try { call.candidate.global = call.owner.stageGlobal(call, call.candidate, value, guardedLease.signal); }
      catch (error) { call.poisoned = true; call.lifetime.abort(); throw error; }
    } });
}

/** One instance per actual in-process scheduler Pi session, never model supplied. */
export class SchedulerPiDelivery {
  private tracker?: PiToolDeliveryTracker;
  private agent?: Agent;
  private readonly inflight = new Map<string, Call>();
  private readonly connectionId = randomUUID();
  private readonly engineTurns = new WeakMap<AbortSignal, string>();
  private closed = false;
  constructor(private readonly report: (reason: string) => void = reason =>
    console.warn('[scheduler-pi-delivery] unconfirmed; inspect durable state:', reason),
    private readonly globalDelivery?: PiGlobalDeliveryAccess) {}

  /** Called by the private action slot only after its known result was persisted. */
  stageGlobal(call: Call, candidate: Candidate, value: unknown, signal: AbortSignal): PiGlobalDeliveryStage | undefined {
    if (!this.globalDelivery) return undefined;
    if (!call.signal || !call.turn || !candidate.current()) throw new Error('Scheduler Pi global delivery context changed');
    let engineTurnId = this.engineTurns.get(call.signal);
    if (!engineTurnId) { engineTurnId = randomUUID(); this.engineTurns.set(call.signal, engineTurnId); }
    return stagePiGlobalDelivery(this.globalDelivery, { engine: 'scheduler-pi', connectionId: this.connectionId,
      hostTurnId: call.turn.desktopTurnId, engineTurnId, toolCallId: call.id, toolName: call.name },
    candidate.kind, candidate.invocationId, value, signal, candidate.current);
  }

  attach(agent: Agent): void {
    if (this.closed || this.tracker || !agent || typeof agent.subscribe !== 'function' ||
        !agent.state || !Array.isArray(agent.state.messages)) throw new Error('A host-owned Pi agent is required');
    this.agent = agent;
    this.tracker = new PiToolDeliveryTracker(agent);
  }

  canStage(call: Call): boolean {
    return !this.closed && !call.poisoned && !call.lifetime.signal.aborted && !!this.tracker && !!this.agent && !!call.signal &&
      typeof call.id === 'string' && !!call.id.trim() && call.id.length <= 1024 &&
      typeof call.name === 'string' && !!call.name.trim() && call.name.length <= 1024 &&
      this.agent.signal === call.signal && !call.signal.aborted && !!call.turn && live(call.turn.isDesktopCurrent);
  }

  async run(id: string, name: string, signal: AbortSignal | undefined, execute: () => Promise<ToolOutput>): Promise<ToolOutput> {
    const existing = this.inflight.get(id);
    if (existing) {
      existing.poisoned = true;
      existing.lifetime.abort();
      this.report('duplicate-tool-call-id');
      throw new Error('Duplicate Pi tool call ID; desktop delivery cannot be confirmed');
    }
    const call: Call = { id, name, signal, turn: currentSchedulerDesktopExecutionTurn(), active: true, poisoned: false,
      lifetime: new AbortController(), owner: this };
    this.inflight.set(id, call);
    let awaitingReceipt = false;
    try {
      const output = await calls.run(call, execute);
      const candidate = call.candidate;
      if (!candidate) return output;
      if (!candidate.current() || !deliveredEffect(output, candidate)) {
        this.report('semantic-result-unconfirmed');
        return failed();
      }
      try {
        const first = output.content[0];
        if (!first || first.type !== 'text') throw new Error('Desktop tool result has no text');
        if (candidate.global) bindPiGlobalDelivery(candidate.global, first.text);
        this.tracker!.expect({ toolCallId: id, toolName: name, outputText: first.text,
          isCurrent: candidate.current,
          acknowledge: async () => {
            // The Cua slot type still requires an argument. The dispatcher-owned
            // closure ignores it and derives its stable receipt from invocationId.
            try {
              const acknowledge = () => candidate.acknowledge(candidate.invocationId);
              return await (candidate.global ? acknowledgePiGlobalDelivery(candidate.global, acknowledge) : acknowledge());
            }
            finally { call.lifetime.abort(); if (this.inflight.get(id) === call) this.inflight.delete(id); }
          },
          onUnconfirmed: reason => {
            call.lifetime.abort();
            if (this.inflight.get(id) === call) this.inflight.delete(id);
            this.report(reason);
          } });
        awaitingReceipt = true;
      } catch {
        this.report('expectation-unconfirmed');
        return failed();
      }
      return output;
    } catch (error) {
      if (call.candidate) this.report('tool-failed-after-desktop-action');
      throw error;
    } finally {
      call.active = false;
      if (!awaitingReceipt) {
        call.lifetime.abort();
        if (this.inflight.get(id) === call) this.inflight.delete(id);
      }
    }
  }

  /** Stop accepting late receipts even if Pi never emits agent_end. */
  endTurn(): void {
    for (const call of this.inflight.values()) { call.poisoned = true; call.lifetime.abort(); }
    this.tracker?.invalidate();
    this.inflight.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.inflight.values()) { call.poisoned = true; call.lifetime.abort(); }
    this.tracker?.close();
    this.inflight.clear();
  }
}

/** Shared by the real scheduler registration and the offline integration fixture. */
export function executeSchedulerPiTool<T>(input: {
  delivery: SchedulerPiDelivery; id: string; name: string; signal?: AbortSignal; params: Record<string, unknown>;
  /** The live model, not just the Pi runtime, must support image input. */
  supportsCaptureImages?(): boolean;
  resolve(params: Record<string, unknown>): { ok: true; args: unknown } | { ok: false; error: string };
  execute(args: unknown): Promise<T>; serialize(result: T, args: unknown): string; afterExecute?(result: T): void;
}): Promise<ToolOutput> {
  return runAsCapturedSchedulerDesktopTurn(() => input.delivery.run(input.id, input.name, input.signal, async () => {
    const execute = async (): Promise<{ output: ToolOutput; success: boolean }> => {
      const resolved = input.resolve(input.params);
      if (!resolved.ok) return { output: { content: [{ type: 'text', text: resolved.error }], details: {} }, success: false };
      const result = await input.execute(resolved.args);
      input.afterExecute?.(result);
      return { output: { content: [{ type: 'text', text: input.serialize(result, resolved.args) }], details: {} },
        success: !!result && typeof result === 'object' && 'ok' in result && result.ok === true };
    };
    const captured = isDesktopLookCall(input.name, input.params) && input.supportsCaptureImages?.() === true
      ? await withDesktopCaptureImageScope(execute) : { value: await execute(), image: undefined, imageCurrent: undefined };
    if (captured.value.success && captured.image) {
      if (input.signal?.aborted || captured.imageCurrent?.() !== true) throw new Error('Desktop screenshot authorization changed');
      captured.value.output.content.push(captured.image);
    }
    return captured.value.output;
  }));
}
