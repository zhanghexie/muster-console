/**
 * P1 model 组装 + P3 rename 别名。还原 buildGuiInheritMeta 丢 model 应红。
 * Run: node test/gui-inherit-meta.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-inherit-'));
const compile = createSharedCompiler(root, tmp);
const { buildGuiInheritMeta, parseGuiModelArg, assertLaunchModel, resolveLaunchConfiguration } = await import(
  pathToFileURL(compile('shared/guiInheritMeta.ts')).href
);

const meta = buildGuiInheritMeta({
  model: { providerId: 'cursor', modelId: 'grok-4.6' },
  guiMode: 'auto'
});
assert.deepEqual(meta.modelOverride, { providerId: 'cursor', modelId: 'grok-4.6' });
assert.equal(meta.guiMode, 'auto');

assert.equal(parseGuiModelArg(undefined), undefined);
assert.equal(parseGuiModelArg({}), undefined);
assert.throws(() => parseGuiModelArg('claude'), /model/);
assert.throws(() => assertLaunchModel('codex-gui', { providerId: 'anthropic', modelId: 'claude' }, true), /providerId/);
assert.throws(() => assertLaunchModel('codex', { providerId: 'codex-gui', modelId: 'gpt' }, false), /CLI/);
assert.throws(() => assertLaunchModel('acp', { providerId: 'x', modelId: 'y' }, true), /providerId.*acp/);
assert.doesNotThrow(() => assertLaunchModel('codex-gui', { providerId: 'codex-gui', modelId: 'gpt' }, true));
assert.throws(
  () => parseGuiModelArg({ providerId: 'cursor' }),
  /INCOMPLETE_MODEL/
);

const launch = (input, parent) => resolveLaunchConfiguration(input, parent, 'pi', id => ['pi', 'acp'].includes(id));
const kimi = { runtime: 'acp', piModeId: 'kimi', modelOverride: { providerId: 'acp', modelId: 'kimi-k2.6' }, modelParameters: { reasoning: 'high' } };
assert.deepEqual(launch({}, kimi), { runtime: 'acp', inheritMeta: { piModeId: 'kimi', modelOverride: kimi.modelOverride, modelParameters: { reasoning: 'high' } } });
assert.deepEqual(launch({ acpPresetId: 'opencode' }, kimi), { runtime: 'acp', inheritMeta: { piModeId: 'opencode' } });
assert.deepEqual(launch({ piModeId: 'opencode' }, kimi).inheritMeta, { piModeId: 'opencode' });
assert.equal(launch({ model: { providerId: 'acp', modelId: 'kimi-k3' } }, kimi).inheritMeta.modelParameters, undefined);
assert.equal(launch({}, { ...kimi, runtime: 'pi', piModeId: 'creator', modelOverride: undefined }).inheritMeta.piModeId, undefined);
assert.throws(() => launch({ acpPresetId: 'kimi', piModeId: 'opencode' }, kimi), /conflicts/);
const { observedNativeConfigIntent } = await import(pathToFileURL(compile('shared/nativeSessionConfig.ts')).href);
const identity = { runtimeId: 'acp', presetId: 'kimi', sourceKey: 'fixture-root', version: 'fixture' };
const parentInitial = { ...kimi, configurePermissions: true, nativeConfig: { identity, selections: [{ id: 'mode', value: 'build' }] } };
const observed = { identity, revision: 2, status: 'ready', source: 'session', options: [{
  id: 'mode', name: 'Mode', type: 'select', changePolicy: 'live', currentValue: 'plan',
  choices: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }]
}, { id: 'review', name: 'Review', type: 'boolean', changePolicy: 'live', currentValue: false }] };
assert.deepEqual(launch({}, { ...parentInitial, nativeConfig: observedNativeConfigIntent(observed) }).inheritMeta.nativeConfig.selections,
  [{ id: 'mode', value: 'plan' }, { id: 'review', value: false }]);
assert.equal(launch({}, parentInitial).inheritMeta.configurePermissions, true);
assert.equal(launch({ configurePermissions: false }, parentInitial).inheritMeta.configurePermissions, false);
assert.equal(launch({ acpPresetId: 'opencode' }, parentInitial).inheritMeta.configurePermissions, undefined);
assert.throws(() => launch({ configurePermissions: 'true' }), /must be a boolean/);
assert.equal(observedNativeConfigIntent({ ...observed, requested: [{ id: 'mode', value: 'build' }] }), undefined);
assert.equal(observedNativeConfigIntent({ ...observed, options: [{ ...observed.options[0], currentValue: 'unknown' }] }), undefined);


const tasksSrc = fs.readFileSync(path.join(root, 'src', 'main', 'capabilities', 'hosts', 'creation.ts'), 'utf8');
assert.match(tasksSrc, /model:\s*args\?\.model/, 'sessions.create 必须把 model 传给 delegateTask（P1）');
assert.match(tasksSrc, /guiMode:\s*args\?\.guiMode/);

const queueSrc = fs.readFileSync(path.join(root, 'src', 'main', 'tasks', 'delegateQueue.ts'), 'utf8');
assert.match(queueSrc, /drainChains/, '出队须串行，禁止并行 drain 超发');
assert.equal(queueSrc.includes('_fromQueue'), false);

const sessHost = fs.readFileSync(path.join(root, 'src', 'main', 'capabilities', 'hosts', 'sessions.ts'), 'utf8');
assert.match(sessHost, /resolveHostSessionId\(ctx, args\.sessionId\)/, 'select/close 须走短 id 反查');
assert.match(sessHost, /resolveQueryIds/, 'markProcessed ids 须走短 id');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] gui-inherit-meta');
