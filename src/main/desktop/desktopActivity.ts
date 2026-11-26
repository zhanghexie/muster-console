import type { DesktopIndicatorSnapshot } from '../../shared/desktopIndicator';
import type { HostDesktopContinuation, HostDesktopContinuationOrigin } from '../../shared/hostNotification';
import { DesktopCoordinator } from './desktopCoordinator';
import type { DesktopRun } from './desktopRun';
import type { DesktopResumeState } from './desktopResumeState';

type RunState = 'active' | 'finishing' | 'stopping' | 'stopped' | 'unknown';
type Indicator = { show(snapshot: DesktopIndicatorSnapshot): Promise<void>; close(): void };
type Entry = { owner: string; turnId: string; target: string; current(): boolean; state: RunState; run?: DesktopRun };
export interface DesktopActivityHandle { readonly owner: string; readonly turnId: string; readonly run: DesktopRun }
declare const desktopTurnBrand: unique symbol;
export interface DesktopActivityTurn { readonly [desktopTurnBrand]: true }
declare const desktopInstructionBrand: unique symbol;
export interface DesktopUserInstruction { readonly [desktopInstructionBrand]: true }

/** Keeps the one seat and its indicator alive between calls in a trusted turn. */
export class DesktopActivity {
  private readonly coordinator: DesktopCoordinator;
  private readonly entries = new Map<string, Entry>();
  private revision = 0;
  private rendered: Promise<void> = Promise.resolve();
  private visibilityFailure: Error | undefined;
  private escapeAvailable = false;
  private generation = 0;
  private instructionRequired = false;
  private resumeStateFailure: Error | undefined;
  private readonly resumedOwners = new Map<string, number>();
  private readonly turns = new WeakMap<DesktopActivityTurn, { owner: string; turnId: string; current(): boolean; generation: number;
    instruction?: DesktopUserInstruction; continuation?: HostDesktopContinuation; workspaceId?: string }>();
  private readonly instructions = new WeakMap<DesktopUserInstruction, { owner: string; generation: number }>();

  constructor(private readonly indicator: Indicator, releaseAll: () => Promise<void>,
    private readonly labels: DesktopIndicatorSnapshot['labels'],
    private readonly theme?: DesktopIndicatorSnapshot['theme'], stopBackend?: () => Promise<void>,
    private readonly resumeState?: DesktopResumeState, private readonly onResumeStateError?: (error: Error) => void) {
    try { this.instructionRequired = resumeState?.hasStopped() === true; }
    catch (error) { this.instructionRequired = true; this.latchResumeStateFailure(error); }
    this.coordinator = new DesktopCoordinator(releaseAll, (owner, state) => this.changed(owner, state), stopBackend);
  }

  /** Capture at trusted turn start, including turns that have not yet used the desktop. */
  createTurn(owner: string, turnId: string, current: () => boolean, instruction?: DesktopUserInstruction,
    continuation?: HostDesktopContinuation, workspaceId?: string): DesktopActivityTurn {
    if (!owner || !turnId || typeof current !== 'function' || !current()) throw new Error('Desktop turn is unavailable');
    const token = Object.freeze({}) as DesktopActivityTurn;
    this.turns.set(token, { owner, turnId, current, generation: this.generation, ...(instruction ? { instruction } : {}),
      ...(continuation ? { continuation } : {}), ...(workspaceId ? { workspaceId } : {}) });
    return token;
  }

  async start(token: DesktopActivityTurn, target: string): Promise<DesktopActivityHandle> {
    const turn = this.turns.get(token);
    if (!turn || turn.generation !== this.generation || !turn.current()) throw new Error('Desktop turn is unavailable or was stopped');
    const { owner, turnId } = turn;
    if (this.resumeStateFailure) throw new Error('Desktop stop state is unavailable; inspect the previous stop before continuing', { cause: this.resumeStateFailure });
    if (turn.continuation) this.assertContinuation(owner, turn.workspaceId ?? '', turn.continuation);
    if (this.instructionRequired && this.resumedOwners.get(owner) !== this.generation) {
      if (!this.ownerResumed(owner)) throw new Error('A new user instruction is required for this desktop session');
    }
    if (this.instructionRequired) {
      const accepted = turn.instruction && this.instructions.get(turn.instruction);
      if ((!accepted || accepted.owner !== owner || accepted.generation !== this.generation) && !turn.continuation) {
        throw new Error('A new user instruction is required for this desktop session');
      }
    }
    const current = () => turn.generation === this.generation && turn.current() &&
      (!turn.continuation || this.continuationCurrent(owner, turn.workspaceId ?? '', turn.continuation));
    const previous = this.entries.get(owner);
    if (previous && previous.state !== 'stopped') throw new Error('Desktop activity is still active');
    if (previous?.turnId === turnId) throw new Error('The stopped desktop turn cannot restart');
    if (this.visibilityFailure && [...this.entries.values()].some(entry => entry.state !== 'stopped')) throw this.visibilityFailure;
    const entry: Entry = { owner, turnId, target: target.slice(0, 160), current, state: 'active' };
    this.entries.set(owner, entry);
    this.visibilityFailure = undefined;
    try {
      const run = await this.coordinator.start(owner);
      entry.run = run;
      await this.rendered;
      if (this.visibilityFailure) throw this.visibilityFailure;
      if (!entry.current() || run.status !== 'active' || this.entries.get(owner) !== entry) throw new Error('Desktop turn ended before the indicator was ready');
      return Object.freeze({ owner, turnId, run });
    } catch (error) {
      // This run has not been handed to a caller, so no action can have been
      // dispatched through it. Retire it without stopping unrelated owners.
      // A real indicator failure is handled globally by scheduleRender().
      if (entry.run) entry.run.stop();
      if (!entry.run && this.entries.get(owner) === entry) {
        if (previous) this.entries.set(owner, previous); else this.entries.delete(owner);
        this.scheduleRender();
      }
      throw error;
    }
  }

