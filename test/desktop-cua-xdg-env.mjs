import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-cua-xdg-env-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { CuaTransport } = await import(pathToFileURL(compile('main/desktop/cuaTransport.ts')));
  let received;
  const environment = { XDG_DATA_HOME: '/home/test/custom-apps', XDG_DATA_DIRS: '/opt/apps:/usr/share',
    XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', LANG: 'zh_CN.UTF-8', LC_MESSAGES: 'en_US.UTF-8',
    SECRET: 'not forwarded', CUA_DRIVER_RS_TELEMETRY_ENABLED: '1' };
  new CuaTransport(path.resolve('driver'), environment, options => {
    received = options.env;
    return { client: {}, transport: {} };
  });
  assert.equal(received.XDG_DATA_HOME, environment.XDG_DATA_HOME);
  assert.equal(received.XDG_DATA_DIRS, environment.XDG_DATA_DIRS);
  assert.equal(received.LANG, environment.LANG);
  assert.equal(received.LC_MESSAGES, environment.LC_MESSAGES);
  assert.equal(received.CUA_DRIVER_RS_ENABLE_WAYLAND, '1');
  assert.equal(received.CUA_DRIVER_RS_TELEMETRY_ENABLED, '0');
  assert.equal(received.SECRET, undefined);
  for (const [input, enabled] of [
    [{ XDG_SESSION_TYPE: ' x11 ', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, undefined],
    [{ XDG_SESSION_TYPE: ' x11 ', DISPLAY: ':0' }, undefined],
    [{ XDG_SESSION_TYPE: ' WAYLAND ', WAYLAND_DISPLAY: 'wayland-0' }, '1'],
    [{ WAYLAND_DISPLAY: '   ', DISPLAY: ':0' }, undefined],
    [{ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, '1']
  ]) {
    let projected;
    new CuaTransport(path.resolve('driver'), input, options => {
      projected = options.env;
      return { client: {}, transport: {} };
    });
    assert.equal(projected.CUA_DRIVER_RS_ENABLE_WAYLAND, enabled, 'Wayland selection must match host session detection');
  }
  console.log('Cua transport: Linux XDG/locale environment is forwarded without unrelated variables');
} finally { removeWorkspaceFixture(temp, 'desktop-cua-xdg-env-'); }
