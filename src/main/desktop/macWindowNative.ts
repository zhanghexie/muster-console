import koffi from 'koffi';
import { readMacWindow } from './macInventory';
import type { MacDesktopPermissions } from './macPermissions';
import type { MacWindowIdentityNative } from './macWindowIdentity';

export interface MacWindowNative extends MacWindowIdentityNative {
  windowAtPoint(x: number, y: number): { pid: number; windowId: number } | undefined;
}

/** Retain the NSRunningApplication and exact AX element on the Electron main thread. */
export function createMacWindowNative(permissions: () => MacDesktopPermissions): MacWindowNative {
  if (process.platform !== 'darwin') throw new Error('macOS window identity requires macOS');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const getClass = objc.func('void *objc_getClass(str name)');
  const selector = objc.func('void *sel_registerName(str name)');
  const sendPid = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'int']);
  const sendBool = objc.func('objc_msgSend', 'uint8_t', ['void *', 'void *']);
  const sendEquals = objc.func('objc_msgSend', 'uint8_t', ['void *', 'void *', 'void *']);
  const retain = objc.func('void *objc_retain(void *value)');
  const release = objc.func('void objc_release(void *value)');
  const poolPush = objc.func('void *objc_autoreleasePoolPush(void)');
  const poolPop = objc.func('void objc_autoreleasePoolPop(void *pool)');
  const runningApplication = getClass('NSRunningApplication');
  if (!runningApplication) throw new Error('macOS running application identity is unavailable');
  const byPid = selector('runningApplicationWithProcessIdentifier:');
  const terminated = selector('isTerminated');
  const same = selector('isEqual:');

  const application = ax.func('void *AXUIElementCreateApplication(int pid)');
  const systemWide = ax.func('void *AXUIElementCreateSystemWide(void)');
  const atPoint = ax.func('int AXUIElementCopyElementAtPosition(void *element, float x, float y, _Out_ void **value)');
  const timeout = ax.func('int AXUIElementSetMessagingTimeout(void *element, float seconds)');
  const attribute = ax.func('int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)');
  const pidFor = ax.func('int AXUIElementGetPid(void *element, _Out_ int *pid)');
  // Only accept an exact AX-to-WindowServer mapping. If the OS removes this
  // symbol, keep display capture available and report window control unavailable.
  const windowIdFor = ax.func('int _AXUIElementGetWindow(void *element, _Out_ uint32_t *window)');
  const elementType = ax.func('unsigned long AXUIElementGetTypeID(void)')();
  const cfRelease = cf.func('void CFRelease(void *value)');
  const cfRetain = cf.func('void *CFRetain(void *value)');
  const equal = cf.func('uint8_t CFEqual(void *left, void *right)');
  const typed = cf.func('unsigned long CFGetTypeID(void *value)');
  const arrayType = cf.func('unsigned long CFArrayGetTypeID(void)')();
  const count = cf.func('long CFArrayGetCount(void *array)');
  const at = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
  const windowsAttribute = cf.func('void *CFStringCreateWithCString(void *allocator, str value, uint32_t encoding)');
  const windowNumber = (window: unknown) => { const out = [0]; return windowIdFor(window, out) === 0 && out[0] > 0 ? out[0] : null; };
  const elementPid = (window: unknown) => { const out = [0]; return pidFor(window, out) === 0 ? out[0] : null; };

  return {
    accessibilityTrusted: () => permissions().accessibility,
    screenCaptureTrusted: () => permissions().screenRecording,
    retainRunningApplication(pid) {
      const pool = poolPush();
      try {
        const app = sendPid(runningApplication, byPid, pid);
        return app ? retain(app) : null;
      } finally { poolPop(pool); }
    },
    applicationTerminated: app => sendBool(app, terminated) !== 0,
    sameApplication: (left, right) => sendEquals(left, same, right) !== 0,
    releaseApplication: release,
    windowAtPoint(x, y) {
      const system = systemWide();
      if (!system) return;
      let key: unknown;
      const result: unknown[] = [null], window: unknown[] = [null];
      try {
        if (timeout(system, 0.2) !== 0 || atPoint(system, x, y, result) !== 0 || !result[0] || typed(result[0]) !== elementType) return;
        const pid = elementPid(result[0]);
        const ownWindow = windowNumber(result[0]);
        if (pid && ownWindow) return { pid, windowId: ownWindow };
        key = windowsAttribute(null, 'AXWindow', 0x08000100);
        if (!key || attribute(result[0], key, window) !== 0 || !window[0] || typed(window[0]) !== elementType) return;
        const owner = elementPid(window[0]), number = windowNumber(window[0]);
        if (owner && number) return { pid: owner, windowId: number };
      } finally {
        if (result[0]) cfRelease(result[0]);
        if (window[0]) cfRelease(window[0]);
        if (key) cfRelease(key);
        cfRelease(system);
      }
    },
    openAxWindows(pid) {
      const app = application(pid);
      if (!app) throw new Error('macOS Accessibility application is unavailable');
      let key: unknown;
      const out: unknown[] = [null];
      try {
        key = windowsAttribute(null, 'AXWindows', 0x08000100);
        if (!key || timeout(app, 0.2) !== 0 || attribute(app, key, out) !== 0 || !out[0] || typed(out[0]) !== arrayType) {
          throw new Error('macOS Accessibility windows are unavailable for this application');
        }
        const array = out[0];
        const length = Number(count(array));
        if (!Number.isSafeInteger(length) || length < 0 || length > 1024) throw new Error('Invalid macOS Accessibility window count');
        return { windows: Array.from({ length }, (_, index) => at(array, index)), close: () => cfRelease(array) };
      } catch (error) {
        if (out[0]) cfRelease(out[0]);
        throw error;
      } finally {
        if (key) cfRelease(key);
        cfRelease(app);
      }
    },
    axWindowPid: elementPid,
    axWindowId: windowNumber,
    sameAxWindow: (left, right) => equal(left, right) !== 0,
    retainAxWindow: cfRetain,
    releaseAxWindow: cfRelease,
    isWindowOwnedBy: (pid, windowId) => readMacWindow(windowId)?.pid === pid
  };
}
