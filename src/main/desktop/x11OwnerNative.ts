import fs from 'node:fs';
import os from 'node:os';
import koffi from 'koffi';

/** Private worker result. A local XRes PID is not, by itself, proof of a local semantic app. */
export interface X11OwnerObservation {
  nativeHandle: string;
  pid: number;
  processStart: string;
  workerPid: number;
  serverPid: number;
  serverStart: string;
  serverExecutable: string;
  namespace: string;
}
export type ProcIdentity = { pid: number; start: string; namespace: string };
type XresValue = { client: number; mask: number; values: number[] };
type NativePointer = unknown;

export function parseLinuxProcessStat(text: string, expectedPid: number): string {
  if (typeof text !== 'string' || text.length > 65536 || !Number.isSafeInteger(expectedPid) || expectedPid <= 0) throw new Error('Invalid process stat');
  const end = text.lastIndexOf(')'), open = text.indexOf('(');
  if (open < 1 || end <= open || text.slice(0, open).trim() !== String(expectedPid)) throw new Error('Invalid process stat');
  const fields = text.slice(end + 1).trim().split(/\s+/);
  // state is field 3; starttime is field 22, including a comm with spaces or ')'.
  if (fields.length < 20 || !/^[RSDTtIWKP]$/.test(fields[0] ?? '') || !/^\d{1,32}$/.test(fields[19] ?? '')) {
    throw new Error('Process is unavailable or its identity is invalid');
  }
  return fields[19]!;
}

export function selectXresOwner(values: readonly XresValue[], ownBase: number, ownPid: number, targetBase: number): number {
  const id = (v: number): boolean => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff;
  const pid = (v: number): boolean => Number.isSafeInteger(v) && v > 0 && v <= 0x7fffffff;
  if (!Array.isArray(values) || values.length > 64 || !id(ownBase) || !pid(ownPid) || !id(targetBase) || targetBase === 0) {
    throw new Error('Invalid XRes client identity');
  }
  const find = (client: number): number => {
    const matches = values.filter(v => v && v.client === client && v.mask === 2);
    if (matches.length !== 1 || !Array.isArray(matches[0]!.values) || matches[0]!.values.length !== 1 || !pid(matches[0]!.values[0]!)) {
      throw new Error('XRes did not identify exactly one local client PID');
    }
    return matches[0]!.values[0]!;
  };
  if (find(ownBase) !== ownPid) throw new Error('XRes peer is remote or in a different PID namespace');
  return find(targetBase);
}

/** Parse bounded XCB XRes reply bytes; malformed lengths/duplicates never authorize a target. */
export function parseXresReply(data: Buffer): XresValue[] {
  if (!Buffer.isBuffer(data) || data.length < 32 || data[0] !== 1) throw new Error('Invalid XRes reply');
  const extra = data.readUInt32LE(4) * 4, count = data.readUInt32LE(8);
  if (extra > 16384 || data.length !== 32 + extra || count > 64) throw new Error('Invalid XRes reply length');
  const out: XresValue[] = [];
  let pos = 32;
  for (let i = 0; i < count; i++) {
    if (pos + 12 > data.length) throw new Error('Truncated XRes client');
    const client = data.readUInt32LE(pos), mask = data.readUInt32LE(pos + 4), words = data.readUInt32LE(pos + 8);
    pos += 12;
    if (words > 4096 || pos + words * 4 > data.length) throw new Error('Invalid XRes value length');
    const values: number[] = [];
    for (let j = 0; j < words; j++) values.push(data.readUInt32LE(pos + j * 4));
    pos += words * 4;
    out.push({ client, mask, values });
  }
  if (pos !== data.length) throw new Error('Unexpected XRes reply data');
  return out;
}

function procIdentity(pid: number): ProcIdentity {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) throw new Error('Invalid local process ID');
  const start = parseLinuxProcessStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
  const ns = fs.statSync(`/proc/${pid}/ns/pid`, { bigint: true });
  return { pid, start, namespace: `${ns.dev}:${ns.ino}` };
}

function sameProcess(a: ProcIdentity, b: ProcIdentity): boolean {
  return a.pid === b.pid && a.start === b.start && a.namespace === b.namespace;
}

