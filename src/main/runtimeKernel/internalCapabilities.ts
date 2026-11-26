import { AsyncLocalStorage } from 'node:async_hooks';
import { CapabilityRegistry } from './capabilityRegistry';
import type { PermissionGate, RunContext } from './kernelContracts';
import type { LifecycleScope } from './lifecycleScope';

type Handler = (input: unknown, context: RunContext, signal: AbortSignal) => unknown;
export type InternalCapabilityAudit = {
  id: string; source: string; correlationId: string; callerId: string;
  status: 'ok' | 'denied' | 'failed'; durationMs: number;
};
export interface CapabilityCall<Input, Output> {
  readonly id: string;
  readonly permission: string;
  invoke(input: Input, context: RunContext, signal?: AbortSignal): Promise<Output>;
}

/** Typed main-process capabilities; no transport event or renderer identity is fabricated. */
export class InternalCapabilities {
  readonly registry = new CapabilityRegistry<Handler>();
  private readonly context = new AsyncLocalStorage<RunContext>();
  private readonly audit: InternalCapabilityAudit[] = [];
  private readonly owners = new WeakMap<LifecycleScope, {
    revoke: Array<() => void>;
    pending: Map<Promise<unknown>, AbortController>;
  }>();
  constructor(private readonly permissions: PermissionGate) {}

  currentContext(): RunContext | undefined { return this.context.getStore(); }
  listAudit(): readonly InternalCapabilityAudit[] { return this.audit.map(record => ({ ...record })); }

  register<Input, Output>(scope: LifecycleScope, id: string, source: string,
    handler: (input: Input, context: RunContext, signal: AbortSignal) => Output | Promise<Output>
  ): CapabilityCall<Input, Output> {
    if (scope.isDisposed) throw new Error(`Capability owner is disposed: ${source}`);
    const permission = `internal:${id}`;
    let owner = this.owners.get(scope);
    if (!owner) {
      owner = { revoke: [], pending: new Map() };
      this.owners.set(scope, owner);
      const group = owner;
      scope.add(async () => {
        // Revoke and abort every sibling before awaiting any handler. A
        // command may be waiting for a broker capability owned by this scope.
        for (const revoke of group.revoke) revoke();
        for (const controller of group.pending.values()) controller.abort(new Error(`Capability owner disposed: ${scope.id}`));
        await Promise.allSettled([...group.pending.keys()]);
      });
    }
    const pending = owner.pending;
    let revoked = false;
    const definition = { id, source, permission, auditTag: id,
      handler: handler as Handler };
    this.registry.register(definition);
    this.permissions.grant(permission);
    owner.revoke.push(() => {
      revoked = true;
      this.registry.unregister(id);
      this.permissions.revoke(permission);
    });
    return { id, permission, invoke: (input, context, signal) => {
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const started = Date.now();
      // Defer execution until the task is registered: even a synchronous
      // handler that starts disposal must be covered by the owner's barrier.
      const task = Promise.resolve().then(async () => {
        let status: InternalCapabilityAudit['status'] = 'denied';
        try {
          if (revoked || scope.isDisposed || this.registry.get(id) !== definition) throw new Error(`Capability unavailable: ${id}`);
          if (!context.caller.id || !context.caller.isAlive()) throw new Error('Capability caller is no longer active');
          this.permissions.assert(context, permission);
          controller.signal.throwIfAborted();
          status = 'failed';
          const value = await this.context.run(context, () => handler(input, context, controller.signal));
          controller.signal.throwIfAborted();
          if (revoked || !context.caller.isAlive()) throw new Error('Capability caller or owner was revoked');
          status = 'ok';
          return value;
        } finally {
          this.audit.push({ id, source, correlationId: context.correlationId, callerId: context.caller.id,
            status, durationMs: Date.now() - started });
          if (this.audit.length > 200) this.audit.splice(0, this.audit.length - 200);
        }
      }).finally(() => { signal?.removeEventListener('abort', abort); pending.delete(task); });
      pending.set(task, controller);
      return task;
    } };
  }
}
