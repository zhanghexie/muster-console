import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-generation-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { Win32WindowGeneration } = await import(pathToFileURL(compile('main/desktop/win32WindowGeneration.ts')));
  const props = new Map();
  const names = [];
  const api = { get: handle => props.get(handle) ?? 0n, set: (handle, name, value) => { names.push(name); props.set(handle, value); return 1; },
    remove: handle => { const old = props.get(handle); props.delete(handle); return old ?? 0n; } };
  const tracker = new Win32WindowGeneration(api);
  const first = tracker.observe('0x44');
  assert.match(names[0], /^Muster-[a-f0-9-]+$/);
  assert.equal(names.some(name => name.startsWith('MetaAgent-')), false);
  assert.equal(tracker.observe('0x44'), first);
  props.delete(0x44n); // Window destroyed; new window reuses the exact HWND in the same process.
  assert.equal(tracker.current('0x44', first), false);
  const second = tracker.observe('0x44');
  assert.notEqual(second, first);
  tracker.release('0x44', first);
  assert.equal(tracker.current('0x44', second), true, 'old cleanup must not erase the replacement marker');
  tracker.close(); assert.equal(props.size, 0);
  assert.equal(new Win32WindowGeneration({ ...api, set: () => 0 }).observe('0x55'), null);
  const cannotRemove = new Win32WindowGeneration({ ...api, remove: () => 0 });
  cannotRemove.observe('0x66');
  assert.throws(() => cannotRemove.close(), /Could not remove/);
  console.log('desktop Win32 generation: HWND reuse, cleanup and denied marking passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
