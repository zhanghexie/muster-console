import type { EventEnvelope, EventLog, EventLogInput, EventSubscription } from './eventLog';

export class EventPending extends Error {}

// Bounded dynamic-programming glob: * is one path segment, ** spans segments.
export function matchesFilePattern(pattern: string, filePath: string): boolean {
  const value = filePath.replace(/\\/g, '/');
  const tokens: Array<'star' | 'glob' | 'globDir' | string> = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '*') { tokens.push(pattern[i]!); continue; }
    if (pattern[i + 1] !== '*') { tokens.push('star'); continue; }
    while (pattern[i + 1] === '*') i++;
    if (pattern[i + 1] === '/') { tokens.push('globDir'); i++; } else tokens.push('glob');
  }
  let row = new Uint8Array(value.length + 1); row[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(value.length + 1);
    if (token === 'star' || token === 'glob') {
      next[0] = row[0]!;
      for (let j = 1; j <= value.length; j++) next[j] = row[j]! || (next[j - 1]! && (token === 'glob' || value[j - 1] !== '/')) ? 1 : 0;
    } else if (token === 'globDir') {
      let seen = false;
      for (let j = 0; j <= value.length; j++) { if (row[j]) seen = true; next[j] = row[j]! || (seen && j > 0 && value[j - 1] === '/') ? 1 : 0; }
    } else for (let j = 1; j <= value.length; j++) if (row[j - 1] && value[j - 1] === token) next[j] = 1;
    row = next;
  }
  return !!row[value.length];
}

export function matchesEvent(sub: EventSubscription, event: EventEnvelope, log?: EventLog): boolean {
  return event.sequence > sub.startCursor && event.source === sub.source &&
    (!event.workspaceId || event.workspaceId === sub.workspaceId) &&
    !(event.source === 'fact' && event.scope === sub.subject) &&
    !(event.source === 'fact' && event.type.startsWith('event.') && !sub.types.includes(event.type)) &&
    (!sub.types.length || sub.types.includes(event.type)) && (!sub.scope || sub.scope === event.scope) &&
    (!sub.pathPattern || (event.source === 'file' && !!log && (() => { const path = log.filePath(event.id); return path !== undefined && matchesFilePattern(sub.pathPattern!, path); })()));
}

/** Scans each durable cursor independently; a failed mailbox write never advances it. */
export class EventRouter {
  private active: Promise<void> | undefined;
  private requested = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = new Set<string>();
  private recentErrors = new Map<string, number>();
  private published = new Set<(event: EventEnvelope) => void>();
  private stopping = false;
  private closed = false;
  constructor(readonly log: EventLog, private deliver: (sub: EventSubscription, event: EventEnvelope) => Promise<void>,
    private precheck: (sub: EventSubscription, event: EventEnvelope) => boolean = () => true,
    private onError?: (error: unknown, workspaceId?: string) => void) {}

  private report(error: unknown, workspaceId?: string): void {
    console.error('[events] processing failed', error);
    const key = `${workspaceId ?? ''}:${error instanceof Error ? error.message : String(error)}`;
    const now = Date.now();
    if (now - (this.recentErrors.get(key) ?? -Infinity) < 60000) return;
    this.recentErrors.set(key, now);
    if (this.recentErrors.size > 100) this.recentErrors.delete(this.recentErrors.keys().next().value!);
    try { this.onError?.(error, workspaceId); } catch (notifyError) { console.error('[events] error notification failed', notifyError); }
  }

