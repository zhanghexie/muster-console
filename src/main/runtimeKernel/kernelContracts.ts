import { randomUUID } from 'node:crypto';
import type { CapabilityRegistry } from './capabilityRegistry';
import type { EventEnvelope, SessionHandleContract } from './contracts';
import type { DomainRegistry } from './domainRegistry';
import { LifecycleScope } from './lifecycleScope';
import { InternalCapabilities } from './internalCapabilities';
import type { StorageRootResolver } from './storageRootResolver';

/**
 * Runtime Kernel 公共合同层（计划 4.2 / 4.4）。
 *
 * 这里只定义跨域调用身份、权限、插件、事件与会话工厂的公共合同，并提供
 * 主入口用同一聚合根装配域、能力权限、文件会话工厂和插件。
 */

export type CallerKind = 'desktop' | 'web' | 'internal';

export type CallerIdentity = {
  id: string;
  kind: CallerKind;
  isAlive(): boolean;
};

export type RunContext = {
  correlationId: string;
  caller: CallerIdentity;
  sessionId?: string;
  workspaceId?: string;
  permissions: readonly string[];
  createdAt: number;
};

/** 系统侧允许的能力集合；调用还必须由 RunContext 显式携带同一权限。 */
export class PermissionGate {
  private readonly granted = new Set<string>();

  constructor(initial: readonly string[] = []) {
    for (const permission of initial) this.grant(permission);
  }

  grant(permission: string): void {
    if (!permission.trim()) throw new Error('Permission id is required');
    this.granted.add(permission);
  }

  revoke(permission: string): void {
    this.granted.delete(permission);
  }

  assert(context: RunContext, required: string): void {
    if (!this.granted.has(required)) {
      throw new Error(`Permission not granted by runtime kernel: ${required}`);
    }
    if (!context.permissions.includes(required)) {
      throw new Error(`RunContext is missing permission: ${required}`);
    }
  }

  list(): string[] {
    return [...this.granted].sort();
  }
}

type EventListener = (event: EventEnvelope) => void;

/** 进程内事件总线：单个 listener 抛错不阻断其它订阅，但绝不静默吞掉。 */
export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private disposed = false;

  on(type: string, listener: EventListener): () => void {
    if (this.disposed) throw new Error('EventBus is already disposed');
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
    return () => {
      bucket?.delete(listener);
      if (bucket && bucket.size === 0) this.listeners.delete(type);
    };
  }

  emit(event: EventEnvelope): void {
    if (this.disposed) return;
    const errors: unknown[] = [];
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `EventBus listeners failed for ${event.type}`);
  }

  listenerCount(type?: string): number {
    return type ? (this.listeners.get(type)?.size ?? 0) : [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export type SessionFactory = {
  create(sessionId: string): Promise<SessionHandleContract>;
  open(sessionId: string): Promise<SessionHandleContract>;
  release(sessionId: string): Promise<void>;
  dispose?(): Promise<void>;
};

export type SessionManager = SessionFactory & { list(): readonly string[] };

export type PluginContext<TCapability = unknown> = {
  calls: InternalCapabilities;
  domain: DomainRegistry;
  capabilities: CapabilityRegistry<TCapability>;
  events: EventBus;
  sessions: SessionFactory;
  scope: LifecycleScope;
  permissions: PermissionGate;
};

export type RuntimePlugin<TCapability = unknown> = {
  id: string;
  version: string;
  apply(ctx: PluginContext<TCapability>): void | Promise<void>;
};

export type RuntimeKernelOptions<TCapability> = {
  domains: DomainRegistry;
  capabilities: CapabilityRegistry<TCapability>;
  storage: StorageRootResolver;
  sessions: SessionFactory;
  permissions?: PermissionGate;
};

/**
 * 聚合根：把注册表、事件总线、scope、权限和存储解析器收在一个生命周期内。
 * 插件只能通过 PluginContext 取服务，卸载时由子 scope 逆序释放。
 */
export class RuntimeKernel<TCapability = unknown> {
  readonly calls: InternalCapabilities;
  readonly events = new EventBus();
  readonly permissions: PermissionGate;
  readonly scope: LifecycleScope;
  readonly domains: DomainRegistry;
  readonly capabilities: CapabilityRegistry<TCapability>;
  readonly storage: StorageRootResolver;
  readonly sessions: SessionFactory;
  private readonly plugins = new Map<string, RuntimePlugin<TCapability>>();
  private readonly applying = new Set<string>();
  private readonly pendingApplications = new Set<Promise<void>>();
  private disposal?: Promise<void>;

  constructor(options: RuntimeKernelOptions<TCapability>) {
    this.domains = options.domains;
    this.capabilities = options.capabilities;
    this.storage = options.storage;
    this.sessions = options.sessions;
    this.permissions = options.permissions ?? new PermissionGate();
    this.calls = new InternalCapabilities(this.permissions);
    this.scope = new LifecycleScope('runtime-kernel');
    this.scope.add(() => this.events.dispose());
    this.scope.add(() => this.sessions.dispose?.());
  }

  createRunContext(input: {
    caller: CallerIdentity;
    sessionId?: string;
    workspaceId?: string;
    permissions?: readonly string[];
    correlationId?: string;
  }): RunContext {
    if (!input.caller?.id) throw new Error('RunContext requires a caller identity');
    return {
      correlationId: input.correlationId ?? randomUUID(),
      caller: input.caller,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      permissions: input.permissions ?? [],
      createdAt: Date.now()
    };
  }

  apply(plugin: RuntimePlugin<TCapability>): Promise<void> {
    // Publish the accepted application before user plugin code can reenter disposal.
    const pending = Promise.resolve().then(() => this.applyPlugin(plugin));
    this.pendingApplications.add(pending);
    void pending.then(() => this.pendingApplications.delete(pending), () => this.pendingApplications.delete(pending));
    return pending;
  }

  private async applyPlugin(plugin: RuntimePlugin<TCapability>): Promise<void> {
    if (!plugin?.id?.trim()) throw new Error('Plugin id is required');
    if (this.disposal) throw new Error('Runtime kernel is disposed');
    if (this.plugins.has(plugin.id) || this.applying.has(plugin.id)) throw new Error(`Plugin already applied: ${plugin.id}`);
    const pluginScope = this.scope.child(`plugin:${plugin.id}`);
    this.applying.add(plugin.id);
    try {
      await plugin.apply({
        calls: this.calls,
        domain: this.domains,
        capabilities: this.capabilities,
        events: this.events,
        sessions: this.sessions,
        scope: pluginScope,
        permissions: this.permissions
      });
      if (this.disposal) throw new Error('Runtime kernel disposed during plugin apply');
      this.plugins.set(plugin.id, plugin);
    } catch (error) {
      try { await pluginScope.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Plugin ${plugin.id} apply and cleanup failed`); }
      throw error;
    } finally {
      this.applying.delete(plugin.id);
    }
  }

  listPlugins(): string[] {
    return [...this.plugins.keys()];
  }

  start(): Promise<void> {
    if (this.disposal) return Promise.reject(new Error('Runtime kernel is disposed'));
    return this.domains.startAll(this.scope);
  }

  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      const errors: unknown[] = [];
      await Promise.allSettled([...this.pendingApplications]);
      try { await this.domains.dispose(); } catch (error) { errors.push(error); }
      try { await this.scope.dispose(); } catch (error) { errors.push(error); }
      this.plugins.clear();
      if (errors.length) throw new AggregateError(errors, 'Runtime kernel disposal failed');
    })();
  }
}