/** These checks are shared with simulations; inputs in the worker come only from the socket and /proc. */
export function assertX11SocketFamily(family: number): void {
  if (family !== 1) throw new Error('Remote or forwarded X11 server connections are not supported; use a local native X11 session');
}

export function assertX11ServerIdentity(self: ProcIdentity, server: ProcIdentity, executable: string): void {
  if (self.namespace !== server.namespace) throw new Error('The X11 server uses another PID namespace; use the same native session as the host');
  if (!executable.startsWith('/') || /(?:^|\/)xwayland(?:\s|$)/i.test(executable)) {
    throw new Error('XWayland is not a native X11 server; use a native X11 session');
  }
}

export function assertX11ClientIdentity(self: ProcIdentity, server: ProcIdentity, client: ProcIdentity): void {
  if (client.pid === server.pid) throw new Error('X11 server-owned windows are not valid application targets');
  if (client.namespace !== self.namespace) throw new Error('The X11 client uses another PID namespace; use a local application in the same session');
}

export function assertX11ProcessUnchanged(before: ProcIdentity, after: ProcIdentity): void {
  if (!sameProcess(before, after)) throw new Error('The X11 process or its PID namespace changed; capture the target again');
}

export function assertX11XresVersion(major: number, minor: number): void {
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 1 || major > 0xffff || minor < 0 || minor > 0xffff || (major === 1 && minor < 2)) {
    throw new Error('The X server needs XRes 1.2 or newer; enable X-Resource in the native X11 session');
  }
}

/** WM_CLIENT_MACHINE can veto a target but is never positive ownership evidence. */
export function assertX11ClientMachine(raw: string, hostname: string): void {
  const machine = raw.replace(/\0+$/, '').trim().toLowerCase(), local = hostname.trim().toLowerCase();
  if (machine && (!local || (machine !== local && machine.split('.')[0] !== local.split('.')[0]))) {
    throw new Error('The X11 client reports a remote machine; use a local application in the native X11 session');
  }
}

export function loadX11Libraries(load: typeof koffi.load = koffi.load.bind(koffi)): {
  xcb: ReturnType<typeof koffi.load>; res: ReturnType<typeof koffi.load>; libc: ReturnType<typeof koffi.load>;
} {
  // RTLD_DEFAULT resolves libc symbols from the running process on glibc and musl.
  try { return { xcb: load('libxcb.so.1'), res: load('libxcb-res.so.0'), libc: load(null) }; }
  catch { throw new Error('X11 owner probing needs libxcb and libxcb-res (install the distribution XCB and XRes runtime libraries)'); }
}

/** Preserve destroy events seen by any probe until the worker publishes them. */
export function createX11DestroyTracker() {
  const watched = new Set<string>(), dead = new Set<string>(), pending = new Set<string>();
  const assertCapacity = (id: string): void => {
    if (!watched.has(id) && watched.size >= 128) throw new Error('X11 owner watch capacity reached');
  };
  return {
    assertCapacity,
    watch(id: string): void { assertCapacity(id); watched.add(id); },
    has(id: string): boolean { return watched.has(id); },
    isDead(id: string): boolean { return dead.has(id); },
    record(id: string): void {
      if (watched.has(id) && !dead.has(id)) { dead.add(id); pending.add(id); }
    },
    take(): string[] { const result = [...pending]; pending.clear(); return result; }
  };
}

/** All XCB consumers share this queue so one probe cannot swallow another window's destroy event. */
export function createX11EventQueue(tracker: ReturnType<typeof createX11DestroyTracker>,
  next: () => { type: number; nativeHandle: string } | null, alive: () => void) {
  const drain = (): void => {
    alive();
    for (let i = 0; i < 4096; i++) {
      const event = next();
      if (!event) { alive(); return; }
      if (event.type === 0) throw new Error('An asynchronous X11 request failed');
      if ((event.type & 0x7f) === 17) tracker.record(event.nativeHandle); // DestroyNotify
    }
    throw new Error('X11 event backlog exceeded the safety limit');
  };
  return { drain, destroyed() { drain(); return tracker.take(); } };
}

export interface X11OwnerNative {
  probe(nativeHandle: string): X11OwnerObservation;
  destroyed(): string[];
  close(): void;
}

