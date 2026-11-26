import koffi from 'koffi';

export interface MacWindowRow {
  windowId: number; pid: number; ownerName: string | null; title: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  layer?: number;
  alpha?: number;
  onScreen?: boolean;
}
export interface MacInventorySource { count(): number; read(index: number): MacWindowRow | null; close(): void }
export interface MacInventoryResult {
  windows: Array<MacWindowRow & { nativeHandle: string; coordinateSpace: 'coregraphics-screen-space'; limitations: string[] }>;
  complete: boolean; omitted: number; limitations: string[];
}

/** Collect only; no title or PID is evidence of stable window/process identity. */
export function collectMacWindows(source: MacInventorySource, limit = 500): MacInventoryResult {
  const windows: MacInventoryResult['windows'] = [];
  const seen = new Set<number>();
  let omitted = 0;
  try {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid window inventory limit');
    const count = source.count();
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Core Graphics window count');
    for (let index = 0; index < Math.min(count, limit); index++) {
      const row = source.read(index);
      if (!row || !Number.isSafeInteger(row.windowId) || row.windowId < 1 || row.windowId > 0xffffffff ||
          seen.has(row.windowId) || !Number.isSafeInteger(row.pid) || row.pid < 1 || !row.bounds ||
          ![row.bounds.x, row.bounds.y, row.bounds.width, row.bounds.height].every(Number.isFinite) || row.bounds.width <= 0 || row.bounds.height <= 0 ||
          (row.title !== null && typeof row.title !== 'string') || (row.ownerName !== null && typeof row.ownerName !== 'string')) { omitted++; continue; }
      seen.add(row.windowId);
      const limitations = ['window_incarnation_unverified', 'process_instance_unverified', 'capture_pixel_transform_unavailable'];
      if (row.title === null) limitations.push('window_name_unavailable');
      if (row.ownerName === null) limitations.push('owner_name_unavailable');
      if ((row.title?.length ?? 0) > 1024 || (row.ownerName?.length ?? 0) > 1024) limitations.push('name_truncated');
      windows.push({ ...row, title: row.title?.slice(0, 1024) ?? null, ownerName: row.ownerName?.slice(0, 1024) ?? null,
        bounds: { ...row.bounds }, nativeHandle: String(row.windowId), coordinateSpace: 'coregraphics-screen-space', limitations });
    }
    return { windows, complete: count <= limit && omitted === 0, omitted,
      limitations: ['onscreen_windows_only', 'window_incarnation_unverified', ...(count > limit ? ['inventory_truncated'] : []),
        ...(omitted ? ['invalid_or_unavailable_windows'] : [])] };
  } finally { source.close(); }
}

