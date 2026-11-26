import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'model-parameters-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { normalizeModelParameterDescriptors, parseModelParameterProfiles, resolveModelParameters, changeModelParameters, validateModelParameterProfile } = await import(pathToFileURL(compile('shared/modelParameters.ts')));
  const { buildGuiInheritMeta } = await import(pathToFileURL(compile('shared/guiInheritMeta.ts')));
  const { codexModelItems } = await import(pathToFileURL(compile('shared/codexModels.ts')));
  const parameter = { id: 'reasoning', semantic: 'reasoning', label: 'Budget', options: [{ value: '512', label: 'Quick' }, { value: '2048', label: 'Balanced' }, { value: '8192', label: 'Deep' }], apply: 'next-turn', supportsDefault: true, defaultValue: '2048' };
  const seven = { id: 'strategy', label: 'Strategy', options: Array.from({ length: 7 }, (_, i) => ({ value: String(i), label: 'Strategy ' + i })), apply: 'reconnect', supportsDefault: true };
  const context = { runtimeId: 'budget-cli', providerId: 'provider-a', modelId: 'model-a', parameters: [parameter, seven] };
  const runtimeProfile = { runtimeId: 'budget-cli', parameters: { reasoning: { options: [{ value: 'fast', label: '快速', mappedValue: '512' }, { value: 'deep', label: '深入', mappedValue: '8192' }], defaultValue: 'fast' } } };
  const modelProfile = { runtimeId: 'budget-cli', providerId: 'provider-a', modelId: 'model-a', parameters: { reasoning: { options: runtimeProfile.parameters.reasoning.options, defaultValue: 'deep' } } };

  assert.deepEqual(normalizeModelParameterDescriptors([{ ...parameter, apply: 'invented' }]), [], 'invalid declarations cannot enable controls');
  assert.deepEqual(normalizeModelParameterDescriptors([{ ...parameter, id: '__proto__' }]), []);
  const native = resolveModelParameters(context, []);
  assert.equal(native.controls[0].effectiveValue, '2048');
  assert.equal(native.controls[0].source, 'engine');
  assert.deepEqual(native.values, {}, 'known engine defaults are not forced into requests');
  assert.equal(resolveModelParameters({ ...context, parameters: [{ ...parameter, defaultValue: undefined }] }, []).controls[0].effectiveValue, null, 'unknown defaults stay unknown');

  const profiles = parseModelParameterProfiles([runtimeProfile, modelProfile]);
  assert.deepEqual(profiles, [runtimeProfile, modelProfile]);
  const modelDefault = resolveModelParameters(context, profiles);
  assert.equal(modelDefault.controls[0].source, 'model');
  assert.deepEqual(modelDefault.values, { reasoning: '8192' }, 'model beats runtime and aliases resolve to adapter values');
  for (const defaultValue of ['deep', '8192']) {
    const inherited = { ...modelProfile, parameters: { reasoning: { defaultValue } } };
    assert.equal(resolveModelParameters(context, [runtimeProfile, inherited]).values.reasoning, '8192', 'model defaults inherit lower-scope display mappings');
  }
  const sessionDefault = resolveModelParameters(context, profiles, { reasoning: 'fast' });
  assert.deepEqual(sessionDefault.values, { reasoning: '512' }, 'session beats model');
  const otherModel = resolveModelParameters({ ...context, modelId: 'other' }, profiles);
  assert.equal(otherModel.controls[0].source, 'runtime'); assert.equal(otherModel.values.reasoning, '512');
  assert.deepEqual(changeModelParameters(sessionDefault, { reasoning: 'fast' }, { reasoning: null }), {}, 'follow default removes the override');
  const explicitlyOff = { ...parameter, options: [{ value: 'off', label: 'Off' }, ...parameter.options] };
  assert.equal(resolveModelParameters({ ...context, parameters: [explicitlyOff] }, [], { reasoning: 'off' }).values.reasoning, 'off', 'off stays distinct from omission');

  assert.throws(() => changeModelParameters(sessionDefault, { reasoning: 'fast' }, { reasoning: 'ultra' }), /Unsupported/);
  assert.throws(() => changeModelParameters(sessionDefault, {}, { unknown: null }), /Unsupported/);
  const forbidden = { ...runtimeProfile, parameters: { reasoning: { options: [{ value: 'unsafe', label: 'Unsafe', mappedValue: 'invented' }] } } };
  assert.match(validateModelParameterProfile(context, forbidden), /Unsupported parameter mapping/);
  const downgraded = resolveModelParameters(context, [forbidden]);
  assert.deepEqual(downgraded.values, {}); assert.match(downgraded.warning, /mapping/);
  assert.throws(() => parseModelParameterProfiles([runtimeProfile, runtimeProfile]), /Duplicate/);
  assert.throws(() => parseModelParameterProfiles([{ ...runtimeProfile, parameters: JSON.parse('{"__proto__":{}}') }]), /Invalid/);
  assert.throws(() => parseModelParameterProfiles([{ ...runtimeProfile, parameters: { reasoning: { options: [] } } }]), /Invalid/);

  const inheritedAlias = resolveModelParameters({ ...context, legacyValues: { reasoning: '8192' } }, profiles);
  assert.equal(inheritedAlias.controls[0].override, 'deep', 'legacy native values migrate through display aliases');
  const unchangedKey = resolveModelParameters(context, profiles, { reasoning: 'fast' }).reconnectKey;
  assert.equal(unchangedKey, resolveModelParameters(context, profiles, { reasoning: 'deep' }).reconnectKey, 'next-turn changes do not rebuild connections');
  assert.notEqual(unchangedKey, resolveModelParameters(context, profiles, { strategy: '6' }).reconnectKey, 'snapshot parameters rebuild connections');
  const narrowed = resolveModelParameters({ ...context, parameters: [{ ...parameter, options: parameter.options.slice(0, 1) }] }, [], { reasoning: '8192' });
  assert.equal(narrowed.controls[0].override, null); assert.match(narrowed.warning, /override/);
  assert.deepEqual(buildGuiInheritMeta({ modelParameters: { reasoning: 'deep', strategy: '6' } }), { modelParameters: { reasoning: 'deep', strategy: '6' } }, 'creation needs no pinned model');
  assert.deepEqual(buildGuiInheritMeta({ modelParameters: {} }), { modelParameters: {} }, 'explicit clear survives initialization');
  assert.throws(() => buildGuiInheritMeta({ modelParameters: { reasoning: 123 } }), /INVALID_MODEL_PARAMETERS/);

  const items = codexModelItems([{ model: 'native', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'invented' }], defaultReasoningEffort: 'xhigh' }, { model: 'no-metadata' }]);
  assert.deepEqual(items[0].parameters[0].options.map(o => o.value), ['low', 'xhigh']);
  assert.equal(items[0].parameters[0].defaultValue, 'xhigh'); assert.equal(items[1].parameters, undefined);
  console.log('ok model-parameters (registration, arbitrary options, defaults, mappings, legacy, reconnect, creation, native metadata)');
} finally {
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
