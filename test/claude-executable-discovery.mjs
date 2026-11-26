import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-executable-'));
try {
  const compile = createSharedCompiler(process.cwd(), tmp);
  const { resolveUserClaudeExecutable, resolveClaudeExecutable } =
    await import(pathToFileURL(compile('main/agentSession/drivers/claude/claudeSdk.ts')));

  for (const platform of ['darwin', 'linux']) {
    const home = '/home/user';
    const first = '/custom bin/claude';
    const second = '/second/bin/claude';
    const local = path.posix.join(home, '.local/bin/claude');
    const system = platform === 'darwin' ? '/opt/homebrew/bin/claude' : '/usr/bin/claude';
    const options = { platform, home, env: { PATH: 'relative-bin:"/custom bin":/second/bin' } };
    const resolve = (...files) => resolveUserClaudeExecutable({ ...options, isExecutable: file => files.includes(file) });
    assert.equal(resolve(first, second, local), first, `${platform}: PATH takes precedence over conventional installs`);
    assert.equal(resolve(second, local), second, `${platform}: keep searching PATH if the first CLI is unusable`);
    assert.equal(resolve(local, system), local);
    assert.equal(resolve(system), system, `${platform}: discover package-manager install with a limited PATH`);
    assert.equal(resolve('relative-bin/claude'), null, 'the SDK must receive an absolute path');
  }

  {
    const home = 'C:\\Users\\Fixture';
    const appData = path.win32.join(home, 'AppData', 'Roaming');
    const localAppData = path.win32.join(home, 'AppData', 'Local');
    const prefix = 'D:\\Custom npm';
    const shim = path.win32.join(prefix, 'claude.cmd');
    const npmPackage = path.win32.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
    const native = path.win32.join(npmPackage, 'bin', 'claude.exe');
    const js = path.win32.join(npmPackage, 'cli.js');
    const later = 'E:\\Tools\\claude.exe';
    const local = path.win32.join(home, '.local', 'bin', 'claude.exe');
    const winget = path.win32.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe');
    const global = path.win32.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const options = { platform: 'win32', home, env: { Path: `"${prefix}";E:\\Tools`, AppData: appData, LocalAppData: localAppData } };
    const resolve = (...files) => resolveUserClaudeExecutable({ ...options, isExecutable: file => files.includes(file) });
    assert.equal(resolve(shim, native, js, later, local), native, 'resolve npm shim in the first PATH directory');
    assert.equal(resolve(shim, js, later), js, 'recognize an older npm JS entry');
    assert.equal(resolve(shim, later), later, 'skip a shim whose installation disappeared');
    assert.equal(resolve(local, global), local);
    assert.equal(resolve(global), global, 'preserve the roaming npm fallback');
    assert.equal(resolve(winget), winget, 'find WinGet when PATH has not picked up its links yet');
    assert.equal(resolve(shim), null, 'a .cmd cannot be passed directly to the SDK');
  }

  const bin = path.join(tmp, 'user bin');
  const invalidBin = path.join(tmp, 'invalid bin');
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const executable = path.join(bin, name);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(invalidBin, name), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const options = { home: tmp, env: { PATH: [invalidBin, bin].join(path.delimiter) }, packaged: true };
  assert.deepEqual(await resolveClaudeExecutable(options), { ok: true, packaged: true, executable });
  assert.deepEqual(await resolveClaudeExecutable({ ...options, packaged: false }), { ok: true, packaged: false, executable });
  if (process.platform !== 'win32') {
    fs.chmodSync(executable, 0o644);
    assert.notEqual(resolveUserClaudeExecutable(options), executable, 'a regular file must also be executable');
  }
  const missing = { ...options, isExecutable: () => false };
  assert.deepEqual(await resolveClaudeExecutable(missing), { ok: false, packaged: true });
  assert.deepEqual(await resolveClaudeExecutable({ ...missing, packaged: false }), { ok: true, packaged: false });

  fs.chmodSync(executable, 0o755);
  const { probeClaudeGuiStatus } = await import(pathToFileURL(compile('main/agentSession/drivers/claude/status.ts')));
  const before = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  try {
    process.env.PATH = bin;
    process.env.CLAUDE_CONFIG_DIR = tmp;
    const status = await probeClaudeGuiStatus({ config: { get: () => ({}) } }, tmp);
    assert.equal(status.canLaunch, true);
    assert.equal(status.executable, executable, 'GUI status reports the same PATH executable that the SDK will use');
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log('Claude executable discovery: PATH, package-manager installs, invalid candidates, and build fallback');
