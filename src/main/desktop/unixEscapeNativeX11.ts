import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import koffi from 'koffi';
import type { UnixEscapeNative, X11EscapePeer } from './unixEscapeTypes';

export function loadX11EscapeLibraries(load: typeof koffi.load = koffi.load.bind(koffi)): {
  xcb: ReturnType<typeof koffi.load>; input: ReturnType<typeof koffi.load>; libc: ReturnType<typeof koffi.load>;
} {
  try { return { xcb: load('libxcb.so.1'), input: load('libxcb-xinput.so.0'), libc: load(null) }; }
  catch { throw new Error('Install the XCB and XCB XInput runtime libraries, then restart the X11 listener'); }
}

export function assertX11InputVersion(major: number, minor: number): void {
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 0 || major > 0xffff || minor < 0 || minor > 0xffff ||
      major < 2 || (major === 2 && minor < 1)) throw new Error('XInput 2.1 or newer is required for Escape monitoring; update the X11 server');
}

export function x11EscapeProcessStart(pid: number, stat: string): string {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff || typeof stat !== 'string' || stat.length > 65536) throw new Error('Invalid X11 peer process');
  const open = stat.indexOf('('), end = stat.lastIndexOf(')');
  if (open < 1 || end <= open || stat.slice(0, open).trim() !== String(pid)) throw new Error('Invalid X11 peer process');
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^[RSDTtIWKP]$/.test(fields[0] ?? '') || !/^\d{1,32}$/.test(fields[19] ?? '')) {
    throw new Error('The X11 peer process is unavailable');
  }
  return fields[19]!;
}

function processIdentity(pid: number): { start: string; namespace: string } {
  try {
    const start = x11EscapeProcessStart(pid, fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const ns = fs.statSync(`/proc/${pid}/ns/pid`, { bigint: true });
    return { start, namespace: `${ns.dev}:${ns.ino}` };
  } catch { throw new Error('Cannot verify the X11 server process and PID namespace; check /proc access and the graphical session'); }
}

export function assertX11EscapeProcSelf(worker: { start: string; namespace: string }, actual: { start: string; namespace: string }): void {
  if (worker.start !== actual.start || worker.namespace !== actual.namespace) {
    throw new Error('The /proc mount does not identify the listener in its PID namespace; use a matching native session');
  }
}

function selfIdentity(pid: number): { start: string; namespace: string } {
  try {
    const start = x11EscapeProcessStart(pid, fs.readFileSync('/proc/self/stat', 'utf8'));
    const ns = fs.statSync('/proc/self/ns/pid', { bigint: true });
    return { start, namespace: `${ns.dev}:${ns.ino}` };
  } catch { throw new Error('Cannot verify /proc/self in the listener PID namespace; use a matching native session'); }
}

export function x11EscapePeer(family: number, workerPid: number, serverPid: number,
  worker: { start: string; namespace: string }, server: { start: string; namespace: string }, executable: string): Readonly<X11EscapePeer> {
  if (family !== 1) throw new Error('Remote or forwarded X11 connections cannot provide Escape monitoring; use a local native X11 session');
  if (!Number.isSafeInteger(workerPid) || !Number.isSafeInteger(serverPid) || workerPid < 1 || serverPid < 1 || serverPid > 0x7fffffff || serverPid === workerPid) {
    throw new Error('Invalid X11 server credentials');
  }
  if (worker.namespace !== server.namespace) throw new Error('The X11 server uses another PID namespace; use a local native X11 session');
  if (!executable.startsWith('/') || /(?:^|\/)xwayland(?:\s|$)/i.test(executable)) {
    throw new Error('XWayland is not a native X11 session; use the visible Stop button');
  }
  return Object.freeze({ workerPid, workerStart: worker.start, serverPid, serverStart: server.start, namespace: server.namespace, serverExecutable: executable });
}

export function assertX11EscapePeerCurrent(peer: Readonly<X11EscapePeer>, worker: { start: string; namespace: string },
  server: { start: string; namespace: string }, executable: string): void {
  if (worker.start !== peer.workerStart || server.start !== peer.serverStart || worker.namespace !== peer.namespace ||
      server.namespace !== peer.namespace || executable !== peer.serverExecutable) {
    throw new Error('The X11 server or its PID namespace changed; restart the listener');
  }
}

/** Parse the core keyboard map without exposing non-Escape key names. */
export function x11EscapeKeycodes(first: number, last: number, reply: Buffer): Set<number> {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 8 || last > 255 || first > last ||
      !Buffer.isBuffer(reply) || reply.length < 32 || reply[0] !== 1) throw new Error('Invalid X11 keyboard map');
  const each = reply[1]!, words = reply.readUInt32LE(4), count = last - first + 1;
  if (!each || words !== each * count || reply.length !== 32 + words * 4) throw new Error('Invalid X11 keyboard map length');
  const result = new Set<number>();
  for (let code = first; code <= last; code++) {
    for (let i = 0; i < each; i++) if (reply.readUInt32LE(32 + ((code - first) * each + i) * 4) === 0xff1b) result.add(code);
  }
  if (!result.size) throw new Error('The X11 keyboard has no Escape mapping; use the visible Stop button');
  return result;
}

