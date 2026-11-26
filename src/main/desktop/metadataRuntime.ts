import type { DesktopAuditEntry } from './auditStore';
import type { TrustedDisplayActor } from './displayService';
import type { ElectronDisplayRegistry } from './displayRegistry';
import { DesktopListService } from './listService';

/** Bind metadata disclosure to a host-derived caller and a durable audit receipt. */
export class DesktopMetadataRuntime {
  private readonly listService: DesktopListService;
  private readonly lifetime = new AbortController();
  constructor(
    private readonly registry: ElectronDisplayRegistry,
    windows: ConstructorParameters<typeof DesktopListService>[1],
    private readonly audit: { append(entry: DesktopAuditEntry): unknown; close(): void }
  ) {
    this.listService = new DesktopListService({ list: () => registry.refresh() }, windows);
  }
  /** Shared with the capture backend so list IDs and geometry stay in the same registry. */
  displayRegistry(): ElectronDisplayRegistry { return this.registry; }

  async list(raw: TrustedDisplayActor, signal?: AbortSignal) {
    if (!raw || typeof raw.sessionId !== 'string' || !raw.sessionId.trim() ||
        typeof raw.taskId !== 'string' || !raw.taskId.trim() || typeof raw.isCurrent !== 'function') {
      throw new Error('Invalid desktop metadata caller');
    }
    const actor = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, isCurrent: raw.isCurrent.bind(raw) });
    const activeSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    const check = (): void => { activeSignal.throwIfAborted(); if (!actor.isCurrent()) throw new Error('Desktop caller is no longer current'); };
    try {
      check();
      const result = await this.listService.list(actor, activeSignal);
      check();
      this.audit.append({ sessionId: actor.sessionId, taskId: actor.taskId, source: 'desktop', action: 'list', stage: 'read', result: 'allowed' });
      check();
      return result;
    } catch (error) {
      try { this.audit.append({ sessionId: actor.sessionId, taskId: actor.taskId, source: 'desktop', action: 'list', stage: 'read', result: 'failed' }); }
      catch (auditError) { throw new AggregateError([error, auditError], 'Desktop metadata read failed and audit could not be recorded'); }
      throw error;
    }
  }

  close(): void {
    this.lifetime.abort();
    try { this.registry.dispose(); } finally { this.audit.close(); }
  }
}
