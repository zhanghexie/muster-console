import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-win32-apps-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { focusWin32Window, launchWin32Executable, normalizeWin32Executable, resolveWin32Executable } = await import(pathToFileURL(compile('main/desktop/win32Applications.ts')));
  assert.equal(normalizeWin32Executable('C:\\Apps\\..\\Apps\\run.exe'), 'C:\\Apps\\run.exe');
  assert.equal(normalizeWin32Executable('\\\\server\\share\\run.exe'), '\\\\server\\share\\run.exe');
  for (const bad of ['\\foo.exe', 'C:foo.exe', '\\\\server\\foo.exe', '\\\\?\\C:\\foo.exe', 'notepad.exe']) {
    assert.throws(() => normalizeWin32Executable(bad), /absolute/, bad);
  }
  const calls = [];
  const api = { valid: () => 1, minimized: () => 1, restore: (...args) => { calls.push(['restore', ...args]); return 0; },
    activate: handle => { calls.push(['activate', handle]); return 1; }, foreground: () => 42 };
  focusWin32Window(api, 42n, () => true);
  assert.deepEqual(calls, [['restore', 42n, 9], ['activate', 42n]]);
  assert.throws(() => focusWin32Window(api, 42n, () => false), /no longer current/);
  assert.throws(() => focusWin32Window({ ...api, foreground: () => 11 }, 42n, () => true), /denied/);
  let foreground = 11, attempts = 0; const attach = [];
  focusWin32Window({ ...api, foreground: () => foreground, activate: () => { if (++attempts === 2) foreground = 42; return attempts === 2 ? 1 : 0; },
    currentThread: () => 10, windowThread: () => 11, attach: (from, to, enabled) => { attach.push([from, to, enabled]); return 1; } }, 42n, () => true);
  assert.deepEqual(attach, [[10, 11, 1], [10, 11, 0]]);
  if (process.platform === 'win32') {
    await assert.rejects(launchWin32Executable('notepad.exe'), /absolute/);
    await assert.rejects(launchWin32Executable('C:\\missing\\fake.txt'), /absolute/);
    await assert.rejects(resolveWin32Executable(path.join(temp, 'nonexistent.exe')), /does not exist/);
    const directory = path.join(temp, 'folder.exe'); fs.mkdirSync(directory);
    await assert.rejects(resolveWin32Executable(directory), /not a file/);
  } else await assert.rejects(launchWin32Executable('C:\\test.exe'), /unavailable/);
  console.log('desktop Win32 applications: stale identity, foreground denial and launch validation passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
