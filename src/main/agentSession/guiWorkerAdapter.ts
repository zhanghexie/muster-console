import type { GuiDriverConnectInput, GuiRuntimeConnection, GuiRuntimeDriver } from './types';

/** Owns all connections of one driver, including connections still being created. */
export class GuiWorkerAdapter {
  readonly runtimeId: string;
  readonly driver: GuiRuntimeDriver;
  private readonly connections = new Map<string, Promise<GuiRuntimeConnection>>();
  private readonly operations = new Set<Promise<unknown>>();
  private closing = false;
  private disposal?: Promise<void>;

  constructor(private readonly engine: GuiRuntimeDriver) {
    this.runtimeId = engine.runtimeId;
    this.driver = new Proxy(engine, { get: (target, key) => {
      if (key === 'connect') return (input: GuiDriverConnectInput) => this.connect(input);
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (this.closing) throw new Error(`GUI adapter is shutting down: ${this.runtimeId}`);
        const result = Reflect.apply(value, target, args);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          const operation = Promise.resolve(result);
          this.operations.add(operation);
          void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
          return operation;
        }
        return result;
      };
    } });
  }

  connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection> {
    if (this.closing) return Promise.reject(new Error(`GUI adapter is shutting down: ${this.runtimeId}`));
    if (this.connections.has(input.sessionId)) return Promise.reject(new Error(`GUI connection is still owned: ${input.sessionId}`));
    const pending = Promise.resolve().then(() => this.engine.connect(input)).then(connection => this.own(input.sessionId, connection));
    this.connections.set(input.sessionId, pending);
    void pending.catch(() => { if (this.connections.get(input.sessionId) === pending) this.connections.delete(input.sessionId); });
    return pending.then(async connection => {
      if (this.closing) { await connection.close(); throw new Error(`GUI adapter closed during connect: ${this.runtimeId}`); }
      return connection;
    });
  }

  private own(sessionId: string, connection: GuiRuntimeConnection): GuiRuntimeConnection {
    let closing: Promise<void> | undefined;
    let closed = false;
    const close = (): Promise<void> => {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = Promise.resolve().then(() => connection.close()).then(() => {
        closed = true;
        this.connections.delete(sessionId);
      }, error => { closing = undefined; throw error; });
      return closing;
    };
    const mutating = new Set(['send', 'receiveMessage', 'redirect', 'compact', 'nativeFork']);
    return new Proxy(connection, { get: (target, key) => {
      if (key === 'close') return close;
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if ((closed || closing || this.closing) && mutating.has(String(key))) throw new Error(`GUI connection is closing: ${sessionId}`);
        return Reflect.apply(value, target, args);
      };
    } });
  }

  closeSession(sessionId: string): Promise<void> {
    const pending = this.connections.get(sessionId);
    return pending ? pending.then(connection => connection.close()).then(() => {}) : Promise.resolve();
  }

  dispose(): Promise<void> {
    this.closing = true;
    return this.disposal ??= (async () => {
      const results = await Promise.allSettled([...this.operations, ...[...this.connections.values()].map(async pending => {
        const connection = await pending;
        await connection.close();
      })]);
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, `GUI adapter shutdown failed: ${this.runtimeId}`);
    })();
  }
}

/** The sole production driver registry; Host only exposes its read-only view. */
export class GuiWorkerAdapterRegistry {
  private readonly adapters = new Map<string, GuiWorkerAdapter>();
  private closing = false;
  private disposal?: Promise<void>;

  register(input: { runtimeId: string; driver: GuiRuntimeDriver }): void {
    if (this.closing) throw new Error('GUI adapter registry is disposed');
    if (!input.runtimeId.trim()) throw new Error('GUI Worker runtime id is required');
    if (input.driver.runtimeId !== input.runtimeId) throw new Error(`GUI Worker adapter runtime id does not match driver: ${input.runtimeId}`);
    if (this.adapters.has(input.runtimeId)) throw new Error(`GUI Worker adapter already registered: ${input.runtimeId}`);
    this.adapters.set(input.runtimeId, new GuiWorkerAdapter(input.driver));
  }
  get(runtimeId: string): GuiWorkerAdapter | undefined { return this.adapters.get(runtimeId); }
  getDriver(runtimeId: string): GuiRuntimeDriver | undefined { return this.get(runtimeId)?.driver; }
  list(): GuiWorkerAdapter[] { return [...this.adapters.values()]; }
  *drivers(): IterableIterator<GuiRuntimeDriver> { for (const adapter of this.adapters.values()) yield adapter.driver; }
  dispose(): Promise<void> {
    this.closing = true;
    return this.disposal ??= (async () => {
      const results = await Promise.allSettled(this.list().map(adapter => adapter.dispose()));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'GUI adapter registry shutdown failed');
    })();
  }
}
