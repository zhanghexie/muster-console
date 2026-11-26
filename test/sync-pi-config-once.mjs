import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOptions, resolveSyncRoots, syncOnce } from '../scripts/sync-pi-config-once.mjs';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-sync-test-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { StorageRootResolver } = await import(pathToFileURL(compile('main/runtimeKernel/storageRootResolver.ts')).href);
  for (const [platform, home, env, expected] of [
    ['win32', 'C:\\Users\\test', { APPDATA: 'C:\\Roaming' }, 'C:\\Roaming\\muster-console'],
    ['darwin', '/Users/test', {}, '/Users/test/Library/Application Support/muster-console'],
    ['linux', '/home/test', { XDG_CONFIG_HOME: '/config' }, '/config/muster-console']
  ]) assert.equal(resolveSyncRoots({}, { storageDirectory: 'muster-console', platform, home, env }).userDataRoot, expected);
  assert.throws(() => parseOptions(['--user-data-root']), /Expected/);
  assert.throws(() => parseOptions(['--other', 'x']), /Expected/);
  assert.throws(() => parseOptions(['--pi-agent-root', path.join(temp, 'pi')]), /Expected --user-data-root PATH/);
  const explicit = parseOptions(['--user-data-root', temp]);
  const roots = resolveSyncRoots(explicit, { storageDirectory: 'muster-console', home: temp });
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ llm: { selected: 'arbitrary-provider' } }));
  let calls = 0;
  const result = syncOnce(roots, { StorageRootResolver, syncPiConfigFromApp(config, target) {
    calls++; assert.equal(config.llm.selected, 'arbitrary-provider'); assert.equal(target, path.join(temp, 'muster-core'));
    return { providerId: 'arbitrary-provider', modelId: 'model', providers: ['arbitrary-provider'], agentDir: target, secret: 'never-print' };
  } });
  assert.equal(calls, 1); assert.equal(result.providerId, 'arbitrary-provider'); assert.equal('secret' in result, false);
  let reads = 0;
  assert.throws(() => syncOnce({ ...roots, appDataRoot: temp, userDataRoot: path.join(temp, 'metaagent-workbench') }, {
    StorageRootResolver, readFile() { reads++; throw new Error('must not read'); }, syncPiConfigFromApp() { throw new Error('must not sync'); }
  }), /legacy product storage/);
  assert.equal(reads, 0);
  console.log('Muster Core one-shot sync: cross-platform roots, private destination, legacy refusal and safe summary passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
