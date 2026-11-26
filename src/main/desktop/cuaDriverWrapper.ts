/**
 * Static host-owned bootstrap, passed to the Electron/Node executable as
 * code. It accepts the driver plan only over the private parent IPC channel,
 * after the parent has challenged this process and assigned its Windows Job.
 * Driver data and the challenge never appear in this process's arguments.
 */
export const CUA_DRIVER_WRAPPER_SOURCE = String.raw`
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
let phase = 'waiting';
if (!process.send || !process.connected) process.exit(1);
const fail = code => {
  if (!process.connected || !process.send) return process.exit(1);
  try { process.send({ type: 'driver-failed', code }, () => process.exit(1)); }
  catch { process.exit(1); }
};
process.once('disconnect', () => process.exit(1));
process.on('message', message => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('INVALID_MESSAGE');
  if (phase === 'waiting' && message.type === 'identity-challenge' &&
      typeof message.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(message.nonce)) {
    phase = 'challenged';
    try { process.send({ type: 'identity-response', nonce: message.nonce }, error => { if (error) process.exit(1); }); }
    catch { process.exit(1); }
    return;
  }
  if (phase !== 'challenged' || message.type !== 'launch') return fail('INVALID_STATE');
  phase = 'launching';
  const { command, args, env } = message;
  if (typeof command !== 'string' || !path.isAbsolute(command) || command.includes('\0') || command.length > 32767 ||
      !Array.isArray(args) || args.length > 32 || args.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 8192) ||
      !env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 512 ||
      Object.entries(env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') ||
        typeof value !== 'string' || value.includes('\0') || value.length > 32767)) return fail('INVALID_LAUNCH');
  let driver;
  try { driver = spawn(command, args, { env, stdio: 'pipe', windowsHide: true, shell: false }); }
  catch (error) { return fail(/^[A-Z0-9_]{1,32}$/.test(error.code || '') ? error.code : 'SPAWN_FAILED'); }
  driver.once('error', error => fail(/^[A-Z0-9_]{1,32}$/.test(error.code || '') ? error.code : 'SPAWN_FAILED'));
  driver.once('spawn', () => {
    phase = 'running';
    process.stdin.pipe(driver.stdin);
    driver.stdout.pipe(process.stdout);
    driver.stderr.pipe(process.stderr, { end: false });
    for (const stream of [process.stdin, process.stdout, process.stderr, driver.stdin, driver.stdout, driver.stderr]) {
      stream.once('error', () => fail('PIPE_FAILED'));
    }
    try { process.send({ type: 'driver-started' }, error => { if (error) process.exit(1); }); }
    catch { process.exit(1); }
  });
  driver.once('exit', () => {
    if (!process.connected || !process.send) return process.exit(1);
    try { process.send({ type: 'driver-exited' }, () => process.exit(1)); }
    catch { process.exit(1); }
  });
});
try { process.send({ type: 'wrapper-ready' }, error => { if (error) process.exit(1); }); }
catch { process.exit(1); }
`;
