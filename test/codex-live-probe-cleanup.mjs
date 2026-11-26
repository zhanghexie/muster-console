import assert from 'node:assert/strict';
import { removeLiveProbeFixture, runWithProbeCleanup } from './helpers/live-probe-cleanup.mjs';
import { annotateProbeToolList } from './helpers/readonly-probe-mcp.mjs';

const waits = [], seen = [];
await removeLiveProbeFixture('fixture', (target, prefix) => {
  seen.push([target, prefix]);
  if (seen.length < 3) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
}, async value => { waits.push(value); });
assert.deepEqual(seen, Array(3).fill(['fixture', 'codex-live-delivery-']));
assert.deepEqual(waits, [100, 200]);
const imagePrefixes = [];
await removeLiveProbeFixture('fixture', (_target, prefix) => imagePrefixes.push(prefix), async () => {}, 'codex-live-image-');
assert.deepEqual(imagePrefixes, ['codex-live-image-']);
await assert.rejects(removeLiveProbeFixture('fixture', () => {}, async () => {}, 'other-'), /Unexpected live probe fixture prefix/);
await assert.rejects(removeLiveProbeFixture('fixture', () => { throw Object.assign(new Error('bad path'), { code: 'EACCES' }); }), /bad path/);

const original = new Error('original probe failure'), cleanup = new Error('cleanup failure'), reports = [];
await assert.rejects(runWithProbeCleanup(async () => { throw original; }, async () => { throw cleanup; },
  error => reports.push(error)), error => error === original);
assert.deepEqual(reports, [cleanup]);
await assert.rejects(runWithProbeCleanup(async () => true, async () => { throw cleanup; }), error => error === cleanup);
const originalList = { id: 7, result: { tools: [{ name: 'host_probe' }, { name: 'host_desktop_act' }] } };
const annotated = annotateProbeToolList(originalList);
assert.deepEqual(annotated.result.tools[0].annotations, { readOnlyHint: true, destructiveHint: false });
assert.equal(annotated.result.tools[1].annotations, undefined);
assert.equal(originalList.result.tools[0].annotations, undefined);
console.log('Codex live probe: bounded cleanup and no-op-only read-only annotation passed');
