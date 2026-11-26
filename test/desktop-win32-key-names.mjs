import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-win32-key-names-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { normalizeWin32Keys } = await import(pathToFileURL(compile('main/desktop/win32KeyNames.ts')));
  const { performWin32Input } = await import(pathToFileURL(compile('main/desktop/win32Input.ts')));
  assert.deepEqual(normalizeWin32Keys(['Control', 'KeyA']), [0x11, 0x41]);
  assert.deepEqual(normalizeWin32Keys(['Ctrl', 'digit1', 'ArrowLeft', 'F24']), [0x11, 0x31, 0x25, 0x87]);
  assert.deepEqual(normalizeWin32Keys(['ControlRight', 'alt-right', 'Esc', 'MetaLeft']), [0xa3, 0xa5, 0x1b, 0x5b]);
  assert.deepEqual(normalizeWin32Keys(['CtrlLeft', 'WinRight']), [0xa2, 0x5c]);
  assert.deepEqual(normalizeWin32Keys([0x11, 0x43]), [0x11, 0x43], 'existing virtual-key numbers remain valid');
  for (const invalid of [[], [0], [256], ['F25'], ['中'], [' '], ['unknown'], ['ctrl', 'Control'],
    ['A', 'KeyA'], Array(9).fill('A')]) {
    assert.throws(() => normalizeWin32Keys(invalid));
  }
  const events = [];
  await performWin32Input({ move() {}, send: batch => events.push(...batch) },
    { action: 'key', keys: normalizeWin32Keys(['Control', 'ArrowLeft']) });
  assert.deepEqual(events, [
    { kind: 'key', vk: 0x11, flags: 0 }, { kind: 'key', vk: 0x25, flags: 1 },
    { kind: 'key', vk: 0x25, flags: 3 }, { kind: 'key', vk: 0x11, flags: 2 }
  ], 'named chords must press and release the corresponding native keys in order');
  console.log('desktop Win32 named keys: normalization, rejection and input ordering passed');
} finally { removeWorkspaceFixture(temp, 'desktop-win32-key-names-'); }
