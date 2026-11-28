import koffi from 'koffi';

export type MacRunningApplication = { pid: number; launchDate: number | null; active: boolean };
export type MacRunningApplicationsReader = (bundleId: string) => MacRunningApplication[];

/** Read AppKit process state for one bundle, independently of the Cua launch response. */
export function createMacRunningApplicationsReader(): MacRunningApplicationsReader {
  if (process.platform !== 'darwin') throw new Error('Reading macOS application state requires macOS');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const getClass = objc.func('void *objc_getClass(str name)');
  const selector = objc.func('void *sel_registerName(str name)');
  const poolPush = objc.func('void *objc_autoreleasePoolPush(void)');
  const poolPop = objc.func('void objc_autoreleasePoolPop(void *pool)');
  const sendWithArg = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
  const sendObject = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const sendPid = objc.func('objc_msgSend', 'int', ['void *', 'void *']);
  const sendBool = objc.func('objc_msgSend', 'uint8_t', ['void *', 'void *']);
  const makeString = cf.func('void *CFStringCreateWithCString(void *allocator, str value, uint32_t encoding)');
  const release = cf.func('void CFRelease(void *value)');
  const count = cf.func('long CFArrayGetCount(void *array)');
  const at = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
  const dateValue = cf.func('double CFDateGetAbsoluteTime(void *date)');
  const runningApplication = getClass('NSRunningApplication');
  if (!runningApplication) throw new Error('macOS running application state is unavailable');
  const byBundle = selector('runningApplicationsWithBundleIdentifier:');
  const processId = selector('processIdentifier');
  const launchDate = selector('launchDate');
  const active = selector('isActive');
  const terminated = selector('isTerminated');

  return bundleId => {
    const pool = poolPush();
    let key: unknown;
    try {
      key = makeString(null, bundleId, 0x08000100);
      const apps = key && sendWithArg(runningApplication, byBundle, key);
      if (!apps) throw new Error('macOS could not read applications for the requested bundle');
      const length = Number(count(apps));
      if (!Number.isSafeInteger(length) || length < 0 || length > 1024) throw new Error('Invalid macOS running application count');
      const observed: MacRunningApplication[] = [];
      for (let index = 0; index < length; index++) {
        const app = at(apps, index);
        if (!app || sendBool(app, terminated)) continue;
        const pid = sendPid(app, processId);
        if (pid <= 0) continue;
        const date = sendObject(app, launchDate);
        const seconds = date ? dateValue(date) : null;
        observed.push({ pid, launchDate: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null,
          active: sendBool(app, active) !== 0 });
      }
      return observed;
    } finally {
      if (key) release(key);
      poolPop(pool);
    }
  };
}
