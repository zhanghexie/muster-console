// @vitest-environment node
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { INTERACTIVE_PTY_BOOTSTRAP } from '../../../src/main/pty/interactiveBootstrap';

// 全局 setup.ts 的 beforeEach 会安装 window.api mock；node 环境没有 window，需显式指向 globalThis。
vi.stubGlobal('window', globalThis);

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('interactive POSIX bootstrap cancellation', () => {
  it.each(['linux', 'darwin'])('waits a late joining %s helper and never starts user code after cleanup', async platform => {
    const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; setEncoding(): void; write(data: string): void };
    const frames: Array<{ type: string }> = [];
    Object.assign(socket, { destroyed: false, setEncoding() {}, write(data: string) { frames.push(JSON.parse(data)); } });
    let helper: (EventEmitter & { pid: number; connected: boolean; exitCode: number | null; signalCode: null; send(message: any): void }) | undefined;
    let configure: any, cancelled = 0, runs = 0, joined = false;
    const koffi = { errno: () => 3, load: () => ({ func(signature: string) {
      if (signature.includes('proc_listallpids')) return (buffer: Int32Array | null) => { if (buffer) buffer[0] = 100; return 1; };
      if (signature.includes('getsid')) return () => 100;
      if (signature.includes('getpgid')) return (pid: number) => pid === 201 && joined ? 201 : 100;
      if (signature.includes('tcgetpgrp')) return () => 100;
      return () => 0;
    } }) };
    const processMock = new EventEmitter() as EventEmitter & Record<string, any>;
    Object.assign(processMock, { platform, pid: 100, execPath: 'node', env: { MUSTER_PTY_OWNER_ENDPOINT: '/private', MUSTER_PTY_OWNER_TOKEN: 'token', MUSTER_PTY_OWNER_KOFFI: 'koffi' }, stderr: { write: vi.fn() }, kill: vi.fn(), exit: vi.fn() });
    runInNewContext(INTERACTIVE_PTY_BOOTSTRAP, {
      process: processMock, setTimeout, clearTimeout, Buffer, console,
      require(name: string) {
        if (name === 'node:net') return { createConnection: () => socket };
        if (name === 'node:fs') return { readdirSync: () => ['100'] };
        if (name === 'node:os') return { constants: { errno: { ESRCH: 3 } } };
        if (name === 'node:crypto') return { randomBytes: () => ({ toString: () => 'nonce' }) };
        if (name === 'koffi') return koffi;
        if (name === 'node:child_process') return { spawn() {
          helper = Object.assign(new EventEmitter(), { pid: 201, connected: true, exitCode: null as number | null, signalCode: null,
            send(message: any) { if (message.type === 'configure') configure = message; else if (message.type === 'cancel') cancelled++; else if (message.type === 'run') runs++; } });
          queueMicrotask(() => helper!.emit('spawn')); return helper;
        } };
        throw Error(name);
      }
    });
    socket.emit('connect');
    socket.emit('data', JSON.stringify({ type: 'run', command: 'user-shell', args: [], env: {}, cwd: '/fixture' }) + '\n');
    await tick(); expect(configure.type).toBe('configure');
    socket.emit('data', JSON.stringify({ type: 'cleanup', nonce: 'close' }) + '\n');
    await tick(); expect(cancelled).toBeGreaterThan(0); expect(frames.some(frame => frame.type === 'cleaned')).toBe(false);
    joined = true;
    helper!.emit('message', { type: 'joined', pid: 201, session: 100, group: 201, nonce: configure.nonce });
    await tick(); expect(runs).toBe(0); expect(frames.some(frame => frame.type === 'cleaned')).toBe(false);
    helper!.exitCode = 0; helper!.connected = false; helper!.emit('close', 0);
    await tick(); await tick();
    expect(frames.some(frame => frame.type === 'cleaned')).toBe(true);
    expect(runs).toBe(0); expect(processMock.kill).not.toHaveBeenCalled();
  });
});
