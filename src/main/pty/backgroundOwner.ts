import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
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
import { BACKGROUND_PTY_BOOTSTRAP } from './backgroundBootstrap';

export class BackgroundPtyCleanupError extends Error {
  constructor(readonly commandExitCode: number, cause: unknown) {
    super('Background command completed, but its process container could not be reclaimed', { cause });
    this.name = 'BackgroundPtyCleanupError';
  }
}

export class BackgroundPtyStartupCleanupError extends AggregateError {
  constructor(errors: unknown[], readonly close: () => Promise<void>) {
    super(errors, 'PTY startup and cleanup failed');
  }
}

/** Keep Darwin's long per-user TMPDIR below the Unix socket pathname limit. */
export function backgroundPtyEndpoint(platform: string, temporaryDirectory: string, nonce: string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\muster-bg-${nonce}`;
  const filename = `m-bg-${nonce}`;
  const candidate = path.posix.join(temporaryDirectory, filename);
  return Buffer.byteLength(candidate) <= 100 ? candidate : path.posix.join('/tmp', filename);
}

type Frame = { type: string; token?: string; pid?: number; nonce?: string; code?: number; error?: string; id?: number };
export interface OwnedBackgroundPty {
  close(): Promise<void>;
  readonly completed: Promise<number>;
  writeInput(data: Buffer): Promise<void>;
  endInput(): Promise<void>;
}
export interface BackgroundPtyOptions {
  launch: ResolvedLaunch;
  cwd: string;
  spawn(launch: ResolvedLaunch): IPty;
  assertCurrent(): void;
  jobPath?: string;
  commandExited?(code: number): void;
  shell?: boolean;
  pipeInput?: boolean;
  replaceEnv?: boolean;
  monitor?: { businessLabel?: string; role?: string; sessionId?: string; taskId?: string };
}

/** Establish ownership of a held PTY leader before it can start user code. */
export async function startOwnedBackgroundPty(options: BackgroundPtyOptions): Promise<OwnedBackgroundPty> {
  const endpoint = backgroundPtyEndpoint(process.platform, os.tmpdir(), randomBytes(12).toString('hex'));
  const token = randomBytes(32).toString('hex');
  let connection: net.Socket | undefined;
  let hello!: () => void, failedHello!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { hello = resolve; failedHello = reject; });
  void connected.catch(() => {});
  let proof: ((frame: Frame) => void) | undefined;
  let started!: () => void, failedStart!: (error: Error) => void;
  const commandStarted = new Promise<void>((resolve, reject) => { started = resolve; failedStart = reject; });
  void commandStarted.catch(() => {});
  let completed!: (code: number) => void, failedCompletion!: (error: Error) => void;
  const commandCompleted = new Promise<number>((resolve, reject) => { completed = resolve; failedCompletion = reject; });
  void commandCompleted.catch(() => {});
  let proc: IPty | undefined, owner: OwnedProcess | undefined, closed = false;
  const inputAcks = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let inputId = 0, inputTail = Promise.resolve(), inputEnd: Promise<void> | undefined;
  const rejectInput = (error: Error): void => { for (const pending of inputAcks.values()) pending.reject(error); inputAcks.clear(); };
  const fail = (error: Error): void => { rejectInput(error); failedHello(error); failedStart(error); failedCompletion(error); };
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setEncoding('utf8');
    if (connection) { socket.destroy(); return; }
    let buffer = '', authenticated = false;
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8');
      if (buffer.length > 65536) { socket.destroy(); fail(new Error('PTY owner frame too large')); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let frame: Frame;
        try { frame = JSON.parse(line); } catch { socket.destroy(); fail(new Error('Invalid PTY owner frame')); return; }
        if (!authenticated) {
          if (frame.type !== 'hello' || frame.token !== token || frame.pid !== proc?.pid) { socket.destroy(); return; }
          authenticated = true; connection = socket; hello(); continue;
        }
        if (frame.type === 'proof') proof?.(frame);
        else if (frame.type === 'input-ack' && Number.isSafeInteger(frame.id)) {
          const pending = inputAcks.get(frame.id!); inputAcks.delete(frame.id!);
          if (frame.error) pending?.reject(new Error(frame.error)); else pending?.resolve();
        }
        else if (frame.type === 'started') started();
        else if (frame.type === 'completed' && Number.isInteger(frame.code)) { try { options.commandExited?.(frame.code!); completed(frame.code!); } catch (error) { fail(error as Error); } }
        else if (frame.type === 'failed') fail(new Error(frame.error || 'PTY command failed'));
      }
    });
    socket.on('error', error => { if (authenticated && !closed) fail(error); });
    socket.on('close', () => { if (authenticated && !closed) fail(new Error('PTY owner connection closed')); });
  });
  const closeServer = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.platform !== 'win32') await fs.rm(endpoint, { force: true });
  };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); }); });
  server.on('error', fail);
  if (process.platform !== 'win32') try { await fs.chmod(endpoint, 0o600); } catch (error) { await closeServer(); throw error; }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    rejectInput(new Error('Controlled command input closed'));
    failedCompletion(new Error('PTY command cancelled'));
    closing = (async () => {
      // Keep the authenticated channel/leader alive until its container is gone.
      await owner?.reclaim();
      await closeServer();
    })().catch(error => { closing = undefined; throw error; });
    return closing;
  };
  try {
    const jobPath = process.platform === 'win32' ? options.jobPath ?? resolveWindowsJobAsset(__dirname) : '';
    owner = spawnOwnedProcess({ command: process.execPath, args: ['-e', BACKGROUND_PTY_BOOTSTRAP],
      spawnOptions: {}, windows: { kind: 'job', jobPath },
      monitor: options.monitor,
      spawnProcess: ((_command: string, _args: readonly string[], _spawnOptions: SpawnOptions) => {
        proc = options.spawn({ command: process.execPath, args: ['-e', BACKGROUND_PTY_BOOTSTRAP], env: { ELECTRON_RUN_AS_NODE: '1', MUSTER_BG_OWNER_ENDPOINT: endpoint, MUSTER_BG_OWNER_TOKEN: token } });
        const adapter = new EventEmitter() as unknown as ChildProcess;
        Object.assign(adapter, { pid: proc.pid, exitCode: null, signalCode: null, kill: (signal?: string) => { proc!.kill(signal); return true; } });
        proc.onExit(({ exitCode }) => { Object.assign(adapter, { exitCode }); adapter.emit('exit', exitCode, null); if (!closed) fail(new Error('PTY leader exited before reclamation')); });
        return adapter;
      }) as typeof import('node:child_process').spawn,
      identityChallenge: async (_child, nonce) => {
        await boundedAcpRequest(connected, 7000, 'PTY owner connection');
        const response = new Promise<string>(resolve => { proof = frame => { if (frame.pid === proc?.pid && frame.nonce === nonce) resolve(nonce); }; });
        connection!.write(JSON.stringify({ type: 'challenge', nonce }) + '\n');
        try { return await boundedAcpRequest(response, 7000, 'PTY owner identity'); } finally { proof = undefined; }
      }
    });
    await owner.ready;
    await boundedAcpRequest(connected, 7000, 'PTY owner connection');
    options.assertCurrent();
    connection!.write(JSON.stringify({ type: 'run', command: options.launch.command, args: options.launch.args, env: options.launch.env, replaceEnv: options.replaceEnv, windowsVerbatimArguments: options.launch.windowsVerbatimArguments, shell: options.shell, pipeInput: options.pipeInput, cwd: options.cwd }) + '\n');
    await boundedAcpRequest(commandStarted, 7000, 'PTY command startup');
    const completedAndReclaimed = commandCompleted.then(async code => {
      try { await close(); } catch (error) { throw new BackgroundPtyCleanupError(code, error); }
      return code;
    }, async error => {
      try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'PTY command and cleanup failed'); }
      throw error;
    });
    void completedAndReclaimed.catch(() => {});
    const sendInput = (type: 'stdin' | 'stdin-end', data?: Buffer): Promise<void> => new Promise((resolve, reject) => {
      if (closed || !options.pipeInput || !connection || connection.destroyed) { reject(new Error('Controlled command input is closed')); return; }
      const id = ++inputId; inputAcks.set(id, { resolve, reject });
      try {
        // At most one bounded frame is in flight; the next frame waits for the
        // child's actual stdin write callback, not the local socket buffer.
        connection.write(JSON.stringify({ type, id, ...(data ? { data: data.toString('base64') } : {}) }) + '\n', error => {
          if (!error) return; inputAcks.get(id)?.reject(error); inputAcks.delete(id);
        });
      } catch (error) { inputAcks.delete(id); reject(error); }
    });
    const enqueueInput = (work: () => Promise<void>): Promise<void> => {
      const pending = inputTail.then(work); inputTail = pending; void pending.catch(() => {}); return pending;
    };
    return { close, completed: completedAndReclaimed,
      writeInput: data => {
        if (inputEnd) return Promise.reject(new Error('Controlled command input already ended'));
        return enqueueInput(async () => {
          for (let offset = 0; offset < data.length; offset += 64 * 1024) await sendInput('stdin', data.subarray(offset, offset + 64 * 1024));
        });
      },
      endInput: () => inputEnd ??= enqueueInput(() => sendInput('stdin-end'))
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new BackgroundPtyStartupCleanupError([error, cleanupError], close); }
    throw error;
  }
}
