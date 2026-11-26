import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-shortcuts-'));
try {
  const outfile = path.join(dir, 'shared.cjs');
  await build({ entryPoints: ['src/shared/systemShortcuts.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
  const { systemShortcutKeys, normalizeSystemShortcuts, formatSystemShortcut } = createRequire(import.meta.url)(outfile);
  assert.deepEqual(systemShortcutKeys('Win+Shift+S'), [0x10, 0x5b, 0x53]);
  assert.deepEqual(systemShortcutKeys('Ctrl+Alt+A'), [0x11, 0x12, 0x41]);
  assert.deepEqual(systemShortcutKeys('F24'), [0x87]);
  assert.deepEqual(systemShortcutKeys('PrintScreen'), [0x2c]);
  for (const input of ['a', 'Ctrl', 'Ctrl+evil()', 'F25', 'Ctrl+A;calc', 'Ctrl+A+B']) assert.equal(systemShortcutKeys(input), null);
  const row = { id: 'one', name: ' 截图 ', chord: 'Win+Shift+S' };
  assert.deepEqual(normalizeSystemShortcuts([row, row, null, { ...row, id: 'bad', chord: 'evil' }]), [{ id: 'one', name: '截图', chord: 'shift+meta+s' }]);
  assert.equal(formatSystemShortcut('meta+shift+5', 'MacIntel'), 'Shift+Cmd+5');
  assert.equal(formatSystemShortcut('meta+shift+s', 'Linux x86_64'), 'Shift+Super+S');
  assert.equal(formatSystemShortcut('meta+shift+s', 'Win32'), 'Shift+Win+S');

  const commandsFile = path.join(dir, 'commands.cjs');
  await build({ entryPoints: ['src/main/systemShortcutCommand.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: commandsFile });
  const { unixShortcutCommand: command } = createRequire(import.meta.url)(commandsFile);
  assert.deepEqual(command('Cmd+Shift+5', 'darwin', {}).args, ['-e', 'tell application "System Events" to keystroke "5" using {shift down, command down}']);
  assert.match(command('Ctrl+Alt+F20', 'darwin', {}).args[1], /key code 90 using \{control down, option down\}/);
  assert.throws(() => command('F24', 'darwin', {}), /macOS/);
  assert.deepEqual(command('Super+Shift+S', 'linux', { DISPLAY: ':1' }).args, ['key', '--clearmodifiers', 'shift+super+s']);
  assert.deepEqual(command('PrintScreen', 'linux', { DISPLAY: ':1' }).args, ['key', '--clearmodifiers', 'Print']);
  const wayland = command('Ctrl+Alt+A', 'linux', { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' });
  assert.equal(wayland.file, 'ydotool');
  assert.deepEqual(wayland.args, ['key', '29:1', '56:1', '30:1', '30:0', '56:0', '29:0']);
  for (const [chord, code] of [['F10',68], ['F11',87], ['F12',88], ['F13',183], ['F24',194], ['PrintScreen',99]]) {
    assert.deepEqual(command(chord, 'linux', { WAYLAND_DISPLAY: 'wayland-0' }).args, ['key', `${code}:1`, `${code}:0`]);
  }
  assert.throws(() => command('Ctrl+A;calc', 'darwin', {}), /不支持/);
  assert.throws(() => command('F9', 'linux', {}), /图形会话/);
  assert.throws(() => command('F9', 'freebsd', {}), /不支持/);

  const senderFile = path.join(dir, 'sender.cjs');
  await build({ entryPoints: ['src/main/systemShortcuts.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: senderFile });
  const { createSystemShortcutSender } = createRequire(import.meta.url)(senderFile);
  for (const [platform, env, executable] of [['win32', {}, 'powershell.exe'], ['darwin', {}, '/usr/bin/osascript'], ['linux', { DISPLAY: ':0' }, 'xdotool'], ['linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'ydotool']]) {
    const calls = [];
    const send = createSystemShortcutSender(platform, env, async spec => { calls.push(spec); });
    assert.deepEqual(await send('Ctrl+Alt+A'), { ok: true });
    assert.equal(calls[0].file, executable);
    assert.equal((await send('invalid')).ok, false);
    assert.equal(calls.length, 1);
    const fail = createSystemShortcutSender(platform, env, async () => { throw new Error('permission denied'); });
    assert.equal((await fail('Ctrl+Alt+A')).ok, false);
    const error = (await fail('Ctrl+Alt+A')).error;
    assert.match(error, /permission denied/);
    assert.ok(error.includes(platform === 'darwin' ? '辅助功能' : platform === 'linux' ? executable : '权限'));
  }
  let finish;
  const send = createSystemShortcutSender('darwin', {}, () => new Promise(resolve => { finish = resolve; }));
  const pending = send('Cmd+Shift+5');
  assert.match((await send('Cmd+Shift+5')).error, /正在发送/);
  finish(); await pending;
  console.log('system shortcuts validation passed');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
