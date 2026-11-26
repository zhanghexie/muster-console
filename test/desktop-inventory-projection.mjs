import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-projection-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { projectDesktopMetadata } = await import(pathToFileURL(compile('main/desktop/inventoryProjection.ts')));
  const common = { title: 'Window', pid: 5, bounds: { x: -20, y: 10, width: 800, height: 600 }, limitations: ['window_incarnation_unverified'] };
  const fixtures = [
    ['windows', { ...common, nativeHandle: '0xdeadbeef', processImage: 'app.exe', processCreated: '111', coordinateSpace: 'win32-screen-caller-dpi' }],
    ['linux-x11', { ...common, nativeHandle: '0xdeadbeef', processImage: '/bin/app', processCreated: '111', clientMachine: 'local', coordinateSpace: 'x11-root-pixels' }],
    ['macos', { ...common, nativeHandle: '3735928559', windowId: 3735928559, ownerName: 'App', coordinateSpace: 'coregraphics-screen-space' }]
  ];
  for (const [runtime, item] of fixtures) {
    const result = projectDesktopMetadata(runtime, { windows: [item], complete: true, omitted: 0, limitations: [] });
    const output = result.observations[0];
    assert.equal(output.pid, 5); assert.equal(output.bounds.x, -20);
    assert.ok(output.limitations.includes('metadata_only_not_actionable'));
    assert.equal('nativeHandle' in output, false); assert.equal('windowId' in output, false);
    assert.equal('surfaceId' in output, false);
    assert.ok(Object.values(result.capabilities).every(capability => capability.available === false));
    assert.notEqual(projectDesktopMetadata(runtime, { windows: [item], complete: true, omitted: 0, limitations: [] }).observations[0].observationId, output.observationId);
  }
  assert.throws(() => projectDesktopMetadata('fake', { windows: [], complete: true, omitted: 0, limitations: [] }), /Invalid/);
  assert.throws(() => projectDesktopMetadata('linux-wayland', { windows: [fixtures[1][1]], complete: true, omitted: 0, limitations: [] }), /Invalid/);
  assert.throws(() => projectDesktopMetadata('windows', { windows: [{ ...fixtures[0][1], bounds: { ...common.bounds, width: -1 } }], complete: true, omitted: 0, limitations: [] }), /Invalid/);
  console.log('desktop inventory projection: opaque observations and unsupported capabilities passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