/** Runs only in the private worker: XCB replies and /proc reads may block there. */
export function openX11OwnerNative(): X11OwnerNative {
  if (process.platform !== 'linux' || os.endianness() !== 'LE') throw new Error('X11 owner probing requires a little-endian Linux host');
  const { xcb, res, libc } = loadX11Libraries();
  const cookie = koffi.struct({ sequence: 'uint32_t' });
  const connect = xcb.func('xcb_connect', 'void *', ['str', 'void *']);
  const disconnect = xcb.func('void xcb_disconnect(void *c)');
  const hasError = xcb.func('int xcb_connection_has_error(void *c)');
  const setup = xcb.func('void *xcb_get_setup(void *c)');
  const descriptor = xcb.func('int xcb_get_file_descriptor(void *c)');
  const poll = xcb.func('void *xcb_poll_for_event(void *c)');
  const attributes = xcb.func('xcb_get_window_attributes', cookie, ['void *', 'uint32_t']);
  const attributesReply = xcb.func('xcb_get_window_attributes_reply', 'void *', ['void *', cookie, 'void *']);
  const change = xcb.func('xcb_change_window_attributes_checked', cookie, ['void *', 'uint32_t', 'uint32_t', 'void *']);
  const check = xcb.func('xcb_request_check', 'void *', ['void *', cookie]);
  const property = xcb.func('xcb_get_property', cookie, ['void *', 'uint8_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t']);
  const propertyReply = xcb.func('xcb_get_property_reply', 'void *', ['void *', cookie, 'void *']);
  const version = res.func('xcb_res_query_version', cookie, ['void *', 'uint8_t', 'uint8_t']);
  const versionReply = res.func('xcb_res_query_version_reply', 'void *', ['void *', cookie, 'void *']);
  const query = res.func('xcb_res_query_client_ids', cookie, ['void *', 'uint32_t', 'void *']);
  const queryReply = res.func('xcb_res_query_client_ids_reply', 'void *', ['void *', cookie, 'void *']);
  const free = libc.func('void free(void *p)');
  const getpeername = libc.func('int getpeername(int fd, void *addr, void *len)');
  const getsockopt = libc.func('int getsockopt(int fd, int level, int optname, void *value, void *len)');
  const c: NativePointer = connect(null, null);
  if (!c || hasError(c)) { if (c) disconnect(c); throw new Error('Cannot connect to the X11 display; check DISPLAY and Xauthority'); }
  let closed = false;
  const tracker = createX11DestroyTracker();
  const bytes = (p: NativePointer, size: number): Buffer => Buffer.from(new Uint8Array(koffi.view(p, size)));
  const readReply = (p: NativePointer, limit: number): Buffer => {
    if (!p) throw new Error('The X11 server rejected the request or disconnected');
    try {
      const head = bytes(p, 32), extra = head.readUInt32LE(4) * 4;
      if (head[0] !== 1) throw new Error('Invalid X11 server reply');
      if (extra > limit) throw new Error('X11 server reply exceeded its limit');
      return bytes(p, 32 + extra);
    } finally { free(p); }
  };
  const alive = (): void => { if (closed || hasError(c)) throw new Error('The X11 connection was lost'); };
  try {
    const fd = descriptor(c), addr = Buffer.alloc(128), addrLen = Buffer.alloc(4);
    addrLen.writeUInt32LE(addr.length);
    if (fd < 0 || getpeername(fd, addr, addrLen) !== 0 || addrLen.readUInt32LE() < 2) throw new Error('Cannot inspect the X11 display connection; check DISPLAY and Xauthority');
    assertX11SocketFamily(addr.readUInt16LE(0));
    const credentials = Buffer.alloc(12), credentialLen = Buffer.alloc(4); credentialLen.writeUInt32LE(credentials.length);
    if (getsockopt(fd, 1, 17, credentials, credentialLen) !== 0 || credentialLen.readUInt32LE() !== 12) throw new Error('Cannot verify local X11 server credentials');
    const serverPid = credentials.readInt32LE(0), self = procIdentity(process.pid), server = procIdentity(serverPid);
    const serverExecutable = fs.readlinkSync(`/proc/${serverPid}/exe`);
    assertX11ServerIdentity(self, server, serverExecutable);
    const initial = bytes(setup(c), 20), ownBase = initial.readUInt32LE(12), mask = initial.readUInt32LE(16);
    if (!ownBase || !mask) throw new Error('Invalid X11 connection identity');
    const v = readReply(versionReply(c, version(c, 1, 2), null), 0);
    assertX11XresVersion(v.readUInt16LE(8), v.readUInt16LE(10));
    const assertServer = (): void => {
      alive();
      assertX11ProcessUnchanged(self, procIdentity(process.pid));
      assertX11ProcessUnchanged(server, procIdentity(serverPid));
      if (fs.readlinkSync(`/proc/${serverPid}/exe`) !== serverExecutable) throw new Error('The X11 server executable changed; capture the target again');
    };
    const exists = (id: number): void => {
      const result = readReply(attributesReply(c, attributes(c, id), null), 64);
      if (result[0] !== 1) throw new Error('X11 window is unavailable');
    };
    const isLocalMachine = (id: number): void => {
      const reply = readReply(propertyReply(c, property(c, 0, id, 36, 0, 0, 256), null), 1024);
      const format = reply[1], type = reply.readUInt32LE(8), after = reply.readUInt32LE(12), length = reply.readUInt32LE(16);
      if (type === 0 && format === 0 && length === 0) return;
      if (type !== 31 || format !== 8 || after !== 0 || length > 1024 || 32 + length > reply.length) throw new Error('Invalid X11 client machine property');
      assertX11ClientMachine(reply.subarray(32, 32 + length).toString('utf8'), os.hostname());
    };
    const events = createX11EventQueue(tracker, () => {
      const event = poll(c);
      if (!event) return null;
      try { const data = bytes(event, 32); return { type: data[0]!, nativeHandle: `0x${data.readUInt32LE(8).toString(16)}` }; }
      finally { free(event); }
    }, alive);
    return {
      probe(nativeHandle) {
        const match = typeof nativeHandle === 'string' && /^0x[0-9a-f]{1,8}$/i.test(nativeHandle);
        if (!match) throw new Error('Invalid X11 window ID');
        const id = Number.parseInt(nativeHandle.slice(2), 16), canonical = `0x${id.toString(16)}`;
        if (!id || tracker.isDead(canonical)) throw new Error('X11 window was destroyed');
        assertServer(); events.drain();
        if (tracker.isDead(canonical)) throw new Error('X11 window was destroyed');
        if (!tracker.has(canonical)) {
          tracker.assertCapacity(canonical);
          const events = Buffer.alloc(4); events.writeUInt32LE(1 << 17); // StructureNotify
          const failure = check(c, change(c, id, 1 << 11, events)); // CWEventMask, per connection
          if (failure) { free(failure); throw new Error('Cannot observe X11 window destruction'); }
          tracker.watch(canonical);
        }
        exists(id); isLocalMachine(id);
        const targetBase = (id & ~mask) >>> 0;
        const specs = Buffer.alloc(targetBase === ownBase ? 8 : 16);
        specs.writeUInt32LE(ownBase, 0); specs.writeUInt32LE(2, 4);
        if (targetBase !== ownBase) { specs.writeUInt32LE(id, 8); specs.writeUInt32LE(2, 12); }
        const values = parseXresReply(readReply(queryReply(c, query(c, specs.length / 8, specs), null), 16384));
        const pid = selectXresOwner(values, ownBase, process.pid, targetBase);
        const owner = procIdentity(pid);
        assertX11ClientIdentity(self, server, owner);
        exists(id); assertServer();
        assertX11ProcessUnchanged(owner, procIdentity(pid));
        events.drain();
        if (tracker.isDead(canonical)) throw new Error('X11 window was destroyed');
        return Object.freeze({ nativeHandle: canonical, pid, processStart: owner.start, workerPid: process.pid, serverPid,
          serverStart: server.start, serverExecutable, namespace: owner.namespace });
      },
      destroyed: events.destroyed,
      close() { if (!closed) { closed = true; disconnect(c); } }
    };
  } catch (error) { disconnect(c); throw error; }
}
