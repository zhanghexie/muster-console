import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-x11-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { parseX11WindowList, parseLinuxProcessStart, enumerateLinuxX11Windows } = await import(pathToFileURL(compile('main/desktop/x11Inventory.ts')));
  const output = [
    '0x01200001  0 1234 -120 10 800 600 local Desktop window',
    '0x01200002 -1 0 0 0 200 100 remote Untitled',
    '0x01200001  0 1234 0 0 20 20 local duplicate',
    'malformed row'
  ].join('\n');
  const parsed = parseX11WindowList(output);
  assert.equal(parsed.candidates.length, 2); assert.equal(parsed.omitted, 2);
  assert.deepEqual(parsed.candidates[0].bounds, { x: -120, y: 10, width: 800, height: 600 });
  assert.equal(parsed.candidates[1].pid, null);
  assert.equal(parseX11WindowList(output, 1).truncated, true);
  assert.throws(() => parseX11WindowList(output, 0), /Invalid/);
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = '123456';
  assert.equal(parseLinuxProcessStart(`1234 (a process ) with parens) ${fields.join(' ')}`), '123456');
  assert.throws(() => parseLinuxProcessStart('broken'), /Invalid/);
  let calls = 0;
  const options = { platform: 'linux', env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, hostname: 'local',
    run: async executable => { calls++; assert.equal(executable, '/usr/bin/wmctrl'); return output; },
    identify: async pid => pid === 1234 ? { image: '/usr/bin/app', created: '100' } : null };
  const result = await enumerateLinuxX11Windows(options);
  assert.equal(calls, 1); assert.equal(result.complete, false); assert.equal(result.omitted, 2);
  assert.equal(result.windows[0].processImage, '/usr/bin/app');
  assert.ok(result.windows[0].limitations.includes('x11_pid_client_asserted'));
  assert.ok(result.windows[0].limitations.includes('window_incarnation_unverified'));
  assert.ok(result.windows[1].limitations.includes('remote_or_unknown_client_machine'));
  assert.ok(result.windows[1].limitations.includes('process_identity_unavailable'));
  await assert.rejects(enumerateLinuxX11Windows({ ...options, env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } }), /Wayland/);
  assert.equal(calls, 1);
  await assert.rejects(enumerateLinuxX11Windows({ ...options, env: { XDG_SESSION_TYPE: 'x11' } }), /DISPLAY/);
  await assert.rejects(enumerateLinuxX11Windows({ ...options, limit: 0 }), /Invalid window inventory limit/);
  assert.equal(calls, 1);
  await assert.rejects(enumerateLinuxX11Windows({ ...options, platform: 'win32' }), /unavailable/);
  await assert.rejects(enumerateLinuxX11Windows({ ...options, executable: 'wmctrl' }), /absolute path/);
  await assert.rejects(enumerateLinuxX11Windows({ ...options, run: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), /install/);
  console.log('desktop X11 inventory: protocol, identity limits, Wayland separation and error paths passed; no Linux native test');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