  async execute<T>(handle: DesktopActivityHandle, action: (signal: AbortSignal) => Promise<T>, mutation = true): Promise<T> {
    if (this.visibilityFailure) throw this.visibilityFailure;
    const entry = this.entries.get(handle.owner);
    if (!entry || entry.turnId !== handle.turnId || entry.run !== handle.run || !entry.current()) throw new Error('Desktop turn is no longer current');
    await this.rendered;
    if (this.visibilityFailure) throw this.visibilityFailure;
    if (!entry.current() || this.entries.get(handle.owner) !== entry) throw new Error('Desktop turn is no longer current');
    return this.coordinator.execute(handle.owner, handle.run, action, mutation);
  }

  /** Host shutdown may wait for the current render chain; this is not a backend recovery receipt. */
  async flushRendering(): Promise<void> {
    for (;;) {
      const pending = this.rendered;
      await pending;
      if (pending === this.rendered) break;
    }
    if (this.visibilityFailure) throw this.visibilityFailure;
  }

  finish(handle: DesktopActivityHandle): void {
    const entry = this.entries.get(handle.owner);
    if (entry?.turnId === handle.turnId && entry.run === handle.run) this.coordinator.finish(handle.owner, handle.run);
  }

  /** The host turn became invalid: abort its work, without inventing user takeover. */
  cancel(handle: DesktopActivityHandle): void {
    const entry = this.entries.get(handle.owner);
    if (entry?.turnId === handle.turnId && entry.run === handle.run) handle.run.stop();
  }

  stop(persist = true): Promise<void> {
    this.generation++; this.instructionRequired = true;
    // Cancel queued and in-flight input before doing synchronous persistence.
    const stopping = this.coordinator.stop();
    if (persist) this.recordStop();
    if (!this.resumeStateFailure) return stopping;
    const failure = this.resumeStateFailure;
    return stopping.then(() => { throw failure; }, error => { throw new AggregateError([error, failure], 'Desktop stop and state persistence failed'); });
  }

  /** Capture at acceptance, not later when a queued instruction is dispatched. */
  noteUserInstruction(owner: string): DesktopUserInstruction {
    if (!owner) throw new Error('Desktop instruction owner is required');
    const token = Object.freeze({}) as DesktopUserInstruction;
    this.instructions.set(token, { owner, generation: this.generation });
    return token;
  }

  /** Host-only: an instruction accepted before the latest stop cannot resume. */
  async resumeForUserInstruction(owner: string, token: DesktopUserInstruction): Promise<void> {
    const instruction = this.instructions.get(token);
    if (!instruction || instruction.owner !== owner || instruction.generation !== this.generation) throw new Error('Desktop instruction predates the latest stop');
    if (this.resumeStateFailure) throw new Error('Desktop stop state is unavailable; inspect the previous stop before continuing', { cause: this.resumeStateFailure });
    await this.coordinator.resumeForUserInstruction(owner);
    if (instruction.generation !== this.generation) {
      await this.stop();
      throw new Error('Desktop instruction predates the latest stop');
    }
    if (this.resumeStateFailure) throw new Error('Desktop stop state is unavailable; inspect the previous stop before continuing', { cause: this.resumeStateFailure });
    try { this.resumeState?.markResumed(owner); }
    catch (error) { this.latchResumeStateFailure(error); throw this.resumeStateFailure; }
    if (!this.resumedOwners.has(owner) && this.resumedOwners.size >= 512) this.resumedOwners.delete(this.resumedOwners.keys().next().value!);
    this.resumedOwners.set(owner, this.generation);
  }