  start(): void {
    if (this.stopping) throw new Error('Event router is stopping');
    if (this.timer) return;
    this.timer = setInterval(() => { void this.replay().catch(error => this.report(error)); }, 30000);
    this.timer.unref?.();
    void this.replay().catch(error => this.report(error));
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  stopAdmission(): void { this.stopping = true; this.requested = false; this.stop(); this.published.clear(); }
  async shutdown(): Promise<void> { this.stopAdmission(); await Promise.allSettled([this.active]); this.closed = true; }
  isDelivering(id: string, sequence: number): boolean { return this.inFlight.has(`${id}:${sequence}`); }
  isSubscriptionDelivering(id: string): boolean { return [...this.inFlight].some(key => key.startsWith(`${id}:`)); }
  onPublished(listener: (event: EventEnvelope) => void): () => void {
    this.published.add(listener);
    return () => { this.published.delete(listener); };
  }

  publish(input: EventLogInput): { inserted: boolean; event: EventEnvelope } {
    if (this.closed) throw new Error('Event router is closed');
    let result;
    try { result = this.log.append(input); }
    catch (error) { this.report(error, input.workspaceId); throw error; }
    if (!this.stopping && result.inserted) for (const listener of this.published) {
      try { listener(result.event); } catch (error) { this.report(error, input.workspaceId); }
    }
    if (this.active) this.requested = true;
    else void this.replay().catch(error => this.report(error, input.workspaceId));
    return result;
  }

  replay(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.requested = true;
    if (this.active) return this.active;
    const job = Promise.resolve().then(async () => {
      try {
        while (this.requested && !this.stopping) { this.requested = false; await this.scan(); }
      } finally { this.active = undefined; }
    });
    this.active = job;
    return job;
  }

  private async scan(): Promise<void> {
    const now = Date.now();
    this.log.prune(now);
    const errors: string[] = [];
    for (const initial of this.log.subscriptions()) {
      if (this.stopping) break;
      // Old task-backed event subscriptions no longer represent a supported delivery target.
      if (initial.launchTaskId || initial.subject.startsWith('task:')) {
        this.log.unsubscribe(initial.id, initial.subject);
        continue;
      }
      if (initial.expiresAt !== null && initial.expiresAt <= now) continue;
      let cursor = initial.cursor;
      try {
        const pending = this.log.pendingPhase(initial.id);
        if (pending && pending.event.sequence <= cursor) this.log.clearPendingPhase(initial.id);
        else if (pending) {
          const event = pending.event;
          const latest = this.log.latestSequence('phase', initial.workspaceId, event.scope);
          if (latest !== event.sequence) {
            if (!this.log.advance(initial.id, cursor, event.sequence)) throw new Error('Subscription cursor changed');
            this.log.clearPendingPhase(initial.id);
            cursor = event.sequence;
          } else if (pending.dueAt > Date.now() || !this.log.mayDeliver(initial.id, initial.source, Date.now())) continue;
          else {
            const key = `${initial.id}:${event.sequence}`;
            this.inFlight.add(key);
            try { await this.deliver(initial, event); }
            finally { this.inFlight.delete(key); }
            this.log.finishDelivery(initial.id, initial.source, cursor, event.sequence, Date.now());
            this.log.clearPendingPhase(initial.id);
            cursor = event.sequence;
          }
        }
        for (;;) {
          if (this.stopping) break;
          const page = this.log.list({ after: cursor, source: initial.source, limit: 200 });
          if (!page.length) break;
          for (const event of page) {
            if (this.stopping) break;
            const current = this.log.subscriptions(initial.subject).find(s => s.id === initial.id);
            if (!current || current.cursor !== cursor || (current.expiresAt !== null && current.expiresAt <= Date.now())) break;
            if (!matchesEvent(current, event, this.log) || !this.precheck(current, event)) {
              if (!this.log.advance(current.id, cursor, event.sequence)) throw new Error('Subscription cursor changed');
            } else {
              if (!this.log.mayDeliver(current.id, current.source, Date.now())) break;
              const key = `${current.id}:${event.sequence}`;
              this.inFlight.add(key);
              try { await this.deliver(current, event); }
              finally { this.inFlight.delete(key); }
              this.log.finishDelivery(current.id, current.source, cursor, event.sequence, Date.now());
            }
            cursor = event.sequence;
          }
          if (cursor !== page[page.length - 1]?.sequence || page.length < 200) break;
        }
      } catch (error) { if (!(error instanceof EventPending)) errors.push(`${initial.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }
}
