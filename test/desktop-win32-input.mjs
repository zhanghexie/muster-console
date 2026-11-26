import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-win32-input-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { win32InputRecords, Win32Input, performWin32Input } = await import(pathToFileURL(compile('main/desktop/win32Input.ts')));
  for (const [pointer, size, union] of [[8, 40, 8], [4, 28, 4]]) {
    const data = win32InputRecords([{ kind: 'mouse', flags: 0x800, data: -120 },
      { kind: 'key', scan: 0x4e2d, flags: 4 }], pointer);
    assert.equal(data.length, size * 2);
    assert.equal(data.readInt32LE(union + 8), -120);
    assert.equal(data.readUInt32LE(union + 12), 0x800);
    assert.equal(data.readUInt32LE(size), 1);
    assert.equal(data.readUInt16LE(size + union + 2), 0x4e2d);
  }
  let calls = 0;
  const input = new Win32Input({ cursor: (x, y) => { calls++; return x === -100 && y === 20 ? 1 : 0; },
    send: (count, bytes, size) => { calls++; assert.equal(bytes.length, count * size); return count - 1; } });
  input.move(-100, 20);
  assert.throws(() => input.move(NaN, 0), /Invalid/);
  assert.throws(() => input.move(1, 2), /SetCursorPos/);
  assert.throws(() => input.send([{ kind: 'key', vk: 65 }]), /complete batch/);
  assert.equal(calls, 3);
  assert.throws(() => win32InputRecords([{ kind: 'key', vk: 65536 }]), /Invalid/);
  const events = [], fake = { move: (x, y) => events.push(['move', x, y]), send: batch => events.push(batch[0]) };
  await performWin32Input(fake, { action: 'click', x: 10, y: 20 });
  assert.deepEqual(events, [['move', 10, 20], { kind: 'mouse', flags: 2 }, { kind: 'mouse', flags: 4 }]);
  events.length = 0;
  await performWin32Input(fake, { action: 'type', text: '中' });
  assert.deepEqual(events, [{ kind: 'key', scan: 0x4e2d, flags: 4 }, { kind: 'key', scan: 0x4e2d, flags: 6 }]);
  events.length = 0;
  await performWin32Input(fake, { action: 'drag', x: 1, y: 2, toX: 3, toY: 4, button: 'right' });
  assert.deepEqual(events, [['move', 1, 2], { kind: 'mouse', flags: 8 }, ['move', 3, 4], { kind: 'mouse', flags: 16 }]);
  events.length = 0;
  await performWin32Input(fake, { action: 'scroll', x: 1, y: 2, delta: -120 });
  assert.deepEqual(events, [['move', 1, 2], { kind: 'mouse', flags: 0x800, data: -120 }]);
  events.length = 0;
  await performWin32Input(fake, { action: 'hover', x: 1, y: 2 });
  await performWin32Input(fake, { action: 'move', x: 3, y: 4 });
  assert.deepEqual(events, [['move', 1, 2], ['move', 3, 4]]);
  events.length = 0;
  const failing = { move: fake.move, send: batch => { events.push(batch[0]); if (batch[0].vk === 65 && !batch[0].flags) throw new Error('partial'); } };
  await assert.rejects(performWin32Input(failing, { action: 'key', keys: [17, 65] }), /partial/);
  assert.deepEqual(events.slice(-2), [{ kind: 'key', vk: 65, flags: 2 }, { kind: 'key', vk: 17, flags: 2 }]);
  events.length = 0;
  await performWin32Input(fake, { action: 'key', keys: [0x25] });
  assert.deepEqual(events, [{ kind: 'key', vk: 0x25, flags: 1 }, { kind: 'key', vk: 0x25, flags: 3 }]);
  events.length = 0;
  const interrupt = new AbortController();
  const longInput = performWin32Input(fake, { action: 'type', text: 'x'.repeat(256) }, interrupt.signal);
  setImmediate(() => interrupt.abort(new Error('physical stop')));
  await assert.rejects(longInput, /physical stop/, 'long text input must yield so the stop signal can be received');
  assert.ok(events.length > 0 && events.length < 512, 'the full text must not be dispatched after stop');
  assert.equal(events.length % 2, 0, 'each dispatched Unicode press must have a matching release');
  assert.equal(events.at(-1).flags, 6);
  console.log('desktop Win32 input: record layouts, validation and native failures passed');
} finally { removeWorkspaceFixture(temp, 'desktop-win32-input-'); }
