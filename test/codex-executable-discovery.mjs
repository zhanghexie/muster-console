/**
 * Codex GUI 用户 CLI 发现：官方安装器 / npm vendor / PATH / .cmd shim / where-which。
 * 运行: node test/codex-executable-discovery.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exe-'));
const compile = createSharedCompiler(root, tmp);
const sdk = await import(pathToFileURL(compile('main/agentSession/drivers/codex/executable.ts')).href);

const officialExe = 'C:\\local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
const officialBare = 'C:\\local\\Programs\\OpenAI\\Codex\\bin\\codex';
const npmExe = 'C:\\roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const nestedNpmExe = 'C:\\roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const pathExe = 'C:\\custom\\version.123\\codex.exe';
const shim = 'C:\\roaming\\npm\\codex.cmd';
const shimSibling = 'C:\\roaming\\npm\\codex.exe';

function win(extra = {}) {
  return {
    platform: 'win32',
    arch: 'x64',
    home: 'C:\\home',
    env: { LOCALAPPDATA: 'C:\\local' },
    packaged: true,
    lookupOnPath: () => [],
    ...extra
  };
}

{
  const options = win({ isExecutable: (file) => file.toLowerCase() === officialExe.toLowerCase() });
  assert.equal(sdk.resolveUserCodexExecutable(options), officialExe);
  assert.deepEqual(await sdk.resolveCodexExecutable(options), { ok: true, executable: officialExe, packaged: true });
}

{
  const options = win({ isExecutable: (file) => file === officialBare });
  assert.equal(sdk.resolveUserCodexExecutable(options), officialBare, 'official installer extensionless variant');
}

{
  const options = win({
    env: { APPDATA: 'C:\\roaming', PATH: 'C:\\roaming\\npm' },
    isExecutable: (file) => [npmExe, shim, 'C:\\roaming\\npm\\codex'].includes(file)
  });
  assert.equal(sdk.resolveUserCodexExecutable(options), npmExe, 'npm native vendor, not the .cmd shim');
}

{
  const options = win({
    env: { APPDATA: 'C:\\roaming', LOCALAPPDATA: 'C:\\local', PATH: 'C:\\roaming\\npm;C:\\custom\\version.123' },
    isExecutable: file => [shim, nestedNpmExe, officialExe, pathExe].includes(file)
  });
  assert.equal(sdk.resolveUserCodexExecutable(options), nestedNpmExe,
    'the earlier PATH npm launcher resolves its native package before a later PATH entry or older Desktop installation');
  assert.equal(sdk.resolveUserCodexExecutable({ ...options, env: { ...options.env, PATH: 'C:\\custom\\version.123;C:\\roaming\\npm' } }), pathExe,
    'a native executable earlier on PATH keeps priority');
}

{
  const options = win({
    env: { LOCALAPPDATA: 'C:\\local', PATH: 'C:\\custom\\version.123' },
    isExecutable: (file) => [officialExe, pathExe].includes(file)
  });
  assert.equal(sdk.resolveUserCodexExecutable(options), pathExe, 'PATH wins over official dir');
}

{
  const options = win({
    env: {},
    isExecutable: (file) => file === shim
  });
  assert.equal(sdk.resolveUserCodexExecutable(options), null, 'bare .cmd is not SDK-spawnable');
}

{
  const options = win({
    env: {},
    isExecutable: (file) => file === shimSibling,
    lookupOnPath: () => [shim]
  });
  assert.equal(sdk.resolveUserCodexExecutable(options), shimSibling, 'where/which .cmd resolves sibling exe');
}

{
  const options = win({
    env: {},
    isExecutable: (file) => file === pathExe,
    lookupOnPath: () => [pathExe]
  });
  assert.equal(sdk.resolveUserCodexExecutable(options), pathExe, 'where/which fallback when candidates miss');
}

{
  assert.deepEqual(
    await sdk.resolveCodexExecutable(win({ isExecutable: () => false })),
    { ok: false, packaged: true },
    'packaged build does not fall back to SDK platform package'
  );
  assert.deepEqual(
    await sdk.resolveCodexExecutable(win({ packaged: false, isExecutable: () => false })),
    { ok: false, packaged: false }
  );
}

// Both distribution modes have the same CLI prerequisite on every supported OS.
// A positive discovery must preserve the executable override; absence never reports success.
for (const { platform, home, executable } of [
  { platform: 'win32', home: 'C:\\home', executable: 'C:\\home\\.local\\bin\\codex.exe' },
  { platform: 'darwin', home: '/Users/fixture', executable: '/Users/fixture/.local/bin/codex' },
  { platform: 'linux', home: '/home/fixture', executable: '/home/fixture/.local/bin/codex' }
]) {
  for (const packaged of [false, true]) {
    const options = { platform, home, packaged, arch: 'x64', env: {}, lookupOnPath: () => [], isExecutable: file => file === executable };
    assert.deepEqual(await sdk.resolveCodexExecutable(options), { ok: true, executable, packaged }, `${platform} packaged=${packaged}: found CLI`);
    assert.deepEqual(await sdk.resolveCodexExecutable({ ...options, isExecutable: () => false }),
      { ok: false, packaged }, `${platform} packaged=${packaged}: missing CLI`);
  }
}

{
  const bundlePath = 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const systemBundle = '/Applications/ChatGPT.app/' + bundlePath;
  const userBundle = '/Users/fixture/Applications/ChatGPT.app/' + bundlePath;
  const legacyBundle = '/Applications/Codex.app/Contents/Resources/codex';
  const onPath = '/custom/bin/codex';
  const options = { platform: 'darwin', arch: 'arm64', home: '/Users/fixture', packaged: true, env: { PATH: '/usr/bin:/bin' } };
  const resolve = (...files) => sdk.resolveUserCodexExecutable({ ...options, isExecutable: file => files.includes(file) });
  assert.equal(resolve(systemBundle), systemBundle, 'Finder PATH must find the installed ChatGPT bundle');
  assert.equal(resolve(systemBundle, userBundle), userBundle, 'per-user application bundle takes precedence');
  assert.equal(resolve(legacyBundle), legacyBundle, 'older desktop bundle layout');
  assert.equal(resolve('/opt/homebrew/bin/codex'), '/opt/homebrew/bin/codex',
    'find a standalone Homebrew install on a minimal PATH');
  assert.equal(sdk.resolveUserCodexExecutable({ ...options, env: { PATH: '/custom/bin' },
    isExecutable: file => [onPath, userBundle].includes(file) }), onPath);
  const stale = '/workbench/node_modules/.bin/codex';
  assert.equal(sdk.resolveUserCodexExecutable({ ...options,
    env: { PATH: path.posix.dirname(stale) },
    execPath: '/workbench/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    lookupOnPath: () => [stale],
    isExecutable: file => [stale, userBundle].includes(file)
  }), userBundle, 'ignore any old launcher left in the workbench dependencies');
  assert.equal(resolve('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'), null, 'the desktop app itself is not the CLI');
}

{
  const root = 'C:\\local\\OpenAI\\Codex\\bin';
  const executable = version => path.win32.join(root, version, 'codex.exe');
  const options = win({
    listDesktopVersions: dir => {
      assert.equal(dir, root);
      return [{ name: '4444444444444444', mtimeMs: 4 }, { name: '1111111111111111', mtimeMs: 2 },
        { name: 'ffffffffffffffff', mtimeMs: 1 }, { name: '..', mtimeMs: 5 }];
    },
    isExecutable: file => [executable('1111111111111111'), executable('ffffffffffffffff')].includes(file)
  });
  assert.equal(sdk.resolveUserCodexExecutable(options), executable('1111111111111111'),
    'use the newest available per-user desktop executable, skip incomplete updates');
  assert.equal(sdk.resolveUserCodexExecutable({ ...options, isExecutable: file => file === path.win32.join(root, '..', 'codex.exe') }),
    null, 'directory input cannot escape the desktop bin root');
}

{
  const options = { platform: 'linux', arch: 'x64', home: '/home/fixture', env: { PATH: '/bin' } };
  assert.equal(sdk.resolveUserCodexExecutable({ ...options, isExecutable: file => file === '/usr/local/bin/codex' }),
    '/usr/local/bin/codex', 'service launches can discover the standalone Linux CLI');
  assert.equal(sdk.resolveUserCodexExecutable({ ...options, isExecutable: () => false }), null);
}

assert.deepEqual(sdk.parseWhereWhichOutput('C:\\a\\codex.exe\r\nINFO: Could not find files for the given pattern(s).\r\n'), [
  'C:\\a\\codex.exe'
]);
assert.equal(
  sdk.resolveCodexShimToNative(shim, {
    platform: 'win32',
    join: path.win32.join,
    dirname: path.win32.dirname,
    isExecutable: (file) => file === shimSibling
  }),
  shimSibling
);
assert.equal(
  sdk.resolveCodexShimToNative(shim, {
    platform: 'win32',
    join: path.win32.join,
    dirname: path.win32.dirname,
    isExecutable: (file) => file === shim
  }),
  null
);

const owned = path.relative(os.tmpdir(), tmp);
assert(owned && !owned.startsWith('..') && !path.isAbsolute(owned));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log('ok: Codex executable discovery');
