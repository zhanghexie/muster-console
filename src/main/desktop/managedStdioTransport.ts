import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { spawnOwnedProcess, type OwnedProcess, type OwnedProcessOptions } from '../agentSession/process/owner';
import { resolveWindowsJobAsset } from '../agentSession/process/windowsJobAsset';
import { CUA_DRIVER_WRAPPER_SOURCE } from './cuaDriverWrapper';

type ProcessFactory = (options: OwnedProcessOptions<ChildProcessWithoutNullStreams>) => OwnedProcess<ChildProcessWithoutNullStreams>;

const moduleFile = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);

function windowsJobFile(): string {
  const base = path.dirname(moduleFile);
  for (const directory of [base, path.join(base, '..', 'agentSession', 'process')]) {
    try { return resolveWindowsJobAsset(directory); } catch { /* try the other bundled/source layout */ }
  }
  throw new Error('Desktop driver process guardian is missing; rebuild or reinstall the application');
}

function bootstrapEnvironment(environment: Record<string, string>): Record<string, string> {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (/^(NODE_OPTIONS|NODE_PATH|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL)$/i.test(key)) delete result[key];
  }
  result.ELECTRON_RUN_AS_NODE = '1';
  return result;
}

/** Wait for one private control response without mixing it with MCP stdout. */
function wrapperMessage(child: ChildProcessWithoutNullStreams, expected: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('Desktop driver wrapper handshake timed out')), 10_000);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer); child.off('message', onMessage); child.off('error', onError);
      child.off('exit', onExit); child.off('disconnect', onDisconnect); signal.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error, message?: Record<string, unknown>): void => {
      if (done) return;
      done = true; cleanup();
      if (error) reject(error); else resolve(message!);
    };
    const onMessage = (raw: unknown): void => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { finish(new Error('Invalid desktop driver wrapper response')); return; }
      const message = raw as Record<string, unknown>;
      if (message.type === 'driver-failed') {
        const code = typeof message.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(message.code) ? ` (${message.code})` : '';
        finish(new Error(`Desktop driver wrapper failed${code}`)); return;
      }
      if (message.type !== expected) { finish(new Error('Unexpected desktop driver wrapper response')); return; }
      finish(undefined, message);
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (): void => finish(new Error('Desktop driver wrapper exited during startup'));
    const onDisconnect = (): void => finish(new Error('Desktop driver wrapper IPC disconnected'));
    const onAbort = (): void => finish(new Error('Desktop driver startup was cancelled'));
    child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit); child.once('disconnect', onDisconnect);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (!child.connected || typeof child.send !== 'function') onDisconnect();
  });
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(new Error('Desktop driver startup was cancelled')); };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

function sendWrapper(child: ChildProcessWithoutNullStreams, message: object): void {
  if (!child.connected || typeof child.send !== 'function') throw new Error('Desktop driver wrapper IPC disconnected');
  child.send(message, error => { if (error) child.emit('error', error); });
}

