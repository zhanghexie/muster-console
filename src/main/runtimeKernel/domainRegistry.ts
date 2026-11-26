import { LifecycleScope, type LifecycleDisposer } from './lifecycleScope';

export type RuntimeDomainContext = {
  rootScope: LifecycleScope;
};

export type RuntimeDomainDefinition = {
  id: string;
  dependsOn?: readonly string[];
  start(context: RuntimeDomainContext, scope: LifecycleScope): void | LifecycleDisposer | Promise<void | LifecycleDisposer>;
};

type RuntimeDomainState = 'registered' | 'starting' | 'started' | 'failed' | 'stopped';

type RuntimeDomainRecord = {
  definition: RuntimeDomainDefinition;
  state: RuntimeDomainState;
  scope?: LifecycleScope;
};

/** Dependency-aware domain registration for the new Runtime Kernel. */
export class DomainRegistry {
  private readonly domains = new Map<string, RuntimeDomainRecord>();
  private startOrder: RuntimeDomainRecord[] = [];
  private started = false;
  private disposal: Promise<void> | undefined;
  private startup: Promise<void> | undefined;
  private closing = false;

  register(definition: RuntimeDomainDefinition): void {
    if (this.started || this.closing) throw new Error('Runtime domains cannot be registered after startup or disposal');
    if (!definition.id.trim()) throw new Error('Runtime domain id is required');
    if (this.domains.has(definition.id)) throw new Error(`Runtime domain already registered: ${definition.id}`);
    this.domains.set(definition.id, { definition, state: 'registered' });
  }

  list(): Array<{ id: string; state: RuntimeDomainState; dependsOn: readonly string[] }> {
    return [...this.domains.values()].map(record => ({ id: record.definition.id, state: record.state, dependsOn: record.definition.dependsOn ?? [] }));
  }

  async startAll(rootScope = new LifecycleScope('runtime-kernel')): Promise<void> {
    if (this.closing) throw new Error('Runtime domains are disposed');
    if (this.started) throw new Error('Runtime domains already started');
    const order = this.topologicalOrder();
    this.started = true;
    this.startup = this.startDomains(rootScope, order);
    return this.startup;
  }

  private async startDomains(rootScope: LifecycleScope, order: RuntimeDomainRecord[]): Promise<void> {
    const context = { rootScope } satisfies RuntimeDomainContext;
    const started: RuntimeDomainRecord[] = [];
    let starting: RuntimeDomainRecord | undefined;
    try {
      for (const record of order) {
        if (this.closing) throw new Error('Runtime domain startup cancelled by disposal');
        starting = record;
        record.state = 'starting';
        const scope = rootScope.child(`domain:${record.definition.id}`);
        record.scope = scope;
        const disposer = await record.definition.start(context, scope);
        if (disposer) scope.add(disposer);
        record.state = 'started';
        started.push(record);
        starting = undefined;
      }
      this.startOrder = [...started];
    } catch (error) {
      const errors: unknown[] = [error];
      if (starting) {
        starting.state = 'failed';
        try { await starting.scope?.dispose(); } catch (cleanup) { errors.push(cleanup); }
      }
      for (const record of started.reverse()) {
        try { await record.scope?.dispose(); } catch (cleanup) { errors.push(cleanup); }
        record.state = 'stopped';
      }
      if (errors.length > 1) throw new AggregateError(errors, 'Runtime domain startup and cleanup failed');
      throw error;
    }
  }

  dispose(): Promise<void> {
    this.closing = true;
    return this.disposal ??= Promise.resolve().then(() => this.disposeDomains());
  }

  private async disposeDomains(): Promise<void> {
    // Startup owns rollback on failure. Wait until any in-flight start has
    // returned its disposer before traversing the successfully started domains.
    await this.startup?.catch(() => {});
    const errors: unknown[] = [];
    for (const record of [...this.startOrder].reverse()) {
      if (record.state !== 'started') continue;
      if (process.env.MUSTER_RUNTIME_DIAGNOSTICS === '1') console.info('[runtime-kernel] stopping', record.definition.id);
      try { await record.scope?.dispose(); }
      catch (error) { errors.push(new Error(`Runtime domain ${record.definition.id} disposal failed`, { cause: error })); }
      finally {
        record.state = 'stopped';
        if (process.env.MUSTER_RUNTIME_DIAGNOSTICS === '1') console.info('[runtime-kernel] stopped', record.definition.id);
      }
    }
    this.startOrder = [];
    if (errors.length) throw new AggregateError(errors, 'Runtime domain disposal failed');
  }

  private topologicalOrder(): RuntimeDomainRecord[] {
    const ordered: RuntimeDomainRecord[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      const record = this.domains.get(id);
      if (!record) throw new Error(`Runtime domain dependency missing: ${id}`);
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Runtime domain dependency cycle: ${[...visiting, id].join(' -> ')}`);
      visiting.add(id);
      for (const dependency of record.definition.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
      ordered.push(record);
    };
    for (const id of this.domains.keys()) visit(id);
    return ordered;
  }
}
