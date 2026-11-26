import koffi from 'koffi';

/** Read-only observations. An HWND and PID do not prove a window incarnation. */
export interface Win32WindowObservation {
  nativeHandle: string;
  title: string;
  titleTruncated: boolean;
  pid: number;
  processImage: string | null;
  processCreated: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  dpi: number | null;
  coordinateSpace: 'win32-screen-caller-dpi';
  limitations: string[];
}
export interface Win32InventoryResult {
  windows: Win32WindowObservation[];
  complete: boolean;
  omitted: number;
  limitations: string[];
}

type NativeFn = (...args: any[]) => any;
export interface Win32InventoryApi {
  enumerate: NativeFn; visible: NativeFn; valid: NativeFn; minimized: NativeFn; titleLength: NativeFn; title: NativeFn;
  rect: NativeFn; windowPid: NativeFn; dpi: NativeFn | null;
  openProcess: NativeFn; closeHandle: NativeFn; image: NativeFn; times: NativeFn;
}
let api: Win32InventoryApi | undefined;
function nativeApi(): Win32InventoryApi {
  if (api) return api;
  try {
    const user = koffi.load('user32.dll'), kernel = koffi.load('kernel32.dll');
    const rect = koffi.struct('DesktopInventoryRect', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const fileTime = koffi.struct('DesktopInventoryFileTime', { low: 'uint32', high: 'uint32' });
    const callback = koffi.proto('int __stdcall DesktopInventoryEnumProc(void *hwnd, intptr_t param)');
    let dpi: NativeFn | null = null;
    try { dpi = user.func('__stdcall', 'GetDpiForWindow', 'uint32', ['void *']); } catch { /* Old Windows: report DPI unavailable. */ }
    api = {
      enumerate: user.func('__stdcall', 'EnumWindows', 'int', [koffi.pointer(callback), 'intptr_t']),
      visible: user.func('__stdcall', 'IsWindowVisible', 'int', ['void *']),
      valid: user.func('__stdcall', 'IsWindow', 'int', ['void *']),
      minimized: user.func('__stdcall', 'IsIconic', 'int', ['void *']),
      titleLength: user.func('__stdcall', 'GetWindowTextLengthW', 'int', ['void *']),
      title: user.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'void *', 'int']),
      rect: user.func('__stdcall', 'GetWindowRect', 'int', ['void *', koffi.out(koffi.pointer(rect))]),
      windowPid: user.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', koffi.out(koffi.pointer('uint32'))]),
      dpi,
      openProcess: kernel.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
      closeHandle: kernel.func('__stdcall', 'CloseHandle', 'int', ['void *']),
      image: kernel.func('__stdcall', 'QueryFullProcessImageNameW', 'int', ['void *', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32'))]),
      times: kernel.func('__stdcall', 'GetProcessTimes', 'int', ['void *', koffi.out(koffi.pointer(fileTime)), koffi.out(koffi.pointer(fileTime)), koffi.out(koffi.pointer(fileTime)), koffi.out(koffi.pointer(fileTime))])
    };
    return api;
  } catch (error) { throw new Error(`Windows window enumeration is unavailable: ${String(error)}`); }
}

/** No capture, activation, portal or OS permission prompt. Do not use its handles for input. */
export function enumerateWin32Windows(limit = 500): Win32InventoryResult {
  if (process.platform !== 'win32') throw new Error('Windows window enumeration is unavailable on this platform');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid window inventory limit');
  return collectWin32Windows(nativeApi(), limit);
}

/** Control adapter requires physical coordinates, independently of Electron's calling DPI context. */
export function enumerateWin32WindowsPhysical(limit = 500): Win32InventoryResult {
  if (process.platform !== 'win32') throw new Error('Windows window enumeration is unavailable on this platform');
  const user = koffi.load('user32.dll');
  let setContext: (...args: any[]) => any;
  try { setContext = user.func('__stdcall', 'SetThreadDpiAwarenessContext', 'intptr_t', ['intptr_t']); }
  catch { throw new Error('Per-monitor DPI awareness is unavailable; desktop control cannot map window coordinates'); }
  const previous = setContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
  if (!previous) throw new Error('Could not enter per-monitor DPI awareness for desktop control');
  try { return enumerateWin32Windows(limit); }
  finally { if (!setContext(previous)) throw new Error('Could not restore desktop thread DPI awareness'); }
}

/** Pure orchestration of native calls, injectable for stale/error-path tests. */
export function collectWin32Windows(native: Win32InventoryApi, limit = 500): Win32InventoryResult {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid window inventory limit');
  const windows: Win32WindowObservation[] = [];
  let omitted = 0, truncated = false, failed: unknown;
  const ok = native.enumerate((handle: bigint) => {
    try {
      if (!native.visible(handle)) return 1;
      if (windows.length >= limit) { truncated = true; return 0; }
      const bounds: { left?: number; top?: number; right?: number; bottom?: number } = {};
      const pidOut = [0];
      if (!native.rect(handle, bounds) || !native.windowPid(handle, pidOut) || !pidOut[0] ||
          !Number.isInteger(bounds.left) || !Number.isInteger(bounds.top) || !Number.isInteger(bounds.right) || !Number.isInteger(bounds.bottom) ||
          bounds.right! <= bounds.left! || bounds.bottom! <= bounds.top!) { omitted++; return 1; }
      const maxTitle = 1024, requested = Math.min(Math.max(Number(native.titleLength(handle)) || 0, 0), maxTitle);
      const text = Buffer.alloc((requested + 1) * 2);
      const copied = requested ? Math.max(0, Math.min(Number(native.title(handle, text, requested + 1)) || 0, requested)) : 0;
      let processImage: string | null = null, processCreated: string | null = null;
      const proc = native.openProcess(0x1000, 0, pidOut[0]); // PROCESS_QUERY_LIMITED_INFORMATION
      if (proc) {
        try {
          const buffer = Buffer.alloc(32768 * 2), length = [32768];
          if (native.image(proc, 0, buffer, length) && length[0] > 0 && length[0] < 32768) processImage = buffer.toString('utf16le', 0, length[0] * 2);
          const created: { low?: number; high?: number } = {}, exited = {}, kernel = {}, user = {};
          if (native.times(proc, created, exited, kernel, user) && Number.isInteger(created.low) && Number.isInteger(created.high)) {
            processCreated = ((BigInt(created.high!) << 32n) | BigInt(created.low!)).toString();
          }
        } finally { if (!native.closeHandle(proc)) throw new Error('Could not close process query handle'); }
      }
      const finalPid = [0];
      if (!native.valid(handle) || !native.windowPid(handle, finalPid) || finalPid[0] !== pidOut[0]) { omitted++; return 1; }
      if (processCreated) {
        const verify = native.openProcess(0x1000, 0, finalPid[0]);
        let currentCreated: string | null = null;
        if (verify) {
          try {
            const created: { low?: number; high?: number } = {}, exited = {}, kernel = {}, user = {};
            if (native.times(verify, created, exited, kernel, user) && Number.isInteger(created.low) && Number.isInteger(created.high)) {
              currentCreated = ((BigInt(created.high!) << 32n) | BigInt(created.low!)).toString();
            }
          } finally { if (!native.closeHandle(verify)) throw new Error('Could not close process query handle'); }
        }
        if (currentCreated && currentCreated !== processCreated) { omitted++; return 1; }
        if (!currentCreated) { processCreated = null; processImage = null; }
      }
      const dpiValue = native.dpi ? Number(native.dpi(handle)) : 0;
      const finalTitleLength = Math.max(Number(native.titleLength(handle)) || 0, 0);
      const limitations = ['window_incarnation_unverified', 'bounds_are_caller_dpi_virtualized'];
      if (native.minimized(handle)) limitations.push('window_minimized');
      if (!requested) limitations.push('empty_or_unavailable_title');
      if (requested && !copied) limitations.push('title_unavailable_or_changed');
      if (!processImage || !processCreated) limitations.push('process_identity_unavailable');
      if (!dpiValue) limitations.push('dpi_unavailable');
      windows.push({ nativeHandle: `0x${handle.toString(16)}`, title: text.toString('utf16le', 0, copied * 2),
        titleTruncated: finalTitleLength > copied || requested === maxTitle, pid: pidOut[0], processImage, processCreated,
        bounds: { x: bounds.left!, y: bounds.top!, width: bounds.right! - bounds.left!, height: bounds.bottom! - bounds.top! },
        dpi: dpiValue || null, coordinateSpace: 'win32-screen-caller-dpi', limitations });
      return 1;
    } catch (error) { failed = error; return 0; }
  }, 0);
  if (failed) throw new Error(`Windows window enumeration failed: ${String(failed)}`);
  if (!ok && !truncated) throw new Error('Windows window enumeration failed');
  return { windows, complete: !truncated && omitted === 0, omitted,
    limitations: ['visible_top_level_windows_only', 'window_incarnation_unverified', ...(truncated ? ['inventory_truncated'] : []), ...(omitted ? ['windows_changed_or_unavailable'] : [])] };
}
