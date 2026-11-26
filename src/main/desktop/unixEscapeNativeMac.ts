import koffi from 'koffi';
import type { UnixEscapeNative } from './unixEscapeTypes';

/** Injectable boundary for exercising the same lifecycle without a Mac. */
export interface MacEscapeBackend {
  permission(): boolean;
  secureInput(): boolean;
  start(event: (type: number, key: number, repeated: boolean) => void): void;
  enabled(): boolean;
  poll(): void;
  close(): void;
}

export function loadMacEscapeLibraries(load: typeof koffi.load = koffi.load.bind(koffi)): {
  cg: ReturnType<typeof koffi.load>; cf: ReturnType<typeof koffi.load>; hi: ReturnType<typeof koffi.load>;
} {
  try {
    return { cg: load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'),
      cf: load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'),
      hi: load('/System/Library/Frameworks/Carbon.framework/Versions/A/Frameworks/HIToolbox.framework/Versions/A/HIToolbox') };
  } catch { throw new Error('macOS Escape listener frameworks are unavailable; use the visible Stop button'); }
}

export function createMacEscapeNative(backend: MacEscapeBackend): UnixEscapeNative {
  let closed = false, pressed = false, failure: string | undefined;
  const check = (): void => {
    if (closed) throw new Error('macOS Escape listener is closed');
    if (failure) throw new Error(failure);
    if (backend.secureInput()) throw new Error('macOS Secure Input prevents global Escape monitoring; use the visible Stop button');
    if (!backend.enabled()) throw new Error('macOS Escape event tap is disabled; check Input Monitoring and use the visible Stop button');
  };
  try {
    if (!backend.permission()) throw new Error('Grant Input Monitoring to the process running the desktop listener in System Settings, then restart it');
    if (backend.secureInput()) throw new Error('macOS Secure Input prevents global Escape monitoring; use the visible Stop button');
    backend.start((type, key) => {
      if (type === 0xfffffffe || type === 0xffffffff) failure = 'macOS Escape event tap was disabled; use the visible Stop button';
      else if (type === 10 && key === 53) pressed = true; // A key held before startup may only produce repeats.
    });
    check();
  } catch (error) {
    try { backend.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'macOS Escape listener startup failed and cleanup is unconfirmed'); }
    throw error;
  }
  return {
    poll() { check(); backend.poll(); check(); const result = pressed; pressed = false; return result; },
    close() { if (!closed) { closed = true; backend.close(); } }
  };
}

/** Must run in the helper process: CFRunLoopRunInMode synchronously pumps its event tap. */
export function openMacEscapeNative(): UnixEscapeNative {
  if (process.platform !== 'darwin') throw new Error('The macOS Escape listener requires macOS');
  const { cg, cf, hi } = loadMacEscapeLibraries();
  const cbType = koffi.pointer(koffi.proto('void *', ['void *', 'uint32_t', 'void *', 'void *']));
  const preflight = cg.func('bool CGPreflightListenEventAccess(void)');
  const secureInput = hi.func('uint8_t IsSecureEventInputEnabled(void)');
  const tapCreate = cg.func('CGEventTapCreate', 'void *', ['uint32_t', 'uint32_t', 'uint32_t', 'uint64_t', cbType, 'void *']);
  const tapEnabled = cg.func('bool CGEventTapIsEnabled(void *tap)');
  const tapEnable = cg.func('void CGEventTapEnable(void *tap, bool enabled)');
  const eventField = cg.func('int64_t CGEventGetIntegerValueField(void *event, uint32_t field)');
  const makeSource = cf.func('void *CFMachPortCreateRunLoopSource(void *allocator, void *port, long order)');
  const invalidate = cf.func('void CFMachPortInvalidate(void *port)');
  const makeMode = cf.func('void *CFStringCreateWithCString(void *allocator, str value, uint32_t encoding)');
  const currentLoop = cf.func('void *CFRunLoopGetCurrent(void)');
  const addSource = cf.func('void CFRunLoopAddSource(void *loop, void *source, void *mode)');
  const removeSource = cf.func('void CFRunLoopRemoveSource(void *loop, void *source, void *mode)');
  const run = cf.func('int CFRunLoopRunInMode(void *mode, double seconds, bool returnAfterSourceHandled)');
  const release = cf.func('void CFRelease(void *value)');
  let cb: bigint | undefined, tap: unknown, source: unknown, mode: unknown, loop: unknown, added = false;
  const backend: MacEscapeBackend = {
    permission: () => preflight() === true,
    secureInput: () => secureInput() !== 0,
    start(deliver) {
      cb = koffi.register((_proxy: unknown, type: number, event: unknown) => {
        try {
          if (type === 0xfffffffe || type === 0xffffffff) deliver(type, 0, false);
          else if (type === 10 && event && Number(eventField(event, 9)) === 53) deliver(type, 53, false);
        } catch { deliver(0xffffffff, 0, false); }
        return event;
      }, cbType);
      tap = tapCreate(1, 0, 1, 1n << 10n, cb, null); // session-level, passive, key down only
      if (!tap) throw new Error('Could not create macOS Escape event tap; check Input Monitoring for the listener process');
      source = makeSource(null, tap, 0);
      mode = makeMode(null, 'kCFRunLoopDefaultMode', 0x08000100);
      loop = currentLoop();
      if (!source || !mode || !loop) throw new Error('Could not create the macOS Escape listener run loop');
      addSource(loop, source, mode); added = true;
    },
    enabled: () => !!tap && tapEnabled(tap) === true,
    poll() {
      const result = run(mode, 0.025, true);
      if (result !== 3 && result !== 4) throw new Error('macOS Escape listener run loop stopped');
    },
    close() {
      const failures: unknown[] = [];
      const attempt = (operation: () => void): void => { try { operation(); } catch (error) { failures.push(error); } };
      if (tap) attempt(() => tapEnable(tap, false));
      if (added) attempt(() => removeSource(loop, source, mode));
      if (tap) attempt(() => invalidate(tap));
      if (source) attempt(() => release(source));
      if (mode) attempt(() => release(mode));
      if (tap) attempt(() => release(tap));
      if (cb !== undefined) attempt(() => koffi.unregister(cb!));
      cb = undefined; tap = undefined; source = undefined; mode = undefined; loop = undefined; added = false;
      if (failures.length) throw new AggregateError(failures, 'macOS Escape event tap cleanup failed');
    }
  };
  return createMacEscapeNative(backend);
}