/** An MCP transport whose close only succeeds after the child process actually closes. */
export class ManagedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private process?: ChildProcessWithoutNullStreams;
  private owner?: OwnedProcess<ChildProcessWithoutNullStreams>;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 10 * 1024 * 1024 });
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private readonly lifetime = new AbortController();
  private started = false;
  private running = false;
  private wrapperUnavailable = false;
  private failed = false;

  constructor(private readonly command: string, private readonly env: Record<string, string>,
    private readonly graceMs = 2000, private readonly args = ['mcp', '--direct'],
    private readonly spawn: ProcessFactory = spawnOwnedProcess,
    /** Host-only asset override for isolated tests; never model-controlled. */
    private readonly jobPath?: string) {}

  async start(): Promise<void> {
    if (this.started || this.closing) throw new Error('Desktop driver transport already started or closed');
    this.started = true;
    const windows = process.platform === 'win32';
    // Capture the host-selected plan before any asynchronous ownership step.
    const command = this.command, args = [...this.args], environment = { ...this.env };
    let bootstrap: Promise<Record<string, unknown>> | undefined;
    const owner = this.spawn(windows ? {
      command: process.execPath, args: ['-e', CUA_DRIVER_WRAPPER_SOURCE],
      spawnOptions: { env: bootstrapEnvironment(environment), stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
      windows: { kind: 'job', jobPath: this.jobPath ?? windowsJobFile() }, reclaimTimeoutMs: Math.max(15000, this.graceMs),
      identityChallenge: async (child, nonce, signal) => {
        if (!bootstrap) throw new Error('Desktop driver wrapper bootstrap is unavailable');
        await awaitWithSignal(bootstrap, signal);
        const response = wrapperMessage(child, 'identity-response', signal);
        try { sendWrapper(child, { type: 'identity-challenge', nonce }); }
        catch (error) { void response.catch(() => {}); throw error; }
        const value = await response;
        if (typeof value.nonce !== 'string') throw new Error('Invalid desktop driver identity response');
        return value.nonce;
      }
    } : { command, args,
      spawnOptions: { env: environment, stdio: 'pipe' }, windows: { kind: 'taskkill' }, reclaimTimeoutMs: Math.max(5000, this.graceMs) });
    this.owner = owner;
    const child = owner.child;
    this.process = child;
    if (windows) {
      bootstrap = wrapperMessage(child, 'wrapper-ready', this.lifetime.signal);
      void bootstrap.catch(() => {});
      child.on('message', raw => {
        if (raw && typeof raw === 'object' && !Array.isArray(raw) &&
            ['driver-exited', 'driver-failed'].includes(String((raw as Record<string, unknown>).type))) {
          this.wrapperUnavailable = true;
          if (this.running) this.fail(new Error('Desktop driver process exited unexpectedly'));
        }
      });
    }
    this.exited = new Promise(resolve => child.once('close', () => {
      this.buffer.clear();
      try { this.onclose?.(); } finally { resolve(); }
    }));
    child.stderr.resume();
    child.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.stdout.on('error', error => this.fail(error));
    child.stdout.on('end', () => this.fail(new Error('Desktop driver output ended')));
    child.stdout.on('close', () => this.fail(new Error('Desktop driver output closed')));
    child.stderr.on('error', error => this.fail(error));
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) this.onmessage?.(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    try {
      await owner.ready;
      if (this.closing || this.lifetime.signal.aborted) throw new Error('Desktop driver startup was cancelled');
      if (windows) {
        const activated = wrapperMessage(child, 'driver-started', this.lifetime.signal);
        try { sendWrapper(child, { type: 'launch', command, args, env: environment }); }
        catch (error) { void activated.catch(() => {}); throw error; }
        await activated;
      }
      if (this.closing || this.lifetime.signal.aborted) throw new Error('Desktop driver startup was cancelled');
      if (windows && (this.wrapperUnavailable || child.exitCode != null || child.signalCode != null)) {
        throw new Error('Desktop driver exited during startup');
      }
      this.running = true;
    } catch (error) {
      try { await this.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Desktop driver startup failed and process reclamation is unconfirmed'); }
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || this.closing || !this.running) throw new Error('Desktop driver is not connected');
    await new Promise<void>((resolve, reject) => stdin.write(serializeMessage(message), error => error ? reject(error) : resolve()));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.running = false;
    this.lifetime.abort();
    void this.closeProcess().then(resolve, reject);
    return this.closing;
  }

  private fail(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    try { this.onerror?.(error); } catch { /* observer failures must not crash the host */ }
    finally { void this.close().catch(() => undefined); }
  }

  private async closeProcess(): Promise<void> {
    const owner = this.owner;
    const exited = this.exited;
    if (!owner || !exited) return;
    // Reclaim while the root is still owned; graceful stdin EOF could let it
    // exit first and make the remaining tree impossible to identify safely.
    await owner.reclaim();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Desktop driver streams did not close after reclamation')), Math.max(5000, this.graceMs));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
