import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import koffi from 'koffi';

export interface Win32WindowApi {
  valid(handle: bigint): number;
  minimized(handle: bigint): number;
  restore(handle: bigint, command: number): number;
  activate(handle: bigint): number;
  foreground(): bigint | number | null;
  currentThread?(): number;
  windowThread?(handle: bigint | number): number;
  attach?(from: number, to: number, attach: number): number;
}

/** The caller must resolve and revalidate its host-owned window identity. */
export function focusWin32Window(api: Win32WindowApi, handle: bigint, isCurrent: () => boolean): void {
  if (typeof handle !== 'bigint' || handle <= 0n || typeof isCurrent !== 'function') throw new Error('Invalid Windows window identity');
  if (!isCurrent() || !api.valid(handle)) throw new Error('Desktop window is no longer current');
  if (api.minimized(handle)) api.restore(handle, 9); // SW_RESTORE returns previous visibility, not success.
  if (!isCurrent() || !api.valid(handle)) throw new Error('Desktop window changed before activation');
  if (api.activate(handle) && BigInt(api.foreground() ?? 0) === handle) return;
  // A GUI thread that owns the foreground may be in another process after confirmation.
  // Temporarily join its input queue; always detach, and never claim success without readback.
  const foreground = api.foreground(), currentThread = api.currentThread?.(), foregroundThread = foreground && api.windowThread?.(foreground);
  if (!foreground || !currentThread || !foregroundThread || currentThread === foregroundThread || !api.attach || !api.attach(currentThread, foregroundThread, 1)) {
    throw new Error('Windows denied foreground activation; bring the application forward manually');
  }
  let activated = false, detached = false;
  try {
    if (!isCurrent() || !api.valid(handle)) throw new Error('Desktop window changed before activation');
    activated = !!api.activate(handle) && BigInt(api.foreground() ?? 0) === handle;
  } finally { detached = !!api.attach(currentThread, foregroundThread, 0); }
  if (!detached) throw new Error('Windows input queues could not be detached');
  if (!activated) throw new Error('Windows denied foreground activation; bring the application forward manually');
}

export function createWin32WindowApi(): Win32WindowApi {
  if (process.platform !== 'win32') throw new Error('Windows window activation is unavailable on this platform');
  const user = koffi.load('user32.dll');
  const kernel = koffi.load('kernel32.dll');
  const windowThread = user.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr_t', 'void *']);
  return {
    valid: user.func('__stdcall', 'IsWindow', 'int', ['intptr_t']),
    minimized: user.func('__stdcall', 'IsIconic', 'int', ['intptr_t']),
    restore: user.func('__stdcall', 'ShowWindow', 'int', ['intptr_t', 'int']),
    activate: user.func('__stdcall', 'SetForegroundWindow', 'int', ['intptr_t']),
    foreground: user.func('__stdcall', 'GetForegroundWindow', 'intptr_t', []),
    currentThread: kernel.func('__stdcall', 'GetCurrentThreadId', 'uint32', []),
    windowThread: handle => windowThread(handle, null),
    attach: user.func('__stdcall', 'AttachThreadInput', 'int', ['uint32', 'uint32', 'int'])
  };
}

/** Reject rooted paths without a drive, device paths and incomplete UNC paths. */
export function normalizeWin32Executable(appId: string): string {
  if (typeof appId !== 'string' || appId.includes('\0') || !/\.exe$/i.test(appId)) throw new Error('Provide an absolute Windows executable path');
  const normalized = path.win32.normalize(appId);
  const drive = /^[a-z]:\\/i.test(normalized);
  const unc = /^\\\\(?![?.]\\)[^\\]+\\[^\\]+\\.+/i.test(normalized);
  if ((!drive && !unc) || !/\.exe$/i.test(normalized)) throw new Error('Provide an absolute Windows executable path');
  return normalized;
}

export async function resolveWin32Executable(appId: string): Promise<string> {
  const normalized = normalizeWin32Executable(appId);
  let info;
  try { info = await fs.stat(normalized); }
  catch { throw new Error('Windows executable does not exist or cannot be accessed'); }
  if (!info.isFile()) throw new Error('Windows executable is not a file');
  return normalized;
}

/** No shell or command-line parsing: appId is a validated executable path. */
export async function launchWin32Executable(appId: string, signal?: AbortSignal): Promise<{ pid: number }> {
  if (process.platform !== 'win32') throw new Error('Windows application launch is unavailable on this platform');
  appId = await resolveWin32Executable(appId);
  signal?.throwIfAborted();
  const child = spawn(appId, [], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      if (!child.pid) reject(new Error('Application started without a process ID'));
      else resolve({ pid: child.pid });
    });
  });
}
