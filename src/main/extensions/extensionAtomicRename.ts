import path from 'node:path';
import koffi from 'koffi';

type NativeFunction = (...args: unknown[]) => number;
interface NativeLibrary { func(...args: unknown[]): NativeFunction }
export interface ExtensionNativeFunctions { load(name: string | null): NativeLibrary; errno(): number }
export class ExtensionAtomicRenameError extends Error {
  constructor(readonly platform: string, readonly errorNumber: number | undefined, message: string) { super(message); this.name = 'ExtensionAtomicRenameError'; }
}

/**
 * Move within one directory only when the destination does not exist. This
 * fails closed if the OS or filesystem cannot offer that guarantee.
 */
export function createExtensionAtomicRenamer(platform: NodeJS.Platform = process.platform, native: ExtensionNativeFunctions = koffi as unknown as ExtensionNativeFunctions, architecture: string = process.arch, privateEntries = false): (from: string, to: string) => void {
  let move: NativeFunction;
  let error: () => number;
  try {
    if (platform === 'win32') {
      const library = native.load('kernel32.dll');
      move = library.func('__stdcall', 'MoveFileW', 'int', ['str16', 'str16']);
      // Koffi preserves Win32 LastError across calls. koffi.errno() is the
      // distinct C/POSIX errno and must not replace this Windows API.
      error = library.func('__stdcall', 'GetLastError', 'uint32', []);
    } else if (platform === 'darwin') {
      const library = native.load('/usr/lib/libSystem.B.dylib');
      move = library.func('int renamex_np(const char *from, const char *to, unsigned int flags)');
      error = () => native.errno();
    } else if (platform === 'linux') {
      // Resolve symbols from the current process so glibc and musl do not need
      // the same shared-library filename. Some libcs expose only syscall().
      const library = native.load(null);
      try { move = library.func('int renameat2(int fromDir, const char *from, int toDir, const char *to, unsigned int flags)'); }
      catch {
        // Linux kernel syscall tables, not guessed from a filesystem path.
        const numbers: Record<string, number> = { x64: 316, ia32: 353, arm64: 276, arm: 382, ppc64: 357, s390x: 347, riscv64: 276 };
        const number = numbers[architecture];
        if (number === undefined) throw new Error(`renameat2 syscall number is unavailable for ${architecture}`);
        const syscall = library.func('long syscall(long number, ...)');
        move = (fromDir, from, toDir, to, flags) => Number(syscall(number, 'int', fromDir, 'str', from, 'int', toDir, 'str', to, 'uint', flags));
      }
      error = () => native.errno();
    } else throw new Error(`Unsupported platform: ${platform}`);
  } catch (cause) { throw new ExtensionAtomicRenameError(platform, undefined, `Atomic no-overwrite rename is unavailable: ${String(cause)}`); }

  return (from: string, to: string): void => {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (!from || !to || from.includes('\0') || to.includes('\0') || !paths.isAbsolute(from) || !paths.isAbsolute(to)) throw new ExtensionAtomicRenameError(platform, undefined, 'Atomic rename requires absolute paths');
    const source = paths.resolve(from), target = paths.resolve(to);
    const comparable = (value: string): string => platform === 'win32' ? value.toLowerCase() : value;
    const sourceParent = paths.dirname(source), targetParent = paths.dirname(target);
    const sameParent = comparable(sourceParent) === comparable(targetParent);
    const privateName = paths.basename(source);
    const fromStage = /^\.extension-stage-([a-f0-9-]{36})$/i.exec(paths.basename(sourceParent));
    const fromPrevious = /^\.extension-previous-([a-f0-9-]{36})$/i.exec(paths.basename(sourceParent));
    const toStage = /^\.extension-stage-([a-f0-9-]{36})$/i.exec(paths.basename(targetParent));
    const toPrevious = /^\.extension-previous-([a-f0-9-]{36})$/i.exec(paths.basename(targetParent));
    const sameTransaction = (fromStage && toPrevious && fromStage[1].toLowerCase() === toPrevious[1].toLowerCase())
      || (fromPrevious && toStage && fromPrevious[1].toLowerCase() === toStage[1].toLowerCase());
    const safePrivateMove = privateEntries && !!sameTransaction && ['data', 'cache', '.git'].includes(privateName.toLowerCase())
      && privateName === paths.basename(target) && comparable(paths.dirname(sourceParent)) === comparable(paths.dirname(targetParent));
    if ((!sameParent && !safePrivateMove) || comparable(source) === comparable(target)) throw new ExtensionAtomicRenameError(platform, undefined, 'Atomic rename requires distinct paths in the same parent directory or protected sibling transaction entries');
    let result: number;
    if (platform === 'win32') result = move(path.win32.toNamespacedPath(source), path.win32.toNamespacedPath(target));
    else if (platform === 'darwin') result = move(source, target, 0x00000004); // RENAME_EXCL
    else result = move(-100, source, -100, target, 1); // AT_FDCWD, RENAME_NOREPLACE
    if ((platform === 'win32' && result === 0) || (platform !== 'win32' && result !== 0)) {
      const number = error();
      throw new ExtensionAtomicRenameError(platform, number, `Atomic no-overwrite rename failed (${platform} error ${number})`);
    }
  };
}
