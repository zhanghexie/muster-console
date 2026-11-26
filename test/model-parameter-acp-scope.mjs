import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'parameter-acp-scope-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { describeParameters, saveParameterProfiles } = await import(pathToFileURL(compile('main/agentSession/host/modelParameters.ts')));
  const calls = [];
  let config = { workspace: '/fixture', modelParameterProfiles: [] };
  const driver = { describeModelParameters: async input => {
    calls.push(input);
    return { runtimeId: 'acp', providerId: `acp:${input.piModeId || 'opencode'}`, modelId: input.modelOverride?.modelId || 'native',
      parameters: [{ id: 'effort', label: 'Effort', apply: 'next-turn', supportsDefault: true, options: [{ value: 'low', label: 'Low' }] }] };
  } };
  const host = { drivers: new Map([['acp', driver]]), entries: new Map(), ctx: { config: { get: () => config, update: patch => { config = { ...config, ...patch }; } } } };
  const profile = { runtimeId: 'acp', providerId: 'acp:kimi', modelId: 'kimi-model', parameters: { effort: { defaultValue: 'low' } } };
  const result = await saveParameterProfiles(host, [profile]);
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.at(-1).piModeId, 'kimi', 'saving validates the selected preset, not OpenCode');
  assert.equal(calls.at(-1).modelOverride.modelId, 'kimi-model');
  assert.deepEqual(config.modelParameterProfiles, [profile]);
  await describeParameters(host, { runtimeId: 'acp', providerId: 'acp:mimo-code' });
  assert.equal(calls.at(-1).piModeId, 'mimo-code');
  const before = calls.length;
  const mismatch = await describeParameters(host, { runtimeId: 'acp', providerId: 'acp:kimi', piModeId: 'opencode' });
  assert.equal(mismatch.unavailable, true);
  assert.equal(calls.length, before, 'a conflicting target cannot inspect another preset');
  await describeParameters(host, { runtimeId: 'acp', piModeId: 'kimi', providerId: 'acp', modelId: 'native' });
  assert.equal(calls.at(-1).piModeId, 'kimi', 'session model provider retains its existing meaning');
  console.log('ACP parameter scope: preset-specific discovery, validation and save passed');
} finally {
  assert.ok(path.resolve(tmp).startsWith(path.join(root, '.tmp') + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
