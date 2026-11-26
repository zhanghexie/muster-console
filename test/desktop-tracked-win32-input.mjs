import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-held-input-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { TrackedWin32Input } = await import(pathToFileURL(compile('main/desktop/trackedWin32Input.ts')));
  const { performWin32Input } = await import(pathToFileURL(compile('main/desktop/win32Input.ts')));
  const events = [];
  let failUp = false, failDown = false;
  const input = new TrackedWin32Input({ move: (x, y) => events.push(['move', x, y]), send: batch => {
    const event = batch[0]; events.push(event);
    if (event.kind === 'key' && (event.flags & 2) && failUp) throw new Error('release failed');
    if (event.kind === 'key' && !(event.flags & 2) && failDown) throw new Error('partial native down');
  } });
  await performWin32Input(input, { action: 'type', text: '中' });
  assert.deepEqual(events, [{ kind: 'key', scan: 0x4e2d, flags: 4 }, { kind: 'key', scan: 0x4e2d, flags: 6 }]);
  await input.releaseAll();
  assert.equal(events.length, 2, 'completed input must not release unrelated keys');
  events.length = 0;
  input.send([{ kind: 'key', vk: 17, flags: 0 }]);
  input.send([{ kind: 'mouse', flags: 2 }]);
  await input.releaseAll();
  assert.deepEqual(events.slice(-2), [{ kind: 'key', vk: 17, flags: 2 }, { kind: 'mouse', flags: 4 }]);
  input.send([{ kind: 'key', vk: 17, flags: 2 }]);
  input.send([{ kind: 'mouse', flags: 4 }]);
  assert.equal(events.length, 4, 'a late finally must not release the same press twice');
  events.length = 0;
  failDown = true;
  assert.throws(() => input.send([{ kind: 'key', vk: 65, flags: 0 }]), /partial native down/);
  failDown = false; failUp = true;
  await assert.rejects(input.releaseAll(), /held-input release failed/);
  failUp = false;
  await input.releaseAll();
  assert.deepEqual(events, [{ kind: 'key', vk: 65, flags: 0 }, { kind: 'key', vk: 65, flags: 2 }, { kind: 'key', vk: 65, flags: 2 }]);
  await input.releaseAll();
  assert.equal(events.length, 3, 'a successfully released key is removed from the held set');
  assert.throws(() => input.send([{ kind: 'key', vk: 1 }, { kind: 'key', vk: 2 }]), /one event/);
  console.log('tracked Win32 input: uncertain down, release retry and duplicate suppression passed');
} finally { removeWorkspaceFixture(temp, 'desktop-held-input-'); }
