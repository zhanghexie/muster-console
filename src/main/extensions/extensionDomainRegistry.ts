import type { ExtensionManifest } from '../../shared/extensionManifest';
import {
  extensionDomainInstanceKey,
  type ExtensionDomainContext,
  type ExtensionDomainEvent,
  type ExtensionDomainInstanceIdentity,
  type ExtensionDomainRuntime,
  type ExtensionDomainRuntimeFactory,
  type ExtensionDomainSnapshot,
  type ExtensionDomainActionResult
} from '../../shared/extensionDomain';

type Entry = {
  identity: ExtensionDomainInstanceIdentity;
  manifest: ExtensionManifest;
  runtime: ExtensionDomainRuntime;
};

/**
 * Host registry for extension domain runtimes.
 *
 * The registry owns instance identity and lifecycle. It also serializes each
 * instance's mutations so expected-version checks, execution, version clocks
 * and request-id replay are one atomic host segment; the runtime still owns
 * domain validation and storage. This keeps the host from learning each
 * extension's business model while allowing the human surface and Agent tools
 * to share one runtime instance.
 */
export class ExtensionDomainRegistry {
  private readonly factories = new Map<string, ExtensionDomainRuntimeFactory>();
  private readonly entries = new Map<string, Entry>();
  private readonly versions = new Map<string, number>();
  private readonly actionResults = new Map<string, Map<string, ExtensionDomainActionResult>>();
  private readonly actionInFlight = new Map<string, Map<string, Promise<ExtensionDomainActionResult>>>();
  /**
   * Per-instance mutation tails.  A tail always resolves (the rejection is
   * observed and swallowed) so one failed command cannot poison every command
   * that follows it.  The expected-version check, runtime call, version clock
   * and idempotency write all happen in the same queue segment.
   */
  private readonly mutationQueues = new Map<string, Promise<void>>();
  /**
   * Human command activity per instance since the Agent last took it.  The
   * Agent does not receive domain events; this lightweight summary lets its
   * next snapshot mention what the human changed meanwhile.
   */
  private readonly humanActivity = new Map<string, { commands: Map<string, number>; lastAt: number }>();