  /** Verify host-owned continuation evidence against the current durable stop state. */
  assertContinuation(owner: string, workspaceId: string, continuation: HostDesktopContinuation): void {
    if (!owner || !workspaceId || typeof continuation?.allows !== 'function') throw new Error('Desktop continuation source is unavailable');
    const stopGeneration = this.currentStopGeneration();
    if (this.instructionRequired && !this.persistedOwnerResumed(owner)) throw new Error('A new user instruction is required for this desktop session');
    if (continuation.allows({ owner, workspaceId, stopGeneration }) !== true) throw new Error('Desktop continuation source is unavailable or was stopped');
  }

  continuationCurrent(owner: string, workspaceId: string, continuation: HostDesktopContinuation): boolean {
    try { this.assertContinuation(owner, workspaceId, continuation); return true; } catch { return false; }
  }

  /** Snapshot at the trusted tool call; resolve only after its turn became ready. */
  captureContinuationOrigin(token: DesktopActivityTurn, workspaceId: string): (() => HostDesktopContinuationOrigin | undefined) | undefined {
    const turn = this.turns.get(token);
    if (!turn || !workspaceId || turn.workspaceId !== workspaceId || turn.generation !== this.generation || !turn.current()) return undefined;
    const accepted = turn.instruction && this.instructions.get(turn.instruction);
    if (this.instructionRequired && (!accepted || accepted.owner !== turn.owner || accepted.generation !== this.generation) && !turn.continuation) return undefined;
    const stopGeneration = this.currentStopGeneration();
    return () => {
      if (turn.generation !== this.generation || this.currentStopGeneration() !== stopGeneration) return undefined;
      if (this.instructionRequired && !this.persistedOwnerResumed(turn.owner)) return undefined;
      if (turn.continuation && !this.continuationCurrent(turn.owner, turn.workspaceId ?? '', turn.continuation)) return undefined;
      return { owner: turn.owner, workspaceId, stopGeneration };
    };
  }

  private currentStopGeneration(): number {
    if (this.resumeStateFailure) throw new Error('Desktop stop state is unavailable; inspect the previous stop before continuing', { cause: this.resumeStateFailure });
    if (typeof this.resumeState?.currentGeneration !== 'function') throw new Error('Durable desktop stop state is unavailable');
    try {
      const generation = this.resumeState.currentGeneration();
      if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid desktop stop generation');
      return generation;
    }
    catch (error) {
      this.latchResumeStateFailure(error);
      throw new Error('Desktop stop state is unavailable; inspect the previous stop before continuing', { cause: this.resumeStateFailure });
    }
  }

  private ownerResumed(owner: string): boolean {
    if (this.resumedOwners.get(owner) === this.generation) return true;
    return this.persistedOwnerResumed(owner);
  }

  private persistedOwnerResumed(owner: string): boolean {
    try { return this.resumeState?.isResumed(owner) === true; }
    catch (error) {
      this.latchResumeStateFailure(error);
      throw new Error('Desktop stop state is unavailable; inspect the previous stop before continuing', { cause: this.resumeStateFailure });
    }
  }

  setEscapeAvailable(available: boolean): void {
    if (this.escapeAvailable === available) return;
    this.escapeAvailable = available;
    this.scheduleRender();
  }

  /** Called by the independent window when it crashes or fails to show. */
  unavailable(reason: string): void {
    this.visibilityFailure = new Error(reason || 'Desktop indicator is unavailable');
    void this.stop().catch(() => undefined);
  }

  private changed(owner: string, state: RunState): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    entry.state = state;
    if (state === 'unknown') { this.generation++; this.instructionRequired = true; this.recordStop(); }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    const revision = ++this.revision;
    const update = this.rendered.then(async () => {
      // Coalesce transitions while preserving the most recent visible state.
      if (revision !== this.revision) return;
      const visible = [...this.entries.values()].filter(entry => entry.state !== 'stopped');
      if (!visible.length) { this.indicator.close(); return; }
      const state = visible.some(entry => entry.state === 'unknown') ? 'unknown'
        : visible.some(entry => entry.state === 'stopping' || entry.state === 'finishing') ? 'stopping' : 'active';
      await this.indicator.show({ revision, state, target: visible.map(entry => entry.target).filter(Boolean).join(', ').slice(0, 160),
        escapeAvailable: this.escapeAvailable, labels: this.labels, ...(this.theme ? { theme: this.theme } : {}) });
    });
    this.rendered = update.catch(error => {
      this.visibilityFailure = error instanceof Error ? error : new Error(String(error));
      void this.stop().catch(() => undefined);
    });
  }

  private recordStop(): void {
    if (this.resumeStateFailure) return;
    try { this.resumeState?.markStopped(); } catch (error) { this.latchResumeStateFailure(error); }
  }

  private latchResumeStateFailure(error: unknown): void {
    this.resumeStateFailure ??= error instanceof Error ? error : new Error(String(error));
    try { this.onResumeStateError?.(this.resumeStateFailure); } catch { /* keep the failure latched */ }
  }
}
