import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-adapter-config-'));
try {
  const compile = createSharedCompiler(process.cwd(), tmp);
  const load = name => import(pathToFileURL(compile(`main/agentSession/drivers/${name}`)));
  const { claudeNativeConfig } = await load('claude/nativeConfig.ts');
  const { externalPiNativeConfig } = await load('externalPi/nativeConfig.ts');
  const { museNativeConfig, readMuseProfiles } = await load('muse/nativeConfig.ts');
  const { zcodeNativeConfig } = await load('zcode/nativeConfig.ts');
  const { NdjsonRpcResponseError } = await load('acp/jsonRpc.ts');

  const claude = claudeNativeConfig('dontAsk');
  assert.equal(claude.options[0].currentValue, 'dontAsk');
  assert.equal(claudeNativeConfig().options[0].currentValue, undefined);
  assert.equal(claude.options[0].choices.find(choice => choice.value === 'bypassPermissions').launchOnly, true);
  assert.ok(claude.options[0].choices.some(choice => choice.value === 'auto'));
  assert.equal(externalPiNativeConfig('pi-external').status, 'unsupported');
  const omp = externalPiNativeConfig('omp').options[0];
  assert.equal(omp.changePolicy, 'launch-only');
  assert.equal(omp.currentValue, undefined);
  assert.deepEqual(omp.choices.map(choice => choice.value), ['always-ask', 'always-ask-cached', 'write', 'yolo']);

  const profiles = await readMuseProfiles(async (method, params) => {
    assert.equal(method, 'permissionProfile/list');
    assert.deepEqual(params, { sessionId: 'muse-session' });
    return { profiles: [{ profileId: 'project/guarded', label: 'Project Guarded', available: true },
      { profileId: 'disabled-native', label: 'Organization policy', available: false, unavailableReasons: ['Requires native reviewer'] }] };
  }, 'muse-session');
  const muse = museNativeConfig('onRequest', { trust: 'untrusted' }, profiles, { profileId: 'project/guarded', reviewerAuthority: 'local', axes: { network: 'restricted' } });
  assert.equal(muse.options.find(option => option.id === 'permissionProfile').currentValue, 'project/guarded');
  assert.equal(profiles[1].disabled, true);
  assert.equal(profiles[1].description, 'Requires native reviewer');
  assert.equal(muse.options.find(option => option.id === 'network').currentValue, 'restricted');
  assert.equal(await readMuseProfiles(async () => { throw new NdjsonRpcResponseError(-32601, 'Method not found'); }), undefined);
  await assert.rejects(() => readMuseProfiles(async () => { throw new Error('Session source changed'); }), /source changed/);

  const dynamic = zcodeNativeConfig({ settings: { mode: { current: 'org-audit', available: [{ id: 'org-audit', label: 'Org Audit' }] } } }, true);
  assert.deepEqual(dynamic.options[0].choices, [{ value: 'org-audit', name: 'Org Audit' }]);
  assert.equal(dynamic.options[0].currentValue, 'org-audit');
  assert.equal(zcodeNativeConfig({ mode: { current: 'build', available: [] } }, true).options[0].changePolicy, 'read-only');
  assert.equal(zcodeNativeConfig({ mode: { current: 'guarded' } }, false).options[0].changePolicy, 'read-only');
  assert.equal(zcodeNativeConfig({ mode: { current: 'guarded' } }, true).catalogSource, 'versioned-adapter');
  console.log('Claude, Pi/OMP, Muse MSP and ZCode native configuration contracts passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
