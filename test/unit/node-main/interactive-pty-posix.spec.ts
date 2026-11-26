// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createPosixPtyNative, reclaimPosixPtySession, signalPinnedPosixGroup } from '../../../src/main/pty/interactivePosix';
vi.stubGlobal('window', globalThis);

describe('interactive PTY POSIX session ownership', () => {
  it.each(['linux', 'darwin'])('enumerates %s PIDs with native SID filtering and preserves foreground ownership', platform => {
    let errno = 0, foreground = 100, setCalls = 0;
    const loaded: Array<string | null> = [];
    const functions: Record<string, (...args: any[]) => number> = {
      getsid: pid => pid === 333 ? 900 : 100, getpgid: pid => pid === 101 ? 201 : pid === 333 ? 900 : 100,
      setpgid: () => 0, tcgetpgrp: () => foreground, tcsetpgrp: (_fd, group) => { foreground = group; setCalls++; return 0; },
      proc_listallpids: (buffer: Int32Array | null) => { if (buffer) buffer.set([100, 101, 333]); return 3; }
    };
    const koffi = { errno(value?: number) { if (value !== undefined) errno = value; return errno; }, load(file: string | null) { loaded.push(file); return { func(signature: string) { return functions[/int (\w+)/.exec(signature)![1]]; } }; } };
    const native = createPosixPtyNative(koffi, platform, () => ['100', '101', '333', 'self'], 3);
    native.assertLeader(100); expect(native.groups(100)).toEqual([100, 201]);
    native.foreground(100, 201); expect(setCalls).toBe(1);
    expect(() => native.foreground(100, 202)).toThrow('foreground ownership'); expect(setCalls).toBe(1);
    expect(loaded.includes('/usr/lib/libproc.dylib')).toBe(platform === 'darwin');
    functions.getsid = () => -1; errno = 1;
    // Recreate because func() returns the selected native binding.
    expect(() => createPosixPtyNative(koffi, platform, () => ['100'], 3).groups(100)).toThrow('errno 1');
  });

  it('pins every job-control group, rescans new groups and never signals an outside-session reuse', async () => {
    const groups = new Set([100, 201, 202]), killed: number[] = [];
    await reclaimPosixPtySession({ leader: 100, timeoutMs: 1000, assertLeader() {}, groups: () => [...groups],
      async pin(group) {
        if (group === 202) { groups.delete(group); return null; }
        return { session: 100, group, async signalAndWait() { killed.push(group); groups.delete(group); if (group === 201) groups.add(203); } };
      }
    });
    expect(killed).toEqual([201, 203]);
  });

  it('fails closed when the held leader dies or a pin belongs to another SID', async () => {
    let signals = 0;
    await expect(reclaimPosixPtySession({ leader: 100, timeoutMs: 100, assertLeader() { throw new Error('leader died'); }, groups: () => [100, 201], async pin() { signals++; return null; } })).rejects.toThrow('leader died');
    await expect(reclaimPosixPtySession({ leader: 100, timeoutMs: 100, assertLeader() {}, groups: () => [100, 201], async pin(group) { return { session: 999, group, async signalAndWait() { signals++; } }; } })).rejects.toThrow('different session');
    expect(signals).toBe(0);
  });

  it('cannot signal a lost pin and waits actual guard closure after its single signal', async () => {
    let signals = 0, resolve!: () => void, done = false;
    const options = { lease: { signalled: false }, leader: 100, group: 201, guardPid: 301, assertLeader() {}, alive: () => false,
      sessionId: () => 100, groupId: () => 201, signal() { signals++; }, waitClosed: () => new Promise<void>(r => { resolve = r; }) };
    await expect(signalPinnedPosixGroup(options)).rejects.toThrow('pin was lost'); expect(signals).toBe(0);
    options.lease = { signalled: false }; options.alive = () => true;
    const close = signalPinnedPosixGroup(options).then(() => { done = true; });
    expect(signals).toBe(1); await Promise.resolve(); expect(done).toBe(false); resolve(); await close;
    await expect(signalPinnedPosixGroup(options)).rejects.toThrow('fresh pin'); expect(signals).toBe(1);
  });

  it('reports continuously created groups and enumeration errors instead of a success timeout', async () => {
    let now = 0;
    await expect(reclaimPosixPtySession({ leader: 100, timeoutMs: 3, now: () => now++, assertLeader() {}, groups: () => [100, 201], async pin(group) { return { session: 100, group, async signalAndWait() {} }; } })).rejects.toThrow(/kept creating|deadline/);
    await expect(reclaimPosixPtySession({ leader: 100, timeoutMs: 3, assertLeader() {}, groups() { throw new Error('enumeration denied'); }, async pin() { return null; } })).rejects.toThrow('enumeration denied');
  });
});
