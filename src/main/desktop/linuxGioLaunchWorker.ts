/**
 * Host-owned Linux helper, executed in a fresh Electron/Node process. Keeping
 * GIO out of the main process also prevents its cached XDG directories from
 * surviving a desktop-session change. The launch plan arrives only via IPC.
 */
export const LINUX_GIO_LAUNCH_WORKER_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
let phase = 'waiting', app, gio, unref, proof;
if (!process.send || !process.connected) process.exit(1);

function send(message, finish) {
  if (!process.connected || !process.send) return process.exit(1);
  try { process.send(message, error => { if (error || finish) process.exit(error ? 1 : 0); }); }
  catch { process.exit(1); }
}
function dispose() {
  if (app && unref) { try { unref(app); } catch {} app = undefined; }
}
function fail(code) { dispose(); phase = 'done'; send({ type: 'failure', code }, true); }
function matches() {
  const name = gio.func('g_desktop_app_info_get_filename', 'str', ['void *'])(app);
  if (typeof name !== 'string' || !path.posix.isAbsolute(name)) return false;
  const resolved = fs.realpathSync(name);
  if (resolved !== proof.filePath) return false;
  const fd = fs.openSync(resolved, 'r');
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > 1048576) return false;
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    return length === info.size && createHash('sha256').update(bytes.subarray(0, length)).digest('hex') === proof.sha256;
  } finally { fs.closeSync(fd); }
}

process.once('disconnect', () => { dispose(); process.exit(1); });
process.on('message', message => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('INVALID_MESSAGE');
  if (phase === 'waiting' && message.type === 'prepare') {
    if (typeof message.desktopId !== 'string' || typeof message.filePath !== 'string' ||
        typeof message.sha256 !== 'string' || typeof message.koffiPath !== 'string') return fail('INVALID_MESSAGE');
    proof = { filePath: message.filePath, sha256: message.sha256 };
    try {
      const koffi = require(message.koffiPath);
      gio = koffi.load('libgio-2.0.so.0');
      const gobject = koffi.load('libgobject-2.0.so.0');
      unref = gobject.func('g_object_unref', 'void', ['void *']);
      app = gio.func('g_desktop_app_info_new', 'void *', ['str'])(message.desktopId);
      if (!app) return fail('APP_UNAVAILABLE');
    } catch { return fail('GIO_UNAVAILABLE_OR_INVALID'); }
    try { if (!matches()) return fail('TARGET_CHANGED'); }
    catch { return fail('TARGET_CHANGED'); }
    phase = 'prepared';
    return send({ type: 'prepared' }, false);
  }
  if (phase !== 'prepared' || message.type !== 'launch') return fail('INVALID_MESSAGE');
  phase = 'launching';
  try {
    if (!matches()) return fail('TARGET_CHANGED');
    const context = gio.func('g_app_launch_context_new', 'void *', [])();
    if (!context) return fail('GIO_UNAVAILABLE_OR_INVALID');
    let launched;
    try {
      const unset = gio.func('g_app_launch_context_unsetenv', 'void', ['void *', 'str']);
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']) unset(context, key);
      launched = gio.func('g_app_info_launch', 'int', ['void *', 'void *', 'void *', 'void *'])(app, null, context, null);
    } finally { unref(context); }
    dispose(); phase = 'done';
    return send({ type: 'result', accepted: launched !== 0 }, true);
  } catch { return fail('GIO_LAUNCH_FAILED'); }
});
`;