export function x11EscapeEvent(event: Buffer, opcode: number, keys: ReadonlySet<number>): 'escape' | 'mapping' | 'ignore' {
  if (!Buffer.isBuffer(event) || event.length < 32) throw new Error('Invalid X11 input event');
  const type = event[0]! & 0x7f;
  if (event[0] === 0) throw new Error('The X11 input listener received a protocol error');
  if (type === 34) return 'mapping';
  return type === 35 && event[1] === opcode && event.readUInt16LE(8) === 13 && keys.has(event.readUInt32LE(16))
    ? 'escape' : 'ignore';
}

export interface X11EscapeBackend {
  readonly opcode: number;
  readonly peer?: Readonly<X11EscapePeer>;
  mapping(): Set<number>;
  next(): Buffer | null;
  assertConnected(): void;
  sync(): void;
  close(): void;
}

/** The synchronous X server round trip is confined to the supervised helper. */
export function createX11EscapeNative(backend: X11EscapeBackend, now: () => number = () => performance.now()): UnixEscapeNative {
  let keys = backend.mapping(), lastSync = now(), closed = false;
  return {
    ...(backend.peer ? { peer: backend.peer } : {}),
    poll() {
      if (closed) throw new Error('The X11 Escape listener is closed');
      backend.assertConnected();
      const instant = now();
      if (!Number.isFinite(instant) || instant < lastSync) throw new Error('The X11 Escape listener clock is invalid');
      if (instant - lastSync >= 500) { backend.sync(); lastSync = now(); }
      let escaped = false;
      for (let i = 0; i < 4096; i++) {
        const event = backend.next();
        if (!event) { backend.assertConnected(); return escaped; }
        const action = x11EscapeEvent(event, backend.opcode, keys);
        if (action === 'mapping') keys = backend.mapping();
        else if (action === 'escape') escaped = true;
      }
      throw new Error('X11 Escape listener event backlog exceeded its limit');
    },
    close() { if (!closed) { closed = true; backend.close(); } }
  };
}

