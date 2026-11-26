import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliLaunch, findCliOnPath } from '../src/main/runtime/builtins/scripts/_native.mjs';
import { prepareCodexTui, remoteExistingTuiArgs } from '../src/main/runtime/builtins/scripts/_codex-native.mjs';
import { allocate as allocateCursor, parseCursorChatId } from '../src/main/runtime/builtins/scripts/cursor-cli.mjs';

const winApp = 'C:\\workbench\\node_modules\\electron\\dist\\electron.exe';
const winLocal = 'C:\\workbench\\node_modules\\.bin';
const winGlobal = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const winInstalled = path.win32.join(winGlobal, 'codex.cmd');
const winFiles = new Set([path.win32.join(winLocal, 'codex.cmd'), winInstalled]);
const winOptions = { platform: 'win32', execPath: winApp, pathEnv: `${winLocal};${winGlobal}`,
  pathExt: '.EXE;.CMD', isExecutable: file => winFiles.has(file) };
assert.equal(findCliOnPath('codex', winOptions), winInstalled,
  'dev Electron must skip its own transitive CLI and select the user installation');
assert.equal(cliLaunch(['codex', '--version'], winOptions).command, 'cmd.exe');
assert.match(cliLaunch(['codex', '--version'], winOptions).args.at(-1), /Roaming\\npm\\codex\.cmd/);
assert.equal(findCliOnPath('codex', { ...winOptions, pathEnv: winLocal }), null,
  'the workbench dependency alone must not count as an installed terminal CLI');
assert.throws(() => cliLaunch(['codex'], { ...winOptions, pathEnv: winLocal }),
  error => error.code === 'CLI_NOT_FOUND');

assert.deepEqual(remoteExistingTuiArgs([
  '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5', '--sandbox=read-only',
  '-c', 'approval_policy="never"', '--', 'please keep --sandbox=read-only in the prompt'
]), { args: ['--model', 'gpt-5', '--', 'please keep --sandbox=read-only in the prompt'],
  removed: ['--dangerously-bypass-approvals-and-sandbox', '--sandbox', '-c'] });
assert.throws(() => remoteExistingTuiArgs(['--sandbox']), /缺少值/);
assert.throws(() => remoteExistingTuiArgs(['--sandbox', '--model', 'gpt-5']), /缺少值/);

const makeRemoteLaunch = async (sessionId, mode = 'start') => {
  let argv;
  const executable = '/fixture/ChatGPT.app/Contents/Resources/codex';
  const owner = { child: { pid: 42 }, assertAlive() {}, dispose() {} };
  const rpc = { onNotification() {}, request: async () => ({}), notify() {}, dispose() {} };
  const launch = await prepareCodexTui({ mode, sessionId, forkFromSessionId: mode === 'fork' ? sessionId : undefined,
    cwd: process.cwd(), extraArgs: ['--dangerously-bypass-approvals-and-sandbox'], WebSocket: class {}, env: {}, executable },
    () => { throw new Error('unexpected legacy launch'); }, {
      probeCli: async ([binary]) => {
        assert.equal(binary, executable);
        return '--remote-auth-token-env --ws-token-sha256 queue';
      },
      allocatePort: async () => 59998,
      startOwner: ([binary]) => { assert.equal(binary, executable); return owner; },
      openRpc: async () => rpc,
      launchCli: input => { argv = input; return { command: input[0], args: input.slice(1) }; }
    });
  launch.dispose();
  assert.equal(launch.command, executable);
  return argv;
};
assert.ok((await makeRemoteLaunch('codex-pending-new')).includes('--dangerously-bypass-approvals-and-sandbox'),
  'new remote threads still receive the configured permission');
const resumed = await makeRemoteLaunch('12345678-1234-1234-1234-123456789abc');
assert.ok(resumed.includes('resume'));
assert.ok(!resumed.includes('--dangerously-bypass-approvals-and-sandbox'),
  '0.166 remote resume must use the saved thread policy without a TUI override');
const forked = await makeRemoteLaunch('12345678-1234-1234-1234-123456789abc', 'fork');
assert.ok(forked.includes('fork'));
assert.ok(!forked.includes('--dangerously-bypass-approvals-and-sandbox'),
  'remote fork must also inherit permissions without a TUI override');

for (const platform of ['darwin', 'linux']) {
  const app = platform === 'darwin'
    ? '/workbench/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    : '/workbench/node_modules/electron/dist/electron';
  const local = '/workbench/node_modules/.bin';
  const installed = '/home/me/.local/bin';
  const options = { platform, execPath: app, pathEnv: `${local}:${installed}`,
    isExecutable: file => file === `${local}/codex` || file === `${installed}/codex` };
  assert.equal(findCliOnPath('codex', options), `${installed}/codex`, `${platform}: skip app bin`);
  assert.deepEqual(cliLaunch(['codex', '--version'], options),
    { command: `${installed}/codex`, args: ['--version'] });
}

const discovery = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-cli-discovery-'));
try {
  const missing = path.join(discovery, 'missing');
  const installed = path.join(discovery, 'installed');
  fs.mkdirSync(missing); fs.mkdirSync(installed);
  const file = path.join(installed, process.platform === 'win32' ? 'review-probe.cmd' : 'review-probe');
  const options = { pathEnv: [missing, installed].join(path.delimiter), pathExt: '.CMD' };
  assert.equal(findCliOnPath('review-probe', options), null);
  fs.writeFileSync(file, 'fixture');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  assert.equal(findCliOnPath('review-probe', options), file, 'a later installation must not be hidden by a negative cache');
  fs.unlinkSync(file);
  assert.equal(findCliOnPath('review-probe', options), null, 'removing the executable is visible immediately');
} finally { fs.rmSync(discovery, { recursive: true, force: true }); }

const chatId = '12345678-1234-1234-1234-123456789abc';
assert.equal(parseCursorChatId(`Cursor Agent ready\n${chatId}\n`), chatId);
for (const output of ['', 'Update available', 'Updated successfully\nRestart Cursor Agent',
  'https://cursor.com/install']) {
  assert.throws(() => parseCursorChatId(output), /未返回有效 chatId/,
    'update/status text must never become a resumable Cursor session ID');
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-update-output-'));
const oldPath = process.env.PATH;
try {
  const command = path.join(fixture, process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent');
  fs.writeFileSync(command, process.platform === 'win32' ? '@echo off\r\necho Update available\r\n'
    : '#!/bin/sh\necho Update available\n');
  if (process.platform !== 'win32') fs.chmodSync(command, 0o755);
  process.env.PATH = `${fixture}${path.delimiter}${oldPath ?? ''}`;
  await assert.rejects(allocateCursor(), /未返回有效 chatId/,
    'an updater stdout message must stop allocation before an empty terminal is launched');
} finally {
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('builtin-cli-resolution: path isolation and Cursor chat ID checks passed');