  register(extensionId: string, factory: ExtensionDomainRuntimeFactory, packageFingerprint = ''): () => void {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(extensionId)) throw new Error('Invalid extension domain extension id');
    const key = `${extensionId}:${packageFingerprint}`;
    if (this.factories.has(key)) throw new Error(`extension domain already registered: ${extensionId}`);
    this.factories.set(key, factory);
    return () => {
      if (this.factories.get(key) === factory) this.factories.delete(key);
    };
  }

  async open(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest): Promise<ExtensionDomainRuntime> {
    this.assertManifest(identity, manifest);
    const key = extensionDomainInstanceKey(identity);
    const existing = this.entries.get(key);
    if (existing) {
      this.assertSame(existing, identity, manifest);
      return existing.runtime;
    }
    const factory = this.factories.get(`${identity.extensionId}:${identity.packageFingerprint}`) ?? this.factories.get(`${identity.extensionId}:`);
    if (!factory) throw new Error(`No extension domain runtime registered: ${identity.extensionId}`);
    const runtime = await factory.create({ identity: structuredClone(identity), manifest: structuredClone(manifest) });
    if (!runtime || typeof runtime.getSnapshot !== 'function' || typeof runtime.query !== 'function' || typeof runtime.execute !== 'function' || typeof runtime.subscribe !== 'function') {
      throw new Error(`Invalid extension domain runtime: ${identity.extensionId}`);
    }
    this.entries.set(key, { identity: structuredClone(identity), manifest: structuredClone(manifest), runtime });
    return runtime;
  }

  require(identity: ExtensionDomainInstanceIdentity): ExtensionDomainRuntime {
    const entry = this.entries.get(extensionDomainInstanceKey(identity));
    if (!entry) throw new Error('extension domain instance is not open');
    this.assertSame(entry, identity, entry.manifest);
    return entry.runtime;
  }

  async snapshot(identity: ExtensionDomainInstanceIdentity, context: ExtensionDomainContext): Promise<ExtensionDomainSnapshot> {
    const key = extensionDomainInstanceKey(identity);
    return this.afterMutations(key, async () => {
      const bound = this.assertContext(identity, context);
      const result = await this.require(identity).getSnapshot(bound);
      this.versions.set(key, result.version);
      return result;
    });
  }

  async query(identity: ExtensionDomainInstanceIdentity, name: string, args: unknown, context: ExtensionDomainContext): Promise<unknown> {
    if (!name || typeof name !== 'string') throw new Error('extension domain query name is required');
    return this.afterMutations(extensionDomainInstanceKey(identity), () => this.require(identity).query(name, args, this.assertContext(identity, context)));
  }

  async execute(identity: ExtensionDomainInstanceIdentity, name: string, args: unknown, context: ExtensionDomainContext): Promise<ExtensionDomainActionResult> {
    if (!name || typeof name !== 'string') throw new Error('extension domain command name is required');
    if (!context.requestId || typeof context.requestId !== 'string') throw new Error('extension domain request id is required');
    const key = extensionDomainInstanceKey(identity);
    const cached = this.actionResults.get(key)?.get(context.requestId);
    if (cached) return structuredClone(cached);
    const inFlight = this.actionInFlight.get(key)?.get(context.requestId);
    if (inFlight) return structuredClone(await inFlight);
    const run = this.enqueueMutation(key, async (): Promise<ExtensionDomainActionResult> => {
      const bound = this.assertContext(identity, context);
      if (bound.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      if (bound.expectedVersion !== undefined) {
        let current = this.versions.get(key);
        if (current === undefined) current = (await this.require(identity).getSnapshot(bound)).version;
        if (current !== bound.expectedVersion) throw new Error(`extension domain version conflict: expected ${bound.expectedVersion}, current ${current}`);
      }
      const result = await this.require(identity).execute(name, args, bound);
      if (!result || result.ok !== true || !Number.isSafeInteger(result.version) || result.version < 0) throw new Error('extension domain action result is invalid');
      this.versions.set(key, result.version);
      if (bound.actor === 'human') this.recordHumanActivity(key, name);
      let results = this.actionResults.get(key);
      if (!results) { results = new Map(); this.actionResults.set(key, results); }
      results.set(bound.requestId, structuredClone(result));
      while (results.size > 256) results.delete(results.keys().next().value as string);
      return result;
    });
    let pending = this.actionInFlight.get(key);
    if (!pending) { pending = new Map(); this.actionInFlight.set(key, pending); }
    pending.set(context.requestId, run);
    try { return structuredClone(await run); }
    finally { pending.delete(context.requestId); }
  }

  subscribe(identity: ExtensionDomainInstanceIdentity, listener: (event: ExtensionDomainEvent) => void): () => void {
    return this.require(identity).subscribe(event => {
      if (event.extensionId !== identity.extensionId || event.extensionInstanceId !== identity.extensionInstanceId || event.workspaceId !== identity.workspaceId) throw new Error('extension domain event identity mismatch');
      listener(event);
    });
  }

  /** Take and clear the human command activity accumulated since the Agent last took it. */
  takeHumanActivity(identity: ExtensionDomainInstanceIdentity): { commands: Array<{ name: string; count: number }>; lastAt: number } | undefined {
    const key = extensionDomainInstanceKey(identity);
    const activity = this.humanActivity.get(key);
    if (!activity) return undefined;
    this.humanActivity.delete(key);
    return { commands: [...activity.commands.entries()].map(([name, count]) => ({ name, count })), lastAt: activity.lastAt };
  }

  async close(identity: ExtensionDomainInstanceIdentity): Promise<void> {
    const key = extensionDomainInstanceKey(identity);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.assertSame(entry, identity, entry.manifest);
    this.entries.delete(key);
    this.versions.delete(key);
    this.actionResults.delete(key);
    this.actionInFlight.delete(key);
    this.mutationQueues.delete(key);
    this.humanActivity.delete(key);
    await entry.runtime.close?.();
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.versions.clear();
    this.actionResults.clear();
    this.actionInFlight.clear();
    this.mutationQueues.clear();
    this.humanActivity.clear();
    const results = await Promise.allSettled(entries.map(entry => entry.runtime.close?.()));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'extension domain runtime cleanup failed');
  }

  private assertManifest(identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest): void {
    if (manifest.id !== identity.extensionId || manifest.surface.kind !== 'sidebar' || !manifest.domain) throw new Error('extension domain runtime requires a sidebar manifest with domain');
    if (manifest.scope === 'project' && !manifest.project) throw new Error('extension project domain manifest has no project binding');
  }

  private assertSame(entry: Entry, identity: ExtensionDomainInstanceIdentity, manifest: ExtensionManifest): void {
    if (entry.identity.sourceRootId !== identity.sourceRootId || entry.identity.packageFingerprint !== identity.packageFingerprint || entry.identity.surfaceId !== identity.surfaceId || entry.manifest.version !== manifest.version) throw new Error('extension domain instance identity changed');
  }

  private assertContext(identity: ExtensionDomainInstanceIdentity, context: ExtensionDomainContext): ExtensionDomainContext {
    if (context.identity.extensionId !== identity.extensionId || context.identity.extensionInstanceId !== identity.extensionInstanceId || context.identity.workspaceId !== identity.workspaceId || context.identity.sourceRootId !== identity.sourceRootId || context.identity.surfaceId !== identity.surfaceId || context.identity.packageFingerprint !== identity.packageFingerprint) throw new Error('extension domain context identity mismatch');
    return context;
  }

  private recordHumanActivity(key: string, name: string): void {
    const activity = this.humanActivity.get(key);
    if (activity) {
      activity.commands.set(name, (activity.commands.get(name) ?? 0) + 1);
      activity.lastAt = Date.now();
      return;
    }
    this.humanActivity.set(key, { commands: new Map([[name, 1]]), lastAt: Date.now() });
  }

  /** Run a read after all mutations already admitted for the instance. */
  private async afterMutations<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.mutationQueues.get(key);
    if (tail) await tail;
    return operation();
  }

  /**
   * Admit one mutation to the per-instance queue.  The queue tail deliberately
   * swallows failures; callers still observe the original `run` rejection.
   */
  private enqueueMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    const run = previous.then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.mutationQueues.set(key, tail);
    void tail.finally(() => {
      if (this.mutationQueues.get(key) === tail) this.mutationQueues.delete(key);
    }).catch(() => {});
    return run;
  }
}

