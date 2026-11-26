/** Functions in this file are self-contained so the controlled PTY bootstrap can embed them. */
export function createPosixPtyNative(
  koffi: { load(file: string | null): { func(signature: string): (...args: any[]) => number }; errno(value?: number): number },
  platform: string,
  readDirectory: (directory: string) => string[],
  goneErrno: number
) {
  if (platform !== 'linux' && platform !== 'darwin') throw new Error(`Interactive PTY ownership is unavailable on ${platform}`);
  const libc = koffi.load(null);
  const getsid = libc.func('int getsid(int pid)'), getpgid = libc.func('int getpgid(int pid)');
  const setpgid = libc.func('int setpgid(int pid, int pgid)');
  const tcgetpgrp = libc.func('int tcgetpgrp(int fd)'), tcsetpgrp = libc.func('int tcsetpgrp(int fd, int pgid)');
  const query = (fn: (pid: number) => number, pid: number, operation: string): number | undefined => {
    const result = fn(pid);
    if (result >= 0) return result;
    const code = koffi.errno();
    if (code === goneErrno) return undefined;
    throw new Error(`${operation}(${pid}) failed (errno ${code})`);
  };
  const listPids = platform === 'linux' ? () => readDirectory('/proc').filter(name => /^[1-9][0-9]*$/.test(name)).map(Number) : (() => {
    const list = koffi.load('/usr/lib/libproc.dylib').func('int proc_listallpids(void *buffer, int buffersize)');
    return () => {
      koffi.errno(0);
      let capacity = list(null, 0) + 128;
      if (capacity <= 128) throw new Error(`proc_listallpids sizing failed (errno ${koffi.errno()})`);
      for (let attempt = 0; attempt < 8 && capacity <= 1_000_000; attempt++, capacity *= 2) {
        const buffer = new Int32Array(capacity), count = list(buffer, buffer.byteLength);
        if (count <= 0) throw new Error(`proc_listallpids failed (errno ${koffi.errno()})`);
        if (count < capacity) return Array.from(buffer.subarray(0, count)).filter(pid => pid > 0);
      }
      throw new Error('Process enumeration changed continuously; PTY closure is unconfirmed');
    };
  })();
  const sessionId = (pid: number) => query(getsid, pid, 'getsid');
  const groupId = (pid: number) => query(getpgid, pid, 'getpgid');
  return {
    sessionId, groupId,
    joinGroup(group: number): number { if (setpgid(0, group) !== 0) return koffi.errno(); return 0; },
    assertLeader(pid: number): void {
      if (sessionId(0) !== pid || groupId(0) !== pid) throw new Error('PTY bootstrap is not its held session/group leader');
    },
    foreground(leader: number, group: number): void {
      // This is executed once, before user code, while the leader still owns
      // the foreground terminal. Never tcsetpgrp from a background group.
      if (tcgetpgrp(0) !== leader) throw new Error('PTY foreground ownership changed before shell startup');
      if (tcsetpgrp(0, group) !== 0) throw new Error(`tcsetpgrp failed (errno ${koffi.errno()})`);
    },
    groups(leader: number): number[] {
      if (sessionId(0) !== leader) throw new Error('PTY session identity changed');
      const groups = new Set<number>();
      for (const pid of listPids()) {
        if (sessionId(pid) !== leader) continue;
        const group = groupId(pid);
        if (group !== undefined && group > 0) groups.add(group);
      }
      if (!groups.has(leader)) throw new Error('Held PTY leader is missing from process enumeration');
      return [...groups];
    }
  };
}

export async function reclaimPosixPtySession(options: {
  leader: number;
  assertLeader(): void;
  groups(): number[];
  pin(group: number): Promise<{ session: number; group: number; signalAndWait(): Promise<void> } | null>;
  timeoutMs: number;
  now?: () => number;
}): Promise<void> {
  const now = options.now ?? Date.now, deadline = now() + options.timeoutMs;
  for (;;) {
    options.assertLeader();
    const groups = [...new Set(options.groups())].filter(group => group !== options.leader);
    if (!groups.length) return;
    if (now() >= deadline) throw new Error('PTY session kept creating process groups; closure is unconfirmed');
    for (const group of groups) {
      if (!Number.isInteger(group) || group <= 0) throw new Error('Invalid PTY process group');
      const pin = await options.pin(group);
      if (!pin) continue; // Vanished/reused outside this held session: never signal it.
      if (pin.session !== options.leader || pin.group !== group) throw new Error('PTY group pin belongs to a different session');
      options.assertLeader();
      await pin.signalAndWait(); // One signal while its authenticated guard pins the group.
      if (now() >= deadline) throw new Error('PTY session cleanup exceeded its deadline');
    }
  }
}
/** The held guard reserves this numeric PGID until the one signal is issued. */
export async function signalPinnedPosixGroup(options: {
  lease: { signalled: boolean };
  leader: number;
  group: number;
  guardPid: number;
  assertLeader(): void;
  alive(): boolean;
  sessionId(pid: number): number | undefined;
  groupId(pid: number): number | undefined;
  signal(group: number): void;
  waitClosed(): Promise<void>;
}): Promise<void> {
  if (options.lease.signalled) throw new Error('PTY group signal requires a fresh pin');
  options.lease.signalled = true;
  options.assertLeader();
  if (!options.alive() || options.sessionId(options.guardPid) !== options.leader || options.groupId(options.guardPid) !== options.group) throw new Error('PTY group pin was lost');
  // Deliberately no await between the live membership checks and this signal.
  options.signal(options.group);
  await options.waitClosed();
}
