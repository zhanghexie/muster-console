import koffi from 'koffi';
import type { DesktopSetupPermission } from '../../shared/desktopSetup';

export type MacDesktopPermission = DesktopSetupPermission;
export type MacDesktopPermissions = Record<MacDesktopPermission, boolean>;

/** Preflight only. Neither probing nor listing metadata requests permissions. */
export function createMacPermissionReader(): () => MacDesktopPermissions {
  if (process.platform !== 'darwin') throw new Error('macOS desktop permissions require macOS');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const screen = cg.func('bool CGPreflightScreenCaptureAccess(void)');
  const accessibility = ax.func('bool AXIsProcessTrusted(void)');
  return () => {
    const screenRecording = screen();
    const accessibilityTrusted = accessibility();
    if (typeof screenRecording !== 'boolean' || typeof accessibilityTrusted !== 'boolean') {
      throw new Error('macOS returned an invalid desktop permission status');
    }
    return { screenRecording, accessibility: accessibilityTrusted };
  };
}

/** The same WindowServer session flag that Cua uses for its locked-screen refusal. */
export function createMacScreenLockReader(): () => boolean {
  if (process.platform !== 'darwin') throw new Error('macOS desktop session state requires macOS');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const copySession = cg.func('void *CGSessionCopyCurrentDictionary(void)');
  const makeKey = cf.func('void *CFStringCreateWithCString(void *allocator, str value, uint32_t encoding)');
  const getValue = cf.func('void *CFDictionaryGetValue(void *dictionary, void *key)');
  const type = cf.func('unsigned long CFGetTypeID(void *value)');
  const booleanType = cf.func('unsigned long CFBooleanGetTypeID(void)')();
  const numberType = cf.func('unsigned long CFNumberGetTypeID(void)')();
  const boolean = cf.func('bool CFBooleanGetValue(void *value)');
  const number = cf.func('bool CFNumberGetValue(void *value, int type, _Out_ int32_t *out)');
  const release = cf.func('void CFRelease(void *value)');
  return () => {
    const session = copySession();
    if (!session) throw new Error('No graphical macOS session; sign in to the desktop and retry.');
    let key: unknown;
    try {
      key = makeKey(null, 'CGSSessionScreenIsLocked', 0x08000100);
      if (!key) throw new Error('macOS screen lock status is unavailable');
      const value = getValue(session, key);
      if (!value) return false;
      const valueType = type(value);
      if (valueType === booleanType) return boolean(value) === true;
      const flag = [0];
      if (valueType === numberType && number(value, 3, flag)) return flag[0] !== 0;
      throw new Error('macOS screen lock status is unavailable');
    } finally { if (key) release(key); release(session); }
  };
}
