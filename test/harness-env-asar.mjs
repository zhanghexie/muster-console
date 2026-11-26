import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const temp = fs.mkdtempSync(path.join(tempRoot, 'harness-env-asar-'));
try {
  const output = path.join(temp, 'harness-env.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/main/agentSession/drivers/win32/harnessEnv.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { toUnpackedAsarPath, withWin32HiddenConsole } = createRequire(import.meta.url)(output);
  for (const file of [
    'C:\\Program Files\\MetaAgent\\resources\\app.asar\\out\\main\\preload.cjs',
    '/Applications/MetaAgent.app/Contents/Resources/app.asar/out/main/preload.cjs',
    '/opt/metaagent/resources/app.asar/out/main/preload.cjs'
  ]) {
    const expected = file.replace('app.asar', 'app.asar.unpacked');
    assert.equal(toUnpackedAsarPath(file), expected);
    assert.equal(toUnpackedAsarPath(expected), expected);
  }
  const env = { NODE_OPTIONS: '--enable-source-maps' };
  for (const platform of ['darwin', 'linux']) assert.deepEqual(withWin32HiddenConsole(env, { preloadPath: '/preload.cjs', platform }), env);
  const windows = withWin32HiddenConsole(env, { preloadPath: path.join(temp, 'path with spaces', 'app.asar', 'preload.cjs'), platform: 'win32' });
  assert.match(windows.NODE_OPTIONS, /^--enable-source-maps --require ".*app\.asar\.unpacked\/preload\.cjs"$/);
  console.log('harness environment: shared asar conversion and platform branches passed');
} finally {
  const resolved = fs.realpathSync(temp);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('harness-env-asar-')) throw new Error('Refusing to remove an unexpected temporary directory');
  fs.rmSync(resolved, { recursive: true, force: true });
}
