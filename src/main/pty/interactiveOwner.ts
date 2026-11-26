import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { IPty } from 'node-pty';
import type { ResolvedLaunch } from '../../shared/types';
import { spawnOwnedProcess, type OwnedProcess } from '../agentSession/process/owner';
import { resolveWindowsJobAsset } from '../agentSession/process/windowsJobAsset';
import { boundedAcpRequest } from '../agentSession/processReclamation';
import { INTERACTIVE_PTY_BOOTSTRAP } from './interactiveBootstrap';
import { INTERACTIVE_WINDOWS_BOOTSTRAP } from './interactiveWindows';

export class InteractivePtyCancelledError extends Error {
  constructor() { super('PTY command cancelled'); this.name = 'InteractivePtyCancelledError'; }
}
export interface InteractivePtyOwner {
  readonly ready: Promise<void>;
  readonly completed: Promise<number>;
  close(): Promise<void>;
}
export class InteractivePtyStartupCleanupError extends AggregateError {
  constructor(errors: unknown[], readonly close: () => Promise<void>) { super(errors, 'PTY startup and owned cleanup failed'); }
}
export function interactivePtyEndpoint(platform: string, temporaryDirectory: string, nonce: string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\muster-pty-${nonce}`;
  const file = `m-pty-${nonce}`;
  const candidate = path.posix.join(temporaryDirectory, file);
  return Buffer.byteLength(candidate) < 100 ? candidate : path.posix.join('/tmp', file);
}

/** Return the close owner before asynchronous setup, so cancellation cannot miss a spawning PTY. */
export function createOwnedInteractivePty(options: {
  launch: ResolvedLaunch;
  cwd: string;
  env: Record<string, string>;
  spawn(bootstrap: ResolvedLaunch): IPty;
  assertCurrent(): void;
  commandExited?(code: number): void;
  jobPath?: string;
  koffiPath?: string;
  monitor?: { businessLabel?: string; role?: string; sessionId?: string; taskId?: string };
}): InteractivePtyOwner {
  const endpoint = interactivePtyEndpoint(process.platform, os.tmpdir(), randomBytes(12).toString('hex'));
  const token = randomBytes(32).toString('hex');
  let connection: net.Socket | undefined, proc: IPty | undefined, owner: OwnedProcess | undefined;
  let stopping = false, released = false, listening = false, runSent = false;
  let resolvePhase!: () => void;
  const spawnedPhase = new Promise<void>(resolve => { resolvePhase = resolve; });
  let readerClosed: Promise<void> = Promise.resolve();
  let nativeExited = false, resolveExit!: () => void;
  const nativeExit = new Promise<void>(resolve => { resolveExit = resolve; });
  let connected!: () => void, failConnected!: (error: Error) => void;
  const hello = new Promise<void>((resolve, reject) => { connected = resolve; failConnected = reject; });
  let started!: () => void, failStarted!: (error: Error) => void;
  const commandStarted = new Promise<void>((resolve, reject) => { started = resolve; failStarted = reject; });
  let complete!: (code: number) => void, failCompleted!: (error: Error) => void;
  const commandCompleted = new Promise<number>((resolve, reject) => { complete = resolve; failCompleted = reject; });
  for (const promise of [hello, commandStarted, commandCompleted]) void promise.catch(() => {});
  const proofs = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const fail = (error: Error): void => {
    failConnected(error); failStarted(error); failCompleted(error);
    for (const proof of proofs.values()) proof.reject(error);
  };
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setEncoding('utf8');
    if (connection) { socket.destroy(); return; }
    let buffer = '', authenticated = false;
    socket.on('data', bytes => {
      buffer += bytes.toString();
      if (buffer.length > 65536) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let frame: { type: string; token?: string; pid?: number; nonce?: string; code?: number; error?: string; capabilityError?: string };
        try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!authenticated) {
          if (frame.type !== 'hello' || frame.token !== token || frame.pid !== proc?.pid) { socket.destroy(); return; }
          authenticated = true; connection = socket;
          if (frame.capabilityError) failConnected(new Error(frame.capabilityError)); else connected();
          continue;
        }
        if ((frame.type === 'proof' || frame.type === 'cleaned') && frame.pid === proc?.pid && frame.nonce) proofs.get(frame.nonce)?.resolve();
        else if (frame.type === 'cleanup-failed' && frame.nonce) proofs.get(frame.nonce)?.reject(new Error(frame.error || 'PTY session cleanup failed'));
        else if (frame.type === 'started') started();
        else if (frame.type === 'completed' && Number.isInteger(frame.code)) {
          try { options.commandExited?.(frame.code!); complete(frame.code!); } catch (error) { fail(error as Error); }
        } else if (frame.type === 'failed') fail(new Error(frame.error || 'PTY shell startup failed'));
      }
    });
    socket.on('error', error => { if (authenticated && !released) fail(error); });
    socket.on('close', () => { if (authenticated && !released) fail(new Error('PTY owner channel closed')); });
  });
  const request = async (type: 'challenge' | 'cleanup', nonce: string): Promise<void> => {
    await boundedAcpRequest(hello, 7000, 'PTY ownership connection');
    if (!connection || connection.destroyed) throw new Error('PTY ownership channel is unavailable');
    const response = new Promise<void>((resolve, reject) => { proofs.set(nonce, { resolve, reject }); });
    connection.write(JSON.stringify({ type, nonce }) + '\n');
    try { await boundedAcpRequest(response, 8000, `PTY ${type}`); } finally { proofs.delete(nonce); }
  };
  const closeServer = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    if (listening) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); listening = false; }
    if (process.platform !== 'win32') await fs.rm(endpoint, { force: true });
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (closing) return closing;
    stopping = true;
    failStarted(new InteractivePtyCancelledError()); failCompleted(new InteractivePtyCancelledError());
    const operation = Promise.resolve().then(async () => {
      await spawnedPhase;
      if (owner) await owner.reclaim();
      else if (proc && !nativeExited) {
        // No run frame was sent: only our held bootstrap exists. Close its PTY
        // object without node-pty's numeric console membership fallback.
        const agent = (proc as unknown as { _agent?: { _getConsoleProcessList?: () => Promise<number[]>; kill?: () => void } })._agent;
        if (agent?._getConsoleProcessList) agent._getConsoleProcessList = async () => [];
        try { if (process.platform === 'win32' && agent?.kill) agent.kill(); else proc.kill(); }
        catch (error) { if (!nativeExited) throw error; }
      }
      if (proc) await boundedAcpRequest(nativeExit, 7000, 'PTY native exit');
      if (proc) {
        // The process/container already exited. Never query a recycled console PID.
        const agent = (proc as unknown as { _agent?: { _getConsoleProcessList?: () => Promise<number[]>; kill?: () => void } })._agent;
        if (agent?._getConsoleProcessList) agent._getConsoleProcessList = async () => [];
        try { if (process.platform === 'win32' && agent?.kill) agent.kill(); else proc.kill(); }
        catch { /* Native exit is proven; the output-worker barrier below still must settle. */ }
      }
      await boundedAcpRequest(readerClosed, 7000, 'PTY output worker close');
      await closeServer();
      released = true;
    });
    closing = operation.catch(error => { closing = undefined; throw error; });
    return closing;
  };
  const ready = Promise.resolve().then(async () => {
    if (stopping) throw new Error('PTY startup cancelled');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.removeListener('error', reject); listening = true; resolve(); }); });
    server.on('error', fail);
    if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600);
    if (stopping) throw new Error('PTY startup cancelled');
    options.assertCurrent();
    const jobPath = process.platform === 'win32' ? options.jobPath ?? resolveWindowsJobAsset(__dirname) : '';
    const koffiPath = process.platform === 'win32' ? '' : (options.koffiPath ?? createRequire(typeof __filename === 'string' ? __filename : import.meta.url).resolve('koffi')).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
    // A console-subsystem bootstrap holds ConPTY, authenticates its own PID and
    // waits for the assigned Job before spawning any user command.
    const bootstrap: ResolvedLaunch = {
      command: process.execPath, args: ['-e', INTERACTIVE_PTY_BOOTSTRAP],
      env: { ELECTRON_RUN_AS_NODE: '1', MUSTER_PTY_OWNER_ENDPOINT: endpoint, MUSTER_PTY_OWNER_TOKEN: token, MUSTER_PTY_OWNER_KOFFI: koffiPath }
    };
    if (process.platform === 'win32') {
      bootstrap.command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      bootstrap.args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(INTERACTIVE_WINDOWS_BOOTSTRAP, 'utf16le').toString('base64')];
    }
    owner = spawnOwnedProcess({ command: bootstrap.command, args: bootstrap.args, spawnOptions: {}, windows: { kind: 'job', jobPath },
      monitor: options.monitor,
      beforeReclaim: async () => { if (process.platform !== 'win32' && runSent) await request('cleanup', randomBytes(16).toString('hex')); },
      spawnProcess: ((_command: string, _args: readonly string[], _spawnOptions: SpawnOptions) => {
        proc = options.spawn(bootstrap);
        const adapter = new EventEmitter() as unknown as ChildProcess;
        Object.assign(adapter, { pid: proc.pid, exitCode: null, signalCode: null, kill: (signal?: string) => {
          if (process.platform === 'win32') {
            const agent = (proc as unknown as { _agent?: { _getConsoleProcessList?: () => Promise<number[]>; kill?: () => void } })._agent;
            if (agent?._getConsoleProcessList) agent._getConsoleProcessList = async () => [];
            if (agent?.kill) agent.kill(); else proc!.kill();
          } else proc!.kill(signal);
          return true;
        } });
        proc.onExit(({ exitCode }) => { nativeExited = true; resolveExit(); Object.assign(adapter, { exitCode }); adapter.emit('exit', exitCode, null); if (!stopping) fail(new Error('PTY leader exited unexpectedly')); });
        if (process.platform === 'win32') {
          const worker = (proc as unknown as { _agent?: { _conoutSocketWorker?: { _worker?: { threadId: number; once(event: string, callback: () => void): unknown } } } })._agent?._conoutSocketWorker?._worker;
          if (!worker || typeof worker.once !== 'function') {
            const error = new Error('Unsupported node-pty output-worker contract; rebuild or reinstall Muster');
            readerClosed = Promise.reject(error); void readerClosed.catch(() => {}); throw error;
          }
          readerClosed = worker.threadId === -1 ? Promise.resolve() : new Promise<void>(resolve => worker.once('exit', resolve));
        }
        return adapter;
      }) as typeof import('node:child_process').spawn,
      identityChallenge: async (_child, nonce) => { await request('challenge', nonce); return nonce; }
    });
    resolvePhase();
    await owner.ready; await boundedAcpRequest(hello, 7000, 'PTY owner startup');
    options.assertCurrent(); if (stopping) throw new Error('PTY startup cancelled');
    runSent = true;
    connection!.write(JSON.stringify({ type: 'run', command: options.launch.command, args: options.launch.args, env: options.env, cwd: options.cwd, windowsVerbatimArguments: options.launch.windowsVerbatimArguments }) + '\n');
    await boundedAcpRequest(commandStarted, 7000, 'PTY shell startup');
  }).catch(async error => {
    resolvePhase();
    try { await close(); } catch (cleanup) { throw new InteractivePtyStartupCleanupError([error, cleanup], close); }
    throw error;
  });
  void ready.catch(() => {});
  const completed = commandCompleted.then(async code => { await close(); return code; }, async error => { await close(); throw error; });
  void completed.catch(() => {});
  return { ready, completed, close };
}
