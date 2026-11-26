import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { startOwnedCommand } from './ownedCommand';
import { BackgroundPtyCleanupError, BackgroundPtyStartupCleanupError, type OwnedBackgroundPty } from '../../pty/backgroundOwner';

export interface ControlledChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly started: boolean;
  reclaim(): Promise<void>;
}

const retained = new Set<ControlledChild>();
let admissionClosed = false;
let stopping: Promise<void> | undefined;

/** A synchronous stdio handle, with all user code held until its Job/group is owned. */
export function createControlledChild(command: string, args: string[], options: SpawnOptions = {}): ControlledChild {
  if (admissionClosed) throw new Error('Controlled process service is stopping');
  if (typeof options.shell === 'string') throw new Error('Custom shell paths require an explicit command and arguments');
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough();
  let starting!: Promise<OwnedBackgroundPty>, owner: OwnedBackgroundPty | undefined;
  let requested = false, finished = false, activated = false, reclaiming: Promise<void> | undefined;
  let leader: ChildProcess | undefined;
  let signal: NodeJS.Signals | null = null;
  const emitFailure = (error: unknown) => child.emit('error', error instanceof Error ? error : new Error(String(error)));
  // Startup failure is also carried by ready; retaining an internal listener
  // prevents a cancellation before a consumer attaches from crashing Electron.
  child.on('error', () => {});
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void starting.then(value => value.writeInput(chunk)).then(() => callback(), error => callback(error as Error));
    },
    final(callback) { void starting.then(value => value.endInput()).then(() => callback(), error => callback(error as Error)); },
    destroy(error, callback) { void starting.then(value => value.endInput()).catch(() => {}); callback(error); }
  });
  Object.assign(child, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
    pid: undefined, exitCode: null, signalCode: null, killed: false,
    spawnfile: command, spawnargs: [command, ...args], connected: false,
    kill: (requestedSignal: NodeJS.Signals = 'SIGTERM') => {
      if (finished) return false;
      requested = true; signal = requestedSignal; Object.assign(child, { killed: true });
      void lease.reclaim().catch(emitFailure); return true;
    }, ref: () => child, unref: () => child
  });
  const finish = (code: number | null, killedSignal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true; retained.delete(lease);
    options.signal?.removeEventListener('abort', abort);
    Object.assign(child, { exitCode: code, signalCode: killedSignal });
    stdout.end(); stderr.end();
    child.emit('exit', code, killedSignal); child.emit('close', code, killedSignal);
  };
  const lease: ControlledChild = {
    child, get ready() { return ready; }, get started() { return activated; },
    reclaim: () => {
      if (reclaiming) return reclaiming;
      requested = true;
      // SDK waitForExit also uses killed + its delivered exit event to avoid
      // waiting for an event that already happened after host-owned shutdown.
      if (!finished) Object.assign(child, { killed: true });
      reclaiming = (async () => {
        let active: OwnedBackgroundPty;
        try { active = owner ?? await starting; }
        catch (error) {
          if (error instanceof BackgroundPtyStartupCleanupError) await error.close();
          // Other startup errors are returned only after complete reclamation.
          finish(null, signal ?? 'SIGKILL'); return;
        }
        stdout.resume(); stderr.resume(); leader?.stdout?.resume(); leader?.stderr?.resume();
        await active.close(); finish(null, signal ?? 'SIGKILL');
      })();
      void reclaiming.catch(() => { reclaiming = undefined; });
      return reclaiming;
    }
  };
  const abort = () => { child.kill('SIGTERM'); };
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  starting = startOwnedCommand({ command, args, cwd: typeof options.cwd === 'string' || options.cwd === undefined ? options.cwd ?? process.cwd() : fileURLToPath(options.cwd), env, replaceEnv: true, pipeInput: true,
    shell: options.shell, windowsVerbatimArguments: options.windowsVerbatimArguments,
    assertCurrent: () => { if (requested || options.signal?.aborted || admissionClosed) throw new Error('Controlled process startup cancelled'); },
    leader: process => { leader = process; Object.assign(child, { pid: process.pid }); },
    stdout: data => { if (!stdout.write(data)) { leader?.stdout?.pause(); stdout.once('drain', () => leader?.stdout?.resume()); } },
    stderr: data => { if (!stderr.write(data)) { leader?.stderr?.pause(); stderr.once('drain', () => leader?.stderr?.resume()); } }
  });
  const ready = starting.then(active => {
    owner = active; activated = true; child.emit('spawn');
    if (requested) void lease.reclaim().catch(emitFailure);
    void active.completed.then(code => finish(code, null), async error => {
      // Explicit reclamation already owns both cleanup and its failure receipt
      // (kill() also emits that rejection). Do not turn its cancelled command
      // outcome into another SDK error/abort and a second cleanup attempt.
      if (requested) return;
      // An execution outcome does not erase a failed cleanup owner.
      emitFailure(error);
      try {
        await active.close();
        finish(error instanceof BackgroundPtyCleanupError ? error.commandExitCode : null, signal);
      } catch (cleanup) { emitFailure(cleanup); }
    }).catch(emitFailure);
  }, error => {
    emitFailure(error);
    if (!(error instanceof BackgroundPtyStartupCleanupError)) finish(null, signal);
    throw error;
  });
  void ready.catch(() => {});
  retained.add(lease);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  if (Array.isArray(options.stdio) && options.stdio[0] === 'ignore') stdin.end();
  return lease;
}

/** Includes failed startups and one-off commands that already returned a business error. */
export function shutdownControlledChildren(): Promise<void> {
  if (stopping) return stopping;
  admissionClosed = true;
  stopping = (async () => {
    const results = await Promise.allSettled([...retained].map(owner => owner.reclaim()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Controlled process shutdown failed');
  })();
  void stopping.catch(() => { stopping = undefined; });
  return stopping;
}
