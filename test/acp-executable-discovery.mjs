/** ACP 可执行查找回归：宿主旧 PATH、npm 安装目录、绝对路径、引号目录与 .cmd 真执行。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-discovery-'));
const compile = createSharedCompiler(root, tmp);
const { lookOnPath, resolveAcpLaunch, defaultAcpAgentId, antigravityWindowsInstallCandidates, wrapCmdShimIfNeeded } =
  await import(pathToFileURL(compile('main/agentSession/drivers/acp/agents.ts')).href);
const { cliOnPath } = await import(pathToFileURL(compile('main/runtime/preflight.ts')).href);
const saved = Object.fromEntries(['PATH', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA'].map((k) => [k, process.env[k]]));
try {
  process.env.PATH = '';
  process.env.APPDATA = path.join(tmp, 'roaming');
  process.env.LOCALAPPDATA = path.join(tmp, 'local');
  const absolute = path.join(tmp, 'custom.exe');
  fs.writeFileSync(absolute, 'fixture', { mode: 0o700 });
  assert.equal(lookOnPath([absolute]), absolute, 'PATH 为空仍能找绝对路径');
  assert.equal(lookOnPath([tmp]), null, '目录不能误判可执行文件');

  if (process.platform === 'win32') {
    const cursor = path.join(process.env.LOCALAPPDATA, 'cursor-agent', 'cursor-agent.cmd');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(cursor, '@echo off\r\necho %*\r\n');
    const cursorLaunch = resolveAcpLaunch('cursor', { args: ['--add-dir', 'other root', 'acp'] });
    assert.equal(cursorLaunch.command, 'cmd.exe', 'Cursor 官方安装目录在旧 PATH 下仍可发现');
    assert.equal(cursorLaunch.executable, cursor);
    assert.match(cursorLaunch.args[3], /--add-dir "other root" acp/, 'Cursor 额外目录参数经 Windows shim 保留');
    const qwen = path.join(process.env.LOCALAPPDATA, 'qwen-code', 'bin', 'qwen.cmd');
    fs.mkdirSync(path.dirname(qwen), { recursive: true });
    fs.writeFileSync(qwen, '@echo off\r\necho %*\r\n');
    const qwenLaunch = resolveAcpLaunch('qwen');
    assert.equal(qwenLaunch.command, 'cmd.exe', 'Qwen 官方安装目录在旧 PATH 下仍可发现');
    assert.equal(qwenLaunch.executable, qwen);
    const native = path.join(process.env.APPDATA, 'npm/node_modules/opencode-ai/bin/opencode.exe');
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, 'fixture');
    assert.equal(resolveAcpLaunch('opencode').command, native, '旧 GUI PATH 应像 opencode 终端一样探测 npm 安装目录');
    assert.equal(cliOnPath(native), true, '终端与 ACP 对同一原生路径均 available');
    assert.equal(defaultAcpAgentId(), 'opencode');
    const localNative = path.join(process.env.LOCALAPPDATA, 'npm/node_modules/opencode-ai/bin/opencode.exe');
    fs.mkdirSync(path.dirname(localNative), { recursive: true });
    fs.renameSync(native, localNative);
    assert.equal(resolveAcpLaunch('opencode').command, localNative, 'LOCALAPPDATA 前缀也可发现');

    const bin = path.join(tmp, 'version.1 bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'opencode.cmd'), '@echo off\r\necho %*\r\n');
    process.env.PATH = `"${bin}"`;
    process.env.PATHEXT = '.EXE;.CMD;.BAT';
    const launch = resolveAcpLaunch('opencode');
    assert.equal(launch.command, 'cmd.exe', 'PATH 优先，.cmd 经 cmd.exe 执行');
    const spawnEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    spawnEnv.PATH = saved.PATH;
    const run = spawnSync(launch.command, launch.args, { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, env: spawnEnv });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    assert.equal(run.stdout.trim(), 'acp', '真实 shim 启动 argv 保真且无 chcp 输出污染 NDJSON');
    assert.match(resolveAcpLaunch('opencode', undefined, [{ id: 'opencode', name: 'Custom', commands: ['missing-custom'], args: [] }]).error, /Cannot find Custom/, '用户覆盖不得回落内置安装目录');
  } else {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const command = path.join(bin, 'opencode');
    fs.writeFileSync(command, 'fixture', { mode: 0o755 });
    process.env.PATH = bin;
    assert.equal(resolveAcpLaunch('opencode').command, command);
    assert.equal(cliOnPath('opencode'), true);
  }

  const agyBin = path.join(tmp, 'agy PATH bin');
  const agyHome = path.join(tmp, 'agy home');
  const windows = process.platform === 'win32';
  const launchFile = windows ? 'agy.exe' : 'agy';
  const legacy = path.join(agyBin, windows ? 'agy_acp_server.exe' : 'agy_acp_server.par');
  const byPath = path.join(agyBin, launchFile);
  const installed = windows ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', launchFile)
    : path.join(agyHome, '.local', 'bin', launchFile);
  mock.method(os, 'homedir', () => agyHome);
  const statSync = fs.statSync;
  mock.method(fs, 'statSync', (file, ...options) => {
    if (typeof file === 'string' && !file.startsWith(tmp + path.sep)) throw new Error('Outside the test installation');
    return statSync(file, ...options);
  });
  fs.mkdirSync(agyBin);
  fs.writeFileSync(byPath, 'fixture', { mode: 0o755 });
  fs.writeFileSync(legacy, 'fixture', { mode: 0o755 });
  process.env.PATH = agyBin;
  const pathLaunch = resolveAcpLaunch('antigravity');
  const expectedPath = fs.realpathSync.native(byPath);
  assert.deepEqual({
    ...pathLaunch,
    command: fs.realpathSync.native(pathLaunch.command),
    executable: fs.realpathSync.native(pathLaunch.executable)
  }, { command: expectedPath, executable: expectedPath, args: ['acp'] });

  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.renameSync(byPath, installed);
  assert.deepEqual(resolveAcpLaunch('antigravity'), { command: installed, executable: installed, args: ['acp'] },
    'Antigravity 官方目录在旧 PATH 下仍使用新版 CLI');
  assert.deepEqual(resolveAcpLaunch('antigravity', { command: legacy }), { command: legacy, executable: legacy, args: [] });
  fs.unlinkSync(installed);
  assert.deepEqual(resolveAcpLaunch('antigravity'), { command: legacy, executable: legacy, args: [] },
    '独立 ACP 服务保持原有参数');
  fs.unlinkSync(legacy);
  assert.match(resolveAcpLaunch('antigravity').error, /Cannot find Antigravity executable \(agy\//);
  const localAppData = 'C:\\Users\\Test User\\AppData\\Local';
  const [nativeAgy] = antigravityWindowsInstallCandidates('win32', localAppData);
  assert.equal(nativeAgy, `${localAppData}\\agy\\bin\\agy.exe`);
  assert.deepEqual(wrapCmdShimIfNeeded(nativeAgy, ['acp'], 'win32'), { command: nativeAgy, executable: nativeAgy, args: ['acp'] });
  assert.deepEqual(antigravityWindowsInstallCandidates('win32'), []);
  for (const platform of ['darwin', 'linux']) assert.deepEqual(antigravityWindowsInstallCandidates(platform, localAppData), []);
} finally {
  mock.restoreAll();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.ok(tmp.startsWith(os.tmpdir() + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('ok   acp-executable-discovery');