/** Core Graphics metadata query does not request screen recording access. */
let createNativeSource: ((windowId?: number) => MacInventorySource) | undefined;
function nativeMacSource(windowId?: number): MacInventorySource {
  try {
    createNativeSource ??= bindMacInventory();
    return createNativeSource(windowId);
  } catch (error) { throw new Error(`macOS window inventory unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}

function bindMacInventory(): (windowId?: number) => MacInventorySource {
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const point = koffi.struct('DesktopMacInventoryPoint', { x: 'double', y: 'double' });
  const size = koffi.struct('DesktopMacInventorySize', { width: 'double', height: 'double' });
  const rect = koffi.struct('DesktopMacInventoryRect', { origin: point, size });
  const list = cg.func('void *CGWindowListCopyWindowInfo(uint32 options, uint32 relative)');
  const makeRect = cg.func('CGRectMakeWithDictionaryRepresentation', 'bool', ['void *', koffi.out(koffi.pointer(rect))]);
  const count = cf.func('long CFArrayGetCount(void *array)');
  const element = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
  const value = cf.func('void *CFDictionaryGetValue(void *dictionary, void *key)');
  const typeId = cf.func('unsigned long CFGetTypeID(void *object)');
  const dictionaryType = cf.func('unsigned long CFDictionaryGetTypeID()')();
  const arrayType = cf.func('unsigned long CFArrayGetTypeID()')();
  const numberType = cf.func('unsigned long CFNumberGetTypeID()')();
  const stringType = cf.func('unsigned long CFStringGetTypeID()')();
  const boolType = cf.func('unsigned long CFBooleanGetTypeID()')();
  const boolValue = cf.func('bool CFBooleanGetValue(void *bool)');
  const number = cf.func('bool CFNumberGetValue(void *number, int type, _Out_ int64 *out)');
  const double = cf.func('bool CFNumberGetValue(void *number, int type, _Out_ double *out)');
  const stringLength = cf.func('long CFStringGetLength(void *string)');
  const stringCopy = cf.func('bool CFStringGetCString(void *string, void *buffer, long size, uint32 encoding)');
  const release = cf.func('void CFRelease(void *object)');
  const keys = Object.fromEntries(['kCGWindowNumber', 'kCGWindowOwnerPID', 'kCGWindowOwnerName', 'kCGWindowName', 'kCGWindowBounds',
    'kCGWindowLayer', 'kCGWindowAlpha', 'kCGWindowIsOnscreen']
    .map(name => [name, koffi.decode(cg.symbol(name, 'void *'), 'void *')]));
  if (Object.values(keys).some(key => !key)) throw new Error('Core Graphics window keys are unavailable');
  const integer = (object: unknown): number | null => {
    if (!object || typeId(object) !== numberType) return null;
    const out = [0n];
    if (!number(object, 4, out)) return null; // kCFNumberSInt64Type
    const result = Number(out[0]); return Number.isSafeInteger(result) ? result : null;
  };
  const text = (object: unknown): string | null => {
    if (!object || typeId(object) !== stringType) return null;
    const length = Number(stringLength(object));
    if (!Number.isSafeInteger(length) || length < 0 || length > 4096) return null;
    const buffer = Buffer.alloc(length * 4 + 1);
    if (!stringCopy(object, buffer, buffer.length, 0x08000100)) return null; // kCFStringEncodingUTF8
    const end = buffer.indexOf(0); return buffer.toString('utf8', 0, end < 0 ? buffer.length : end);
  };
  return windowId => {
    // kCGWindowListOptionIncludingWindow for identity checks, OnScreenOnly for inventory.
    const array = windowId === undefined ? list(1, 0) : list(8, windowId);
    if (!array) throw new Error('No active Quartz window server; start a graphical macOS session');
    if (typeId(array) !== arrayType) { release(array); throw new Error('Invalid Core Graphics window list'); }
    return {
      count: () => Number(count(array)),
      read: index => {
        const dictionary = element(array, index);
        if (!dictionary || typeId(dictionary) !== dictionaryType) return null;
        const windowId = integer(value(dictionary, keys.kCGWindowNumber)), pid = integer(value(dictionary, keys.kCGWindowOwnerPID));
        const rawBounds = value(dictionary, keys.kCGWindowBounds);
        if (!rawBounds || typeId(rawBounds) !== dictionaryType || windowId === null || pid === null) return null;
        const result: { origin?: { x: number; y: number }; size?: { width: number; height: number } } = {};
        if (!makeRect(rawBounds, result) || !result.origin || !result.size) return null;
        const layer = integer(value(dictionary, keys.kCGWindowLayer));
        const opacity = value(dictionary, keys.kCGWindowAlpha), alpha = [0];
        const hasAlpha = !!opacity && typeId(opacity) === numberType && double(opacity, 6, alpha); // kCFNumberFloat64Type
        const onScreen = value(dictionary, keys.kCGWindowIsOnscreen);
        return { windowId, pid, ownerName: text(value(dictionary, keys.kCGWindowOwnerName)), title: text(value(dictionary, keys.kCGWindowName)),
          bounds: { x: result.origin.x, y: result.origin.y, width: result.size.width, height: result.size.height },
          ...(layer === null ? {} : { layer }), ...(hasAlpha ? { alpha: alpha[0] } : {}),
          onScreen: !!onScreen && typeId(onScreen) === boolType && boolValue(onScreen) === true };
      },
      close: () => { release(array); }
    };
  };
}

/** No capture, activation, permission request or claim of native backend support. */
export function enumerateMacWindows(limit = 500): MacInventoryResult {
  if (process.platform !== 'darwin') throw new Error('macOS window inventory is unavailable on this platform');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid window inventory limit');
  return collectMacWindows(nativeMacSource(), limit);
}

/** A targeted Core Graphics lookup used only by the retained AX identity adapter. */
export function readMacWindow(windowId: number): MacWindowRow | null {
  if (process.platform !== 'darwin') throw new Error('macOS window inventory is unavailable on this platform');
  const source = nativeMacSource(windowId);
  try {
    const window = source.count() === 1 ? source.read(0) : null;
    return window?.windowId === windowId ? window : null;
  } finally { source.close(); }
}
