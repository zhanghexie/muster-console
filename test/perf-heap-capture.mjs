// Pure fixtures only: no CDP, sampler, subprocess, application, or real profile.
import assert from 'node:assert/strict';
import { HEAP_SAMPLING_PARAMETERS, parseHeapArguments, summarizeHeapProfile, validateHeapProtocol } from '../.agents/skills/perf-trace/scripts/heap-analysis.mjs';

assert.deepEqual(HEAP_SAMPLING_PARAMETERS, { samplingInterval: 131072, stackDepth: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
assert.equal(Object.isFrozen(HEAP_SAMPLING_PARAMETERS), true);
assert.deepEqual(parseHeapArguments(['9333', 'scenario.json', 'new-prefix']), { port: '9333', scenarioPath: 'scenario.json', prefix: 'new-prefix' });
for (const args of [[], ['0', 's', 'o'], ['65536', 's', 'o'], ['https://example.test/', 's', 'o'], ['9333', 's', 'o', '--force-gc'], ['9333', '--snapshot', 'o']]) assert.throws(() => parseHeapArguments(args), /Usage/);
const protocol = { domains: [{ domain: 'HeapProfiler', commands: [
  { name: 'enable' }, { name: 'disable' }, { name: 'stopSampling' },
  { name: 'startSampling', parameters: Object.keys(HEAP_SAMPLING_PARAMETERS).map(name => ({ name })) }
] }] };
assert.equal(validateHeapProtocol(protocol), true);
assert.throws(() => validateHeapProtocol({ domains: [] }), /unavailable/);
const unsupported = structuredClone(protocol);
unsupported.domains[0].commands.find(command => command.name === 'startSampling').parameters.pop();
assert.throws(() => validateHeapProtocol(unsupported), /all required/);

const node = (functionName, selfSize, children = [], frameExtra = {}) => ({ selfSize, children, callFrame: { functionName, lineNumber: 3, columnNumber: 7, url: 'file:///PRIVATE_SOURCE', ...frameExtra } });
const profile = { head: node('(root)', 0, [
  node('(V8 API)', 1310720),
  node('readHistory', 100, [node('deserialize', 200)]),
  node('eval file:///PRIVATE_FUNCTION_SOURCE', 300)
]), samples: [{ size: 99999999, nodeId: 2, ordinal: 1 }] };
const result = summarizeHeapProfile(profile);
assert.equal(result.estimatedAllocatedBytes, 1311320, 'sum each node selfSize once, never add profile.samples again');
assert.equal(result.nodesVisited, 5);
assert.equal(result.allocationNodeCount, 4);
assert.equal(result.sampleCount, 1);
assert.equal(result.topSelf[0].functionName, '(V8 API)');
assert.equal(result.topSelf[0].estimatedSelfBytes, 1310720);
assert.deepEqual(result.topSelf.find(row => row.functionName === 'deserialize').parents, ['(root)', 'readHistory']);
assert.equal(result.topSelf.find(row => row.estimatedSelfBytes === 300).functionName, '[URL/path omitted]');
assert.equal(/PRIVATE_|file:|https?:|"url"/.test(JSON.stringify(result)), false, 'safe summary must not expose frame URLs or URL-shaped function names');
for (const functionName of ['webpack-internal:///PRIVATE_SRC', 'node:internal/PRIVATE_SRC', '/Users/alice/PRIVATE_SRC', 'C:\\PRIVATE_SRC', '\\\\server\\PRIVATE_SRC', '../PRIVATE_SRC']) {
  const redacted = summarizeHeapProfile({ head: node(functionName, 1, [node('leaf', 2)]) });
  assert.equal(JSON.stringify(redacted).includes('PRIVATE_SRC'), false, 'function and parent summaries must redact generic URI schemes and absolute/relative source paths');
}
assert.equal(summarizeHeapProfile(profile, 1).topSelf.length, 1);
assert.ok(result.interpretation.includes('Not retained heap'));
assert.throws(() => summarizeHeapProfile({}), /head/);
assert.throws(() => summarizeHeapProfile({ head: node('bad', -1) }), /Malformed/);
assert.throws(() => summarizeHeapProfile({ head: { selfSize: 0 } }), /Malformed/);
assert.throws(() => summarizeHeapProfile(profile, 0), /1..100/);
assert.equal(summarizeHeapProfile({ head: node('(root)', 0) }).sampleCount, null, 'missing sample array is unavailable, not zero');
console.log('perf-heap-capture: explicit sampling parameters/protocol support, strict CLI, cumulative self-size aggregation, parent attribution, and URL-safe summaries passed');
