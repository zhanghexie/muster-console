import { CHANNEL_APP_ID, isLegacyChannelApp, type AppOperation } from '../../../shared/agentApps';

export type PhoneRoute = { appId?: string; viewId?: string; entityId?: string; accountId?: string; channelId?: string; folder?: string; editCommand?: string; settings?: boolean };
export type PhonePresentation = { open: boolean; openedBy: 'user' | 'agent' | null; active: number; following: boolean; automatic: boolean; auto: boolean; route: PhoneRoute; operation?: AppOperation; pending: number; compressed: number; failures: AppOperation[] };

/** The only auto-navigation authority. No business command is ever run by presentation. */
export class AppPresentationController {
  state: PhonePresentation;
  private queue: AppOperation[] = [];
  private seen = new Map<string, { sequence: number; first: number }>();
  private suppressed = new Set<string>();
  // Independent of the bounded display queue: an older operation can still be running.
  private active = new Set<string>();
  private navigationOrder = 0;
  private listeners = new Set<() => void>();
  constructor(readonly workspaceId: string, auto = true) { this.state = { open: false, openedBy: null, active: 0, following: true, automatic: false, auto, route: {}, pending: 0, compressed: 0, failures: [] }; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private set(patch: Partial<PhonePresentation>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  accept(operation: AppOperation, visible = true): void {
    if (operation.workspaceId !== this.workspaceId || operation.agentId !== `orchestrator:${this.workspaceId}` || operation.actor !== 'agent') return;
    const old = this.seen.get(operation.operationId); if (old && old.sequence >= operation.sequence) return;
    this.seen.set(operation.operationId, { sequence: operation.sequence, first: old?.first ?? operation.sequence });
    if (this.seen.size > 200) this.seen.delete(this.seen.keys().next().value!);
    // A completion still releases an already displayed operation when hidden/disabled.
    if (operation.phase !== 'running' && this.active.delete(operation.operationId)) this.set({ active: this.active.size });
    if (!visible || !this.state.auto || this.suppressed.has(operation.runId)) return;
    if (operation.phase === 'running') this.active.add(operation.operationId);
    if (operation.phase === 'failed' || operation.phase === 'cancelled') this.set({ failures: [...this.state.failures.filter(x => x.operationId !== operation.operationId), operation].slice(-8) });
    const index = this.queue.findIndex(x => x.operationId === operation.operationId);
    if (index >= 0) this.queue[index] = operation; else this.queue.push(operation);
    let compressed = this.state.compressed;
    if (this.queue.length > 8) { compressed += this.queue.length - 8; this.queue = this.queue.slice(-8); }
    this.set({ pending: this.queue.length, compressed, active: this.active.size });
  }
  advance(): void {
    if (!this.state.auto || !this.state.following || !this.queue.length) return;
    // Bounded UI cadence only; execution has already returned independently.
    while (this.queue.length) {
      const operation = this.queue.shift()!;
      const order = this.seen.get(operation.operationId)?.first ?? operation.sequence;
      // Stale completions have no page to display and must not consume the pump.
      if (order < this.navigationOrder) continue;
      const route = isLegacyChannelApp(operation.appId) ? { appId: CHANNEL_APP_ID, viewId: 'main' } : { appId: operation.appId, viewId: operation.viewId, entityId: operation.entityId };
      this.navigationOrder = order;
      this.set({ open: true, openedBy: this.state.openedBy ?? 'agent', automatic: true, route, operation, pending: this.queue.length });
      return;
    }
    this.set({ pending: 0 });
  }
  /** Opening the viewer is observation, not a request to take over navigation. */
  open() { this.set({ open: true, openedBy: 'user', following: true, automatic: false }); }
  manual(route: PhoneRoute) { this.set({ open: true, openedBy: 'user', automatic: false, following: !route.editCommand && !route.settings, route }); }
  interact(editing: boolean) { this.set({ ...(editing && this.state.open ? { openedBy: 'user' as const } : {}), following: !editing && !this.state.route.editCommand && !this.state.route.settings }); }
  /** Automatic dismissal must not suppress later operations in the same turn. */
  closeIfIdle() {
    if (this.state.openedBy !== 'agent' || !this.state.following || this.active.size || this.queue.length) return;
    this.set({ open: false, openedBy: null, automatic: false });
  }
  resume() { if (this.queue.length > 1) { this.set({ compressed: this.state.compressed + this.queue.length - 1 }); this.queue = this.queue.slice(-1); } this.set({ following: true }); this.advance(); }
  close() {
    if (this.state.operation) this.suppressed.add(this.state.operation.runId);
    this.queue.forEach(op => this.suppressed.add(op.runId));
    if (this.suppressed.size > 40) this.suppressed = new Set([...this.suppressed].slice(-40));
    this.queue = []; this.active.clear(); this.set({ open: false, openedBy: null, active: 0, automatic: false, pending: 0, following: true });
  }
  setAuto(auto: boolean) { if (!auto) this.queue = []; this.set({ auto, pending: this.queue.length }); }
}
