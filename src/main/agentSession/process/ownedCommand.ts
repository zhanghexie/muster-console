import { spawn, type ChildProcess } from 'node:child_process';
import type { IPty } from 'node-pty';
import { startOwnedBackgroundPty, type OwnedBackgroundPty } from '../../pty/backgroundOwner';

export type OwnedCommandOptions = {
  command: string;
  args: string[];
  cwd: string;
  shell?: boolean;
  assertCurrent(): void;
  stdout?(chunk: Buffer): void;
  stderr?(chunk: Buffer): void;
  env?: Record<string, string>;
  pipeInput?: boolean;
  replaceEnv?: boolean;
  windowsVerbatimArguments?: boolean;
  leader?(child: ChildProcess): void;
};

/** Pipe-based adapter for the same authenticated held leader used by background PTYs. */
export async function startOwnedCommand(options: OwnedCommandOptions): Promise<OwnedBackgroundPty> {
  let child: ChildProcess | undefined;
  let pipeClosed: Promise<void> = Promise.resolve();
  const owner = await startOwnedBackgroundPty({
    launch: { command: options.command, args: options.args, env: options.env, windowsVerbatimArguments: options.windowsVerbatimArguments }, cwd: options.cwd,
    shell: options.shell, pipeInput: options.pipeInput, replaceEnv: options.replaceEnv, assertCurrent: options.assertCurrent,
    spawn: launch => {
      child = spawn(launch.command, launch.args, { cwd: options.cwd,
        env: { ...process.env, ...launch.env }, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout?.on('data', options.stdout ?? (() => {}));
      child.stderr?.on('data', options.stderr ?? (() => {}));
      pipeClosed = new Promise<void>(resolve => child!.once('close', () => resolve()));
      options.leader?.(child);
      // The protocol's PTY adapter only needs this process-lifetime subset.
      return { pid: child.pid!, kill: (signal?: string) => { child!.kill(signal as NodeJS.Signals); },
        onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
          const exit = (code: number | null) => listener({ exitCode: code ?? -1 });
          child!.once('exit', exit);
          child!.once('error', () => { if (!child!.pid) exit(-1); });
          return { dispose: () => child!.removeListener('exit', exit) };
        }
      } as unknown as IPty;
    }
  });
  const completed = owner.completed.then(async code => { await pipeClosed; return code; });
  void completed.catch(() => {});
  return { close: async () => { await owner.close(); await pipeClosed; }, completed,
    writeInput: data => owner.writeInput(data), endInput: () => owner.endInput() };
}
