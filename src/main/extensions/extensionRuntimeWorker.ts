/**
 * Process entry for extension DomainRuntime and toolbar command modules.
 *
 * The parent owns this process and speaks a small authenticated RPC protocol
 * over Node's private IPC channel.  Extension code is imported only here; the
 * Electron main process receives values and events, never extension modules.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionCommandRuntimeContext } from '../../shared/extensionManifest';

type Message = Record<string, unknown>;
type Identity = { extensionId: string; extensionInstanceId: string; workspaceId: string; sourceRootId?: string; packageFingerprint: string; surfaceId: string };
type Manifest = Record<string, unknown>;
type PendingBroker = { resolve: (value: unknown) => void; reject: (error: Error) => void; requestId: string; onDelta?: (delta: string) => void; cleanup?: () => void };
type Runtime = {
  getSnapshot?: (context: Record<string, unknown>) => unknown;
  query?: (name: string, args: unknown, context: Record<string, unknown>) => unknown;
  execute?: (name: string, args: unknown, context: Record<string, unknown>) => unknown;
  subscribe?: (listener: (event: unknown) => void) => (() => void) | void;
  close?: () => unknown;
};
type CommandRuntime = { execute: (input: Record<string, unknown>) => unknown; close?: () => unknown };

const send = (message: Message): void => {
  if (process.connected) process.send?.(message);
};

let authToken = '';
let identity: Identity;
let manifest: Manifest;
let packageRoot = '';
let mode: 'domain' | 'command' | 'mcp' = 'domain';
let runtime: Runtime | CommandRuntime | undefined;
let mcpFactory: unknown;
let eventStop: (() => void) | undefined;
let ready: Promise<void> | undefined;
let brokerSequence = 0;
const brokerPending = new Map<string, PendingBroker>();
const requests = new Map<string, { controller: AbortController; requestId: string }>();

function assertAuth(message: Message): boolean {
  return typeof message.token === 'string' && !!authToken && message.token === authToken;
}

function safeEntry(relative: string): string {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('extension runtime entry path is invalid');
  const root = path.resolve(packageRoot);
  const file = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('extension runtime entry escaped package root');
  return file;
}

function broker(method: string, args: unknown[], context: Record<string, unknown>, onDelta?: (delta: string) => void): Promise<unknown> {
  const id = `broker-${++brokerSequence}`;
  return new Promise((resolve, reject) => {
    const signal = context.signal as AbortSignal | undefined;
    if (signal?.aborted) { reject(new DOMException('The operation was aborted', 'AbortError')); return; }
    const abort = (): void => {
      brokerPending.delete(id); signal?.removeEventListener('abort', abort);
      send({ type: 'brokerCancel', token: authToken, id });
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    brokerPending.set(id, { resolve, reject, requestId: String(context.requestId ?? ''), onDelta, cleanup: () => signal?.removeEventListener('abort', abort) });
    const { signal: _signal, ...serializableContext } = context;
    send({ type: 'broker', token: authToken, id, method, args, context: serializableContext });
  });
}

async function loadModule(entry: string): Promise<unknown> {
  const file = safeEntry(entry);
  return import(`${pathToFileURL(file).href}?fingerprint=${encodeURIComponent(identity.packageFingerprint)}`);
}

async function initialize(message: Message): Promise<void> {
  if (typeof message.token !== 'string' || message.token.length < 16 || !message.identity || typeof message.identity !== 'object' || !message.manifest || typeof message.manifest !== 'object' || typeof message.packageRoot !== 'string') throw new Error('extension runtime initialization is invalid');
  authToken = message.token;
  identity = structuredClone(message.identity) as Identity;
  manifest = structuredClone(message.manifest) as Manifest;
  packageRoot = path.resolve(message.packageRoot);
  mode = message.mode === 'command' ? 'command' : message.mode === 'mcp' ? 'mcp' : 'domain';
  const entry = typeof message.entry === 'string' ? message.entry : '';
  if (!entry) throw new Error('extension runtime entry is missing');
  const module = await loadModule(entry) as { createDomainRuntime?: (input: Record<string, unknown>) => unknown; createCommandRuntime?: (input: Record<string, unknown>) => unknown; createMcpDescriptor?: unknown; mcp?: unknown; default?: unknown };
  if (mode === 'mcp') {
    mcpFactory = module.createMcpDescriptor ?? module.mcp ?? module.default;
    if (mcpFactory === undefined) throw new Error(`extension MCP descriptor has no factory: ${entry}`);
    return;
  }
  const factory = mode === 'domain' ? module.createDomainRuntime ?? module.default : module.createCommandRuntime ?? module.default;
  if (typeof factory !== 'function') throw new Error(`extension ${mode} module must export a runtime factory: ${entry}`);
  const created = await factory({ identity: structuredClone(identity), manifest: structuredClone(manifest), packageRoot, broker });
  if (!created || typeof created !== 'object') throw new Error(`extension ${mode} module returned an invalid runtime: ${entry}`);
  runtime = created as Runtime | CommandRuntime;
  if (mode === 'domain') {
    const domain = runtime as Runtime;
    if (typeof domain.getSnapshot !== 'function' || typeof domain.query !== 'function' || typeof domain.execute !== 'function' || typeof domain.subscribe !== 'function') throw new Error('extension domain runtime is invalid');
    const stop = domain.subscribe(event => send({ type: 'event', token: authToken, event }));
    if (typeof stop === 'function') eventStop = stop;
  } else if (typeof (runtime as CommandRuntime).execute !== 'function') throw new Error('extension command runtime is invalid');
}

function contextFor(message: Message, controller: AbortController): Record<string, unknown> {
  return {
    identity: structuredClone(identity), manifest: structuredClone(manifest),
    ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
    ...(typeof message.taskRef === 'string' ? { taskRef: message.taskRef } : {}),
    actor: message.actor === 'agent' ? 'agent' : 'human', requestId: String(message.requestId ?? ''), signal: controller.signal, ...(Number.isSafeInteger(message.expectedVersion) ? { expectedVersion: message.expectedVersion } : {}) };
}

async function handleRequest(message: Message): Promise<void> {
  const id = String(message.id ?? '');
  if (!id || requests.has(id)) { send({ type: 'result', token: authToken, id, ok: false, error: 'Duplicate extension runtime request' }); return; }
  const controller = new AbortController();
  const requestId = String(message.requestId ?? id);
  requests.set(id, { controller, requestId });
  try {
    if (mode !== 'mcp' && !runtime) throw new Error('extension runtime is not initialized');
    let result: unknown;
    if (mode === 'mcp') {
      if (mcpFactory === undefined) throw new Error('extension MCP descriptor is not initialized');
      const descriptorInput = { identity: structuredClone(identity), manifest: structuredClone(manifest), packageRoot,
        descriptorPath: String(message.descriptorPath ?? ''), sessionId: String(message.descriptorSessionId ?? '') };
      result = typeof mcpFactory === 'function' ? await (mcpFactory as (input: Record<string, unknown>) => unknown)(descriptorInput) : mcpFactory;
    } else if (mode === 'domain') {
      const domain = runtime as Runtime;
      const context = contextFor(message, controller);
      if (message.method === 'snapshot') result = await domain.getSnapshot!(context);
      else if (message.method === 'query') result = await domain.query!(String(message.name ?? ''), message.args, context);
      else if (message.method === 'execute') result = await domain.execute!(String(message.name ?? ''), message.args, context);
      else throw new Error(`Unknown extension domain method: ${String(message.method)}`);
    } else {
      const context: ExtensionCommandRuntimeContext = {
        workspaceId: identity.workspaceId,
        extensionId: identity.extensionId,
        scope: manifest.scope === 'project' ? 'project' : 'global',
        ...(identity.sourceRootId ? { sourceRootId: identity.sourceRootId } : {}),
        ...(typeof message.sourceRoot === 'string' ? { sourceRoot: message.sourceRoot } : {}),
        ...(typeof message.rootsRevision === 'number' ? { rootsRevision: message.rootsRevision } : {}),
        requestId,
        signal: controller.signal
      };
      result = await (runtime as CommandRuntime).execute({ command: String(message.command ?? ''), args: message.args, context });
    }
    if (controller.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    send({ type: 'result', token: authToken, id, ok: true, result });
  } catch (error) {
    send({ type: 'result', token: authToken, id, ok: false, error: String(error), name: error instanceof Error ? error.name : undefined });
  } finally {
    requests.delete(id);
  }
}

process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as Message;
  if (message.type === 'identityChallenge' && typeof message.nonce === 'string' && message.nonce.length <= 128) {
    send({ type: 'identityProof', nonce: message.nonce });
    return;
  }
  if (message.type === 'init') {
    if (ready) { send({ type: 'fatal', error: 'extension runtime worker was initialized twice' }); return; }
    ready = initialize(message);
    void ready.then(() => send({ type: 'ready', token: authToken }), error => send({ type: 'fatal', error: String(error) }));
    return;
  }
  if (!assertAuth(message)) return;
  if (message.type === 'brokerDelta' && typeof message.id === 'string' && typeof message.delta === 'string') {
    brokerPending.get(message.id)?.onDelta?.(message.delta);
  } else if (message.type === 'brokerReply' && typeof message.id === 'string') {
    const pending = brokerPending.get(message.id);
    if (!pending) return;
    brokerPending.delete(message.id);
    pending.cleanup?.();
    message.ok ? pending.resolve(message.result) : pending.reject(new Error(String(message.error)));
  } else if (message.type === 'cancel' && typeof message.id === 'string') {
    const request = requests.get(message.id);
    request?.controller.abort();
    if (request) {
      for (const [brokerId, pending] of brokerPending) {
        if (pending.requestId !== request.requestId) continue;
        brokerPending.delete(brokerId);
        pending.cleanup?.();
        pending.reject(new DOMException('The operation was aborted', 'AbortError'));
      }
    }
  } else if (message.type === 'request') {
    if (!ready) { send({ type: 'result', token: authToken, id: message.id, ok: false, error: 'extension runtime worker is not ready' }); return; }
    void ready.then(() => handleRequest(message)).catch(error => send({ type: 'result', token: authToken, id: message.id, ok: false, error: String(error) }));
  } else if (message.type === 'stop') {
    for (const request of requests.values()) request.controller.abort();
    eventStop?.(); eventStop = undefined;
    void Promise.resolve().then(() => runtime && 'close' in runtime ? runtime.close?.() : undefined).catch(() => {}).finally(() => { for (const pending of brokerPending.values()) { pending.cleanup?.(); pending.reject(new Error('extension runtime stopped')); } brokerPending.clear(); process.disconnect?.(); });
  }
});

process.on('disconnect', () => {
  for (const request of requests.values()) request.controller.abort();
  eventStop?.(); eventStop = undefined;
});