/** Must run in the helper process, never in Electron's main process. */
export function openX11EscapeNative(): UnixEscapeNative {
  if (process.platform !== 'linux' || os.endianness() !== 'LE') throw new Error('The X11 Escape listener requires little-endian Linux');
  const { xcb, input, libc } = loadX11EscapeLibraries();
  const cookie = koffi.struct({ sequence: 'uint32_t' });
  const iter = koffi.struct({ data: 'void *', rem: 'int', index: 'int' });
  const connect = xcb.func('xcb_connect', 'void *', ['str', 'void *']);
  const disconnect = xcb.func('void xcb_disconnect(void *connection)');
  const hasError = xcb.func('int xcb_connection_has_error(void *connection)');
  const setup = xcb.func('void *xcb_get_setup(void *connection)');
  const descriptor = xcb.func('int xcb_get_file_descriptor(void *connection)');
  const roots = xcb.func('xcb_setup_roots_iterator', iter, ['void *']);
  const poll = xcb.func('void *xcb_poll_for_event(void *connection)');
  const check = xcb.func('xcb_request_check', 'void *', ['void *', cookie]);
  const ext = xcb.func('xcb_query_extension', cookie, ['void *', 'uint16_t', 'str']);
  const extReply = xcb.func('xcb_query_extension_reply', 'void *', ['void *', cookie, 'void *']);
  const map = xcb.func('xcb_get_keyboard_mapping', cookie, ['void *', 'uint8_t', 'uint8_t']);
  const mapReply = xcb.func('xcb_get_keyboard_mapping_reply', 'void *', ['void *', cookie, 'void *']);
  const focus = xcb.func('xcb_get_input_focus', cookie, ['void *']);
  const focusReply = xcb.func('xcb_get_input_focus_reply', 'void *', ['void *', cookie, 'void *']);
  const xiVersion = input.func('xcb_input_xi_query_version', cookie, ['void *', 'uint16_t', 'uint16_t']);
  const xiVersionReply = input.func('xcb_input_xi_query_version_reply', 'void *', ['void *', cookie, 'void *']);
  const select = input.func('xcb_input_xi_select_events_checked', cookie, ['void *', 'uint32_t', 'uint16_t', 'void *']);
  const free = libc.func('void free(void *value)');
  const getpeername = libc.func('int getpeername(int fd, void *addr, void *len)');
  const getsockopt = libc.func('int getsockopt(int fd, int level, int optname, void *value, void *len)');
  const c: unknown = connect(null, null);
  if (!c || hasError(c)) { if (c) disconnect(c); throw new Error('Cannot connect to the X11 DISPLAY; check Xauthority and the graphical session'); }
  let closed = false;
  const alive = (): void => { if (closed || hasError(c)) throw new Error('The X11 Escape listener disconnected; use the visible Stop button'); };
  const bytes = (p: unknown, size: number): Buffer => Buffer.from(new Uint8Array(koffi.view(p, size)));
  const readReply = (p: unknown, maxExtra: number): Buffer => {
    if (!p) throw new Error('The X11 server rejected the input listener request');
    try {
      const head = bytes(p, 32), extra = head.readUInt32LE(4) * 4;
      if (head[0] !== 1 || extra > maxExtra) throw new Error('Invalid X11 input listener response');
      return bytes(p, 32 + extra);
    } finally { free(p); }
  };
  try {
    const fd = descriptor(c), addr = Buffer.alloc(128), addrLen = Buffer.alloc(4); addrLen.writeUInt32LE(addr.length);
    if (fd < 0 || getpeername(fd, addr, addrLen) !== 0 || addrLen.readUInt32LE() < 2 || addr.readUInt16LE(0) !== 1) {
      throw new Error('Remote or forwarded X11 connections cannot provide Escape monitoring; use a local native X11 session');
    }
    const creds = Buffer.alloc(12), credsLen = Buffer.alloc(4); credsLen.writeUInt32LE(creds.length);
    if (getsockopt(fd, 1, 17, creds, credsLen) !== 0 || credsLen.readUInt32LE() !== 12) throw new Error('Cannot verify local X11 server credentials');
    const serverPid = creds.readInt32LE(), workerPid = process.pid;
    if (serverPid < 1 || serverPid === workerPid) throw new Error('Invalid X11 server credentials');
    const worker = processIdentity(workerPid), server = processIdentity(serverPid);
    assertX11EscapeProcSelf(worker, selfIdentity(workerPid));
    const serverExecutable = fs.readlinkSync(`/proc/${serverPid}/exe`);
    const peer = x11EscapePeer(addr.readUInt16LE(0), workerPid, serverPid, worker, server, serverExecutable);
    const verifyPeer = (): void => {
      const currentWorker = processIdentity(workerPid), currentServer = processIdentity(serverPid);
      assertX11EscapeProcSelf(currentWorker, selfIdentity(workerPid));
      assertX11EscapePeerCurrent(peer, currentWorker, currentServer, fs.readlinkSync(`/proc/${serverPid}/exe`));
    };
    const setupPtr = setup(c), info = bytes(setupPtr, 40), first = info[34]!, last = info[35]!;
    const screens = roots(setupPtr) as { data: unknown; rem: number };
    if (!screens.data || screens.rem < 1 || first < 8 || last < first) throw new Error('Invalid X11 display or keyboard');
    const root = bytes(screens.data, 4).readUInt32LE();
    const extension = readReply(extReply(c, ext(c, 15, 'XInputExtension'), null), 0);
    if (extension[8] !== 1 || !extension[9]) throw new Error('The X11 server lacks XInput; use the visible Stop button');
    const opcode = extension[9]!;
    const version = readReply(xiVersionReply(c, xiVersion(c, 2, 1), null), 0);
    assertX11InputVersion(version.readUInt16LE(8), version.readUInt16LE(10));
    const mapping = (): Set<number> => x11EscapeKeycodes(first, last, readReply(mapReply(c, map(c, first, last - first + 1), null), 262144));
    const mask = Buffer.alloc(8); mask.writeUInt16LE(1, 0); mask.writeUInt16LE(1, 2); mask.writeUInt32LE(1 << 13, 4);
    const failure = check(c, select(c, root, 1, mask)); // XIAllMasterDevices, RawKeyPress on a root
    if (failure) { free(failure); throw new Error('Could not select X11 raw keyboard events; check XInput permissions'); }
    alive();
    const native = createX11EscapeNative({
      opcode, peer, mapping, assertConnected: alive,
      sync() { verifyPeer(); readReply(focusReply(c, focus(c), null), 0); verifyPeer(); },
      next() {
          const ptr = poll(c);
          if (!ptr) return null;
          try { return bytes(ptr, 32); } finally { free(ptr); }
      },
      close() { if (!closed) { closed = true; disconnect(c); } }
    });
    verifyPeer();
    return native;
  } catch (error) { disconnect(c); throw error; }
}
