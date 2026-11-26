/** Backend roots carry the same worker identity; PID reuse and missing WMIC never change it. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pid-scope-'));
const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
const pidMap = await import(pathToFileURL(compile('main/inboundMcp/pidMap.ts')));
const { resolveIdentityByPidWalk } = await import(pathToFileURL(compile('shared/inboundMcp.ts')));
const env = { MUSTER_SESSION_TOKEN: 'fixture-token', MUSTER_STATUS_URL: 'http://fixture/status', MUSTER_TOOL_URL: 'http://fixture/tool' };
try {
  const release = pidMap.bindSessionProcessRoots('worker', [1234, 1234], env, tmp);
  const identity = resolveIdentityByPidWalk(2000, 1234, pid => pidMap.readInboundMcpPidRecord(pid, tmp), () => { throw Error('direct backend root must resolve without ancestry commands'); });
  assert.equal(identity.sessionId, 'worker'); assert.equal(identity.token, env.MUSTER_SESSION_TOKEN);
  const newer = { ...pidMap.readInboundMcpPidRecord(1234, tmp), sessionId: 'new-worker', token: 'new-token' };
  pidMap.writeInboundMcpPidRecord(newer, tmp);
  release();
  assert.equal(pidMap.readInboundMcpPidRecord(1234, tmp).sessionId, 'new-worker', 'old lease cannot delete a newer PID binding');
  const external = pidMap.bindSessionProcessRoots('worker', [2345], env, tmp);
  fs.writeFileSync(pidMap.pidMapFile(2345, tmp), JSON.stringify({ ...newer, ptyPid: 2345 }));
  external();
  assert.equal(pidMap.readInboundMcpPidRecord(2345, tmp).sessionId, 'new-worker', 'preserve another app instance binding');
  const clean = pidMap.bindSessionProcessRoots('worker', [3456], env, tmp); clean(); clean();
  assert.equal(pidMap.readInboundMcpPidRecord(3456, tmp), null);
  assert.throws(() => pidMap.bindSessionProcessRoots('worker', [4567, -1], env, tmp), /invalid process/);
  assert.equal(pidMap.readInboundMcpPidRecord(4567, tmp), null, 'partial preparation rolls back identity files');
  assert.throws(() => pidMap.bindSessionProcessRoots('worker', [4567], {}, tmp), /no host session identity/);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalExec = childProcess.execFileSync, originalRead = fs.readFileSync;
  const calls = [];
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    childProcess.execFileSync = (file, args, options) => { calls.push({ file, args, options }); if (/wmic/i.test(file)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return '42\r\n'; };
    syncBuiltinESMExports();
    assert.equal(pidMap.parentPidOf(7), 42, 'modern Windows uses CIM when WMIC is missing');
    assert.ok(calls.at(-1).args.includes('-NoProfile')); assert.equal(calls.at(-1).options.windowsHide, true);
    assert.equal(pidMap.parentPidOf(7.5), null);
    childProcess.execFileSync = () => { throw Error('blocked by policy'); }; syncBuiltinESMExports();
    assert.equal(pidMap.parentPidOf(7), null, 'no guessed identity after permissions fail');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    childProcess.execFileSync = (file, args) => { assert.equal(file, 'ps'); assert.deepEqual(args, ['-o', 'ppid=', '-p', '7']); return '42\n'; }; syncBuiltinESMExports();
    assert.equal(pidMap.parentPidOf(7), 42);
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    fs.readFileSync = (file, ...args) => file === '/proc/7/stat' ? '7 (test with spaces) S 42 0 0' : originalRead(file, ...args);
    assert.equal(pidMap.parentPidOf(7), 42);
  } finally { childProcess.execFileSync = originalExec; fs.readFileSync = originalRead; Object.defineProperty(process, 'platform', descriptor); syncBuiltinESMExports(); }
  assert.equal(pidMap.parentPidOf(process.pid), process.ppid, 'actual local OS parent resolution');
  console.log('ok: MCP backend identity, PID reuse/rollback, Windows CIM + macOS/Linux branches');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
