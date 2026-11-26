import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { supportedMaterials, validateOptions } = require('../docs/prototypes/native-material-demo/policy.cjs');
assert.deepEqual(supportedMaterials('win32', '10.0.26200'), ['acrylic', 'mica', 'solid']);
assert.deepEqual(supportedMaterials('win32', '10.0.22621'), ['acrylic', 'mica', 'solid']);
assert.deepEqual(supportedMaterials('win32', '10.0.22000'), ['solid']);
assert.deepEqual(supportedMaterials('win32', '10.0.19045'), ['solid']);
assert.deepEqual(supportedMaterials('win32', '10.0.26200', false), ['solid']);
assert.deepEqual(supportedMaterials('darwin', '25.0.0'), ['acrylic', 'solid']);
assert.deepEqual(supportedMaterials('linux', '6.12.0'), ['solid']);
assert.deepEqual(validateOptions({ material: 'acrylic', theme: 'light', tint: 0, reference: false }, ['acrylic', 'solid']),
  { material: 'acrylic', theme: 'light', tint: 0, reference: false });
for (const invalid of [{material: 'mica'}, {theme: 'system'}, {tint: 46}, {tint: NaN}, {tint: -1}, {reference: 1}, {unknown: true}, null, []]) {
  assert.throws(() => validateOptions(invalid, ['acrylic', 'solid']));
}
console.log('native-material-policy: platform boundary and IPC option validation passed');
