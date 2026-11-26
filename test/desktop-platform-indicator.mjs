import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-platform-indicator-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createPlatformIndicator } = await import(pathToFileURL(compile('main/desktop/platformIndicator.ts')));
  let windowCalls = 0, waylandCalls = 0, registered = 0, input;
  const indicator = { async show() {}, close() {} };
  const base = { mainDir: temp, preloadPath: path.join(temp, 'preload.js'), rendererPath: temp,
    stop: async () => {}, unavailable() {},
    createWindow: () => { windowCalls++; return { ...indicator, registerIpc() { registered++; } }; },
    resolvePython: () => '/usr/bin/python3',
    createWayland: options => { waylandCalls++; input = options; return indicator; } };
  for (const [platform, env] of [['win32', {}], ['darwin', {}], ['linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }]]) {
    assert.ok(createPlatformIndicator({ ...base, platform, env }));
  }
  assert.equal(windowCalls, 3); assert.equal(registered, 3); assert.equal(waylandCalls, 0);
  const env = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' };
  assert.equal(createPlatformIndicator({ ...base, platform: 'linux', env }), indicator);
  assert.equal(waylandCalls, 1); assert.equal(input.pythonPath, '/usr/bin/python3'); assert.equal(input.env, env);
  assert.equal(input.helperPath, path.join(temp, 'desktop', 'waylandStopHelper.py'));
  for (const [platform, value] of [['freebsd', {}], ['linux', {}],
    ['linux', { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }]]) {
    assert.throws(() => createPlatformIndicator({ ...base, platform, env: value }), /graphical session/);
  }
  assert.throws(() => createPlatformIndicator({ ...base, mainDir: 'relative', platform: 'win32' }), /host dependencies/);
  assert.throws(() => createPlatformIndicator({ ...base, platform: 'linux', env, resolvePython: () => { throw new Error('Python missing'); } }), /Python missing/);
  assert.equal(waylandCalls, 1, 'a missing dependency cannot silently fall back to an Electron overlay');
  console.log('Desktop platform indicator: Windows/macOS/X11 and Wayland selection, session and dependency failures passed (mocked)');
} finally { removeWorkspaceFixture(temp, 'desktop-platform-indicator-'); }
