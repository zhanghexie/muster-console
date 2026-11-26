import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function load(file) {
  const exports = {};
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', output)(exports);
  return exports;
}
const { pickerModelRows, pickerModelGroups, pickerModelTitle } = load('src/shared/harnessModelPresentation.ts');
const { parseAcpModelList } = load('src/main/agentSession/drivers/acp/modelOptions.ts');
const row = (modelId, label, group) => ({ providerId: 'fixture', modelId, label, ...(group ? { group } : {}) });

const claude = pickerModelRows(['opus', 'sonnet', 'haiku'].map(id => row(id, 'glm-5.3-flash[1m]')));
assert.deepEqual(claude.map(r => r.detail), ['opus', 'sonnet', 'haiku']);
assert.deepEqual(claude.map(r => r.modelId), ['opus', 'sonnet', 'haiku']);
assert.equal(pickerModelRows([row('a', 'A'), row('a', 'A'), row('b', 'B')]).length, 2);
assert.equal(pickerModelRows([row('a', 'A'), row('a', 'A')])[0].detail, undefined, 'deduplicate before counting label collisions');

const core = pickerModelRows([row('same', 'Model', { id: 'one', label: 'Account' }),
  { ...row('same', 'Model', { id: 'two', label: 'Account' }), providerId: 'other' }]);
assert.ok(core.every(r => r.detail === undefined), 'separate groups distinguish equal model names');
assert.deepEqual(pickerModelGroups(core).map(g => g.label), ['Account · one', 'Account · two']);
assert.deepEqual(pickerModelGroups([core[0], row('plain', 'Plain'), { ...core[0], modelId: 'last' }]).map(g => g.items.length), [2, 1]);
const collision = pickerModelRows([row('same', 'Model'), { ...row('same', 'Model'), providerId: 'other' }]);
assert.deepEqual(collision.map(r => r.detail), ['fixture / same', 'other / same']);

for (const [id, label] of [['qwen3.8-max(openai)', '[QwenCloud Token Plan] qwen3.8-max'],
  ['provider/model[1m]', 'Model [1m]'], ['zcode:v1:opaque-token', 'Model'], ['pi-rpc:v1:opaque-token', 'Model'], ['hash:9a7f', 'Model']]) {
  const displayed = pickerModelRows([row(id, label)])[0];
  assert.equal(displayed.label, label, 'never strip syntax from upstream names');
  assert.equal(displayed.modelId, id, 'never rewrite an opaque identity');
  assert.equal(displayed.group, undefined, 'never infer a supplier from a name or ID');
  assert.ok(pickerModelTitle(displayed).includes(id));
}
const grouped = parseAcpModelList({ configOptions: [{ id: 'model', type: 'select', options: [
  { group: 'a', name: 'Provider A', options: [{ value: 'a/model', name: 'Model' }] },
  { group: 'b', name: 'Provider B', options: [{ value: 'b/model', name: 'Model' }] },
  { value: 'opaque', name: '[Not a group] Model', displayGroup: { id: 'forged', label: 'Forged' } }
] }] });
assert.deepEqual(grouped.items.slice(0, 2).map(r => r.group), [{ id: 'a', label: 'Provider A' }, { id: 'b', label: 'Provider B' }]);
assert.equal(grouped.items[2].group, undefined);
assert.equal(grouped.items[2].name, '[Not a group] Model');
console.log('harness model presentation: native identities, groups, aliases and opaque fallbacks passed');
