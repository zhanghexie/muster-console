import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionCommandRuntime, ExtensionCommandRuntimeContext, ExtensionManifest } from '../../shared/extensionManifest';
import type { ExtensionDomainActionResult, ExtensionDomainContext, ExtensionDomainEvent, ExtensionDomainInstanceIdentity, ExtensionDomainRuntime, ExtensionDomainSnapshot } from '../../shared/extensionDomain';
import { spawnOwnedProcess, type OwnedProcess } from '../agentSession/process/owner';
import { resolveWindowsJobAsset } from '../agentSession/process/windowsJobAsset';
import { boundedAcpRequest } from '../agentSession/processReclamation';

type ExtensionIsolatedBrokerContext = ExtensionDomainContext & { assertCurrent?: () => void };
export type ExtensionIsolatedBroker = (method: string, args: unknown[], context: ExtensionIsolatedBrokerContext, onDelta?: (delta: string) => void) => Promise<unknown>;

interface RuntimeProcessOptions {
  mode: 'domain' | 'command' | 'mcp';
  identity: ExtensionDomainInstanceIdentity;
  manifest: ExtensionManifest;
  packageRoot: string;
  entry: string;
  workerFile?: string;
  broker?: ExtensionIsolatedBroker;
}

type Pending = {
  requestId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  abort?: () => void;
  cancelled?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function resolveExtensionRuntimeWorkerPath(defaultDirectory: string, provided?: string): string {
  if (provided) return path.resolve(provided).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const candidates = [
    path.join(defaultDirectory, 'extensionRuntimeWorker.mjs'),
    path.join(defaultDirectory, 'extensions', 'sdk', 'extension-runtime-worker.mjs'),
    path.join(defaultDirectory, 'sdk', 'extension-runtime-worker.mjs')
  ];
  const worker = candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
  return path.resolve(worker).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/** One owned process speaking the extension domain/command RPC protocol. */
class ExtensionRuntimeProcess {
  private readonly token = randomUUID();
  private readonly pending = new Map<string, Pending>();
  private readonly brokerCalls = new Map<string, { requestId: string; controller: AbortController }>();
  private owner?: OwnedProcess<ChildProcessWithoutNullStreams>;
  private child?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private stopping?: Promise<void>;
  private started = false;
  private closed = false;
  private readyError?: Error;
  private readonly listeners = new Set<(event: ExtensionDomainEvent) => void>();

  constructor(private readonly options: RuntimeProcessOptions) {}

  subscribe(listener: (event: ExtensionDomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(input: {
    method: 'snapshot' | 'query' | 'execute' | 'command' | 'mcp';
    name?: string;
    command?: string;
    args?: unknown;
    context: Omit<ExtensionDomainContext, 'identity'> | ExtensionCommandRuntimeContext;
    assertCurrent?: () => void;
    descriptorPath?: string;
    descriptorSessionId?: string;
  }): Promise<unknown> {
    await this.start();
    if (this.closed) throw new Error('extension runtime process is closed');
    const signal = input.context.signal;
    if (signal?.aborted) throw abortError();
    const id = randomUUID();
    const requestId = String(input.context.requestId ?? id);
    const commandContext = input.method === 'command' ? input.context as ExtensionCommandRuntimeContext : undefined;
    const message: Record<string, unknown> = {
      type: 'request', token: this.token, id, method: input.method, requestId,
      ...(commandContext ? { sourceRoot: commandContext.sourceRoot, rootsRevision: commandContext.rootsRevision } : {}),
      ...('sessionId' in input.context ? { sessionId: input.context.sessionId } : {}),
      ...('taskRef' in input.context ? { taskRef: input.context.taskRef } : {}),
      actor: 'actor' in input.context ? input.context.actor : 'human',
      ...(Number.isSafeInteger((input.context as ExtensionDomainContext).expectedVersion) ? { expectedVersion: (input.context as ExtensionDomainContext).expectedVersion } : {}),
      ...(input.name ? { name: input.name } : {}), ...(input.command ? { command: input.command } : {}),
      ...(input.descriptorPath ? { descriptorPath: input.descriptorPath } : {}),
      ...(input.descriptorSessionId ? { descriptorSessionId: input.descriptorSessionId } : {}), args: input.args
    };
    return new Promise((resolve, reject) => {
      const pending: Pending = { requestId, resolve, reject, signal, assertCurrent: input.assertCurrent };
      const abort = (): void => {
        const active = this.pending.get(id);
        if (!active || active.cancelled) return;
        active.cancelled = true;
        this.send({ type: 'cancel', token: this.token, id });
        for (const call of this.brokerCalls.values()) if (call.requestId === requestId) call.controller.abort();
        active.reject(abortError());
        // A synchronous extension loop cannot observe this message.  After a
        // short grace period reclaim the owned process; callers are told only
        // that cancellation happened, never that the loop was interrupted.
        active.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          void this.close('extension runtime request cancellation timed out').catch(() => {});
        }, 1000);
        active.timer.unref?.();
      };
      pending.abort = abort;
      this.pending.set(id, pending);
      signal?.addEventListener('abort', abort, { once: true });
      this.send(message, error => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        current.signal?.removeEventListener('abort', current.abort!);
        clearTimeout(current.timer);
        current.reject(error);
      });
      if (signal?.aborted) abort();
    });
  }

  async close(reason = 'extension runtime process closed'): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      pending.signal?.removeEventListener('abort', pending.abort!);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
    for (const call of this.brokerCalls.values()) call.controller.abort();
    this.brokerCalls.clear();
    const owner = this.owner;
    const child = this.child;
    this.stopping = (async () => {
      if (!owner || !child) return;
      if (child.connected) this.send({ type: 'stop', token: this.token });
      // Reclaim owns the process group/Windows Job.  It is intentionally not
      // replaced with a bare child.kill() so descendants cannot escape.
      await boundedAcpRequest(owner.reclaim(), 9000, 'extension runtime process cleanup');
    })();
    return this.stopping;
  }

  private async start(): Promise<void> {
    if (this.startup) return this.startup;
    if (this.closed) throw new Error('extension runtime process is closed');
    this.startup = this.activate();
    try { await this.startup; }
    catch (error) {
      this.readyError = error instanceof Error ? error : new Error(String(error));
      this.closed = true;
      if (this.owner) void this.owner.reclaim().catch(reclaimError => console.error('[extension extension] runtime startup cleanup failed:', reclaimError));
      throw this.readyError;
    }
  }

  private async activate(): Promise<void> {
    const worker = resolveExtensionRuntimeWorkerPath(__dirname, this.options.workerFile);
    const owner = spawnOwnedProcess<ChildProcessWithoutNullStreams>({
      command: process.execPath,
      args: [worker],
      spawnOptions: {
        cwd: this.options.packageRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      },
      windows: { kind: 'job', jobPath: process.platform === 'win32' ? resolveWindowsJobAsset(__dirname) : '' },
      monitor: {
        businessLabel: `扩展运行时 · ${this.options.identity.extensionId}`,
        role: '扩展运行时进程',
        workspaceId: this.options.identity.workspaceId
      },
      identityChallenge: async (child, nonce, signal) => {
        let listener!: (message: unknown) => void;
        const response = new Promise<string>((resolve, reject) => {
          listener = raw => {
            const message = raw as Record<string, unknown>;
            if (message?.type === 'identityProof' && message.nonce === nonce) resolve(nonce);
          };
          child.on('message', listener);
          try { child.send({ type: 'identityChallenge', nonce }); } catch (error) { reject(error as Error); }
        });
        try { return await boundedAcpRequest(response, 7000, 'extension runtime identity', signal); }
        finally { child.removeListener('message', listener); }
      },
      beforeReclaim: child => {
        if (child.connected) { try { child.send({ type: 'stop', token: this.token }); } catch { /* owner remains authoritative */ } }
      }
    });
    this.owner = owner;
    this.child = owner.child;
    this.child.stdout?.on('data', () => {});
    this.child.stderr?.on('data', data => console.warn('[extension extension runtime]', String(data).slice(0, 2000)));
    this.child.on('message', message => this.onMessage(message));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.started && !this.closed) this.fail(new Error(`extension runtime worker exited before startup (${code ?? signal})`));
      else if (!this.closed) this.fail(new Error(`extension runtime worker exited (${code ?? signal})`));
    });
    await owner.ready;
    if (!this.child.connected) throw new Error('extension runtime worker IPC channel is unavailable');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('extension runtime worker startup timed out')); }, 10_000);
      const cleanup = (): void => { clearTimeout(timer); this.readyResolve = undefined; this.readyReject = undefined; };
      this.readyResolve = () => { cleanup(); resolve(); };
      this.readyReject = error => { cleanup(); reject(error); };
      this.send({ type: 'init', token: this.token, mode: this.options.mode, identity: this.options.identity, manifest: this.options.manifest, packageRoot: this.options.packageRoot, entry: this.options.entry }, reject);
    });
    this.started = true;
  }

  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;

  private onMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Record<string, unknown>;
    if (message.type === 'ready' && message.token === this.token) { this.readyResolve?.(); return; }
    if (message.type === 'fatal') { this.readyReject?.(new Error(String(message.error))); return; }
    if (message.token !== this.token) return;
    if (message.type === 'brokerCancel' && typeof message.id === 'string') {
      this.brokerCalls.get(message.id)?.controller.abort();
      return;
    }
    if (message.type === 'result' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.signal?.removeEventListener('abort', pending.abort!);
      clearTimeout(pending.timer);
      if (pending.cancelled) return;
      if (message.ok) pending.resolve(message.result);
      else { const error = new Error(String(message.error)); if (typeof message.name === 'string') error.name = message.name; pending.reject(error); }
      return;
    }
    if (message.type === 'broker' && typeof message.id === 'string') {
      const brokerId = message.id;
      const broker = this.options.broker;
      if (!broker) { this.send({ type: 'brokerReply', token: this.token, id: brokerId, ok: false, error: 'extension runtime broker is unavailable' }); return; }
      const context = (message.context && typeof message.context === 'object' ? message.context : {}) as Omit<ExtensionDomainContext, 'signal'>;
      // The wire request ID selects a pending command. The binding guard stays in the host.
      const command = this.options.mode === 'command'
        ? [...this.pending.values()].find(pending => pending.requestId === context.requestId && !pending.cancelled)
        : undefined;
      if (this.options.mode === 'command' && !command) {
        this.send({ type: 'brokerReply', token: this.token, id: brokerId, ok: false, error: 'Extension toolbar broker requires an active command context' });
        return;
      }
      const controller = new AbortController();
      this.brokerCalls.set(brokerId, { requestId: String(context.requestId ?? ''), controller });
      const work = broker(String(message.method ?? ''), Array.isArray(message.args) ? message.args : [], { ...context, signal: controller.signal, assertCurrent: command?.assertCurrent }, delta => {
        if (!controller.signal.aborted && this.brokerCalls.has(brokerId)) this.send({ type: 'brokerDelta', token: this.token, id: brokerId, delta });
      });
      void work.then(result => this.send({ type: 'brokerReply', token: this.token, id: brokerId, ok: true, result }), error => this.send({ type: 'brokerReply', token: this.token, id: brokerId, ok: false, error: String(error) })).finally(() => this.brokerCalls.delete(brokerId));
      return;
    }
    if (message.type === 'event' && message.event && typeof message.event === 'object') {
      for (const listener of this.listeners) {
        try { listener(structuredClone(message.event) as ExtensionDomainEvent); }
        catch (error) { console.warn('[extension extension] runtime event listener failed:', error); }
      }
    }
  }

  private send(message: Record<string, unknown>, callback?: (error: Error) => void): void {
    const child = this.child;
    if (!child?.connected) { callback?.(this.readyError ?? new Error('extension runtime worker is disconnected')); return; }
    try { child.send(message, error => { if (error) callback?.(error); }); }
    catch (error) { callback?.(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: unknown): void {
    const reason = error instanceof Error ? error : new Error(String(error));
    const wasClosed = this.closed;
    this.closed = true;
    this.readyReject?.(reason);
    this.readyError = reason;
    for (const call of this.brokerCalls.values()) call.controller.abort();
    this.brokerCalls.clear();
    for (const [id, pending] of this.pending) {
      pending.signal?.removeEventListener('abort', pending.abort!);
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
    if (!wasClosed && this.owner) void this.owner.reclaim().catch(reclaimError => console.error('[extension extension] runtime worker cleanup failed:', reclaimError));
  }
}

export class ExtensionIsolatedDomainRuntime implements ExtensionDomainRuntime {
  private readonly process: ExtensionRuntimeProcess;
  constructor(options: Omit<RuntimeProcessOptions, 'mode'>) { this.process = new ExtensionRuntimeProcess({ ...options, mode: 'domain' }); }
  getSnapshot(context: ExtensionDomainContext): Promise<ExtensionDomainSnapshot> { return this.process.request({ method: 'snapshot', context }).then(result => result as ExtensionDomainSnapshot); }
  query(name: string, args: unknown, context: ExtensionDomainContext): Promise<unknown> { return this.process.request({ method: 'query', name, args, context }); }
  execute(name: string, args: unknown, context: ExtensionDomainContext): Promise<ExtensionDomainActionResult> { return this.process.request({ method: 'execute', name, args, context }).then(result => result as ExtensionDomainActionResult); }
  subscribe(listener: (event: ExtensionDomainEvent) => void): () => void { return this.process.subscribe(listener); }
  close(): Promise<void> { return this.process.close(); }
}

export class ExtensionIsolatedCommandRuntime implements ExtensionCommandRuntime {
  private readonly process: ExtensionRuntimeProcess;
  constructor(options: Omit<RuntimeProcessOptions, 'mode'>) { this.process = new ExtensionRuntimeProcess({ ...options, mode: 'command' }); }
  execute(input: { command: string; args: unknown; context: ExtensionCommandRuntimeContext }, assertCurrent?: () => void): Promise<unknown> {
    return this.process.request({ method: 'command', command: input.command, args: input.args, context: input.context, assertCurrent });
  }
  close(): Promise<void> { return this.process.close(); }
}

/** Loads one extension MCP descriptor in an owned worker and returns only its value. */
export class ExtensionIsolatedMcpDescriptorRuntime {
  private readonly options: Omit<RuntimeProcessOptions, 'mode'>;
  private readonly process: ExtensionRuntimeProcess;
  constructor(options: Omit<RuntimeProcessOptions, 'mode'>) { this.options = options; this.process = new ExtensionRuntimeProcess({ ...options, mode: 'mcp' }); }
  load(input: { descriptorPath: string; sessionId: string }): Promise<unknown> {
    return this.process.request({
      method: 'mcp', descriptorPath: input.descriptorPath, descriptorSessionId: input.sessionId,
      context: {
        workspaceId: this.options.identity.workspaceId, extensionId: this.options.identity.extensionId, scope: this.options.manifest.scope,
        requestId: `mcp-descriptor:${input.sessionId}:${input.descriptorPath}`, signal: new AbortController().signal
      }
    });
  }
  close(): Promise<void> { return this.process.close(); }
}
