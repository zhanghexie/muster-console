/** Available Worker selectors share local probes; no subprocesses, credentials or network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'runtime-availability-'));
const bundle = path.join(tmp, 'availability.cjs');
buildSync({ entryPoints: [path.join(root, 'src/main/runtime/availability.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
const { RuntimeAvailabilityReader } = createRequire(import.meta.url)(bundle);
const entry = (id, options = {}) => ({ id, label: id, surface: 'pty', enabled: true, ...options });
const result = (id, status = 'available') => ({ id, ok: status === 'available', status, problems: [], checkedAt: 0 });
const setup = (entries, options = {}) => {
  let current = entries;
  let cfg = { workspace: '/fixture', llm: { marker: 'initial' } };
  const deps = { runtimes: { rootDir: '/fixture/runtimes', list: () => structuredClone(current) }, config: { get: () => cfg }, agentSessions: {} };
  const calls = [];
  const reader = new RuntimeAvailabilityReader(deps, { presets: () => [], ...options, probe: async (_deps, id, args) => { calls.push({ id, args }); return options.probe ? options.probe(_deps, id, args) : result(id); } });
  return { reader, calls, deps, setEntries: value => { current = value; }, setConfig: value => { cfg = value; } };
};
let count = 0;
const check = async (name, run) => { await run(); console.log(`ok   ${name}`); count++; };

await check('only enabled, registered, locally available workers are selectable', async () => {
  const bad = ['not_installed', 'not_configured', 'script_missing', 'unknown'];
  const ctx = setup([entry('custom-tool'), entry('off', { enabled: false }), ...bad.map(entry)], {
    probe: async (_deps, id) => result(id, bad.includes(id) ? id : 'available')
  });
  assert.deepEqual((await ctx.reader.read()).runtimes.map(item => item.id), ['custom-tool']);
  assert.equal(ctx.calls.some(item => item.id === 'off'), false);
});
await check('ACP probes each trusted preset and does not depend on missing default', async () => {
  const ctx = setup([entry('acp', { surface: 'chat' })], { presets: () => [{ id: 'opencode', name: 'OpenCode' }, { id: 'gemini', name: 'Gemini' }], probe: async (_deps, id, args) => result(id, args.piModeId === 'gemini' ? 'available' : 'not_installed') });
  const snapshot = await ctx.reader.read();
  assert.deepEqual(snapshot.runtimes.map(item => item.id), ['acp']);
  assert.deepEqual(snapshot.acpAgents, [{ id: 'gemini', name: 'Gemini' }]);
  assert.deepEqual(ctx.calls.map(item => item.args.piModeId).sort(), ['gemini', 'opencode']);
});
await check('ACP disappears with no available presets or a disabled Worker', async () => {
  for (const enabled of [true, false]) {
    const ctx = setup([entry('acp', { surface: 'chat', enabled })], { presets: () => [{ id: 'missing', name: 'Missing' }], probe: async (_deps, id) => result(id, 'not_installed') });
    assert.deepEqual((await ctx.reader.read()).runtimes, []);
    assert.equal(ctx.calls.length, enabled ? 1 : 0);
  }
});
await check('startup cache, explicit force and cloned snapshots', async () => {
  let now = 100;
  const ctx = setup([entry('first')], { now: () => now });
  const snapshot = await ctx.reader.read(); snapshot.runtimes[0].label = 'outside mutation';
  assert.equal((await ctx.reader.read()).runtimes[0].label, 'first');
  assert.equal(ctx.calls.length, 1);
  await ctx.reader.read(true); assert.equal(ctx.calls.length, 2);
  now += 1001; await ctx.reader.read(); assert.equal(ctx.calls.length, 2);
});
await check('changes to legacy runtime entries and configuration appear on explicit refresh', async () => {
  const ctx = setup([entry('first')]); await ctx.reader.read();
  ctx.setEntries([entry('first', { label: 'Renamed' })]);
  assert.equal((await ctx.reader.read()).runtimes[0].label, 'first');
  assert.equal((await ctx.reader.read(true)).runtimes[0].label, 'Renamed');
  ctx.setConfig({ workspace: '/other', llm: { marker: 'new' } }); await ctx.reader.read();
  ctx.deps.agentSessions = {}; await ctx.reader.read();
  assert.equal(ctx.calls.length, 2);
  ctx.setEntries([entry('first', { enabled: false })]); assert.deepEqual((await ctx.reader.read(true)).runtimes, []);
});
await check('a manifest added during startup is selectable in the next read without manual refresh', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const initial = entry('first');
  const custom = entry('declared', { manifest: { id: 'declared', label: 'Declared', terminal: { command: process.execPath } } });
  const ctx = setup([initial], { probe: async (_deps, id) => { await gate; return result(id); } });
  const startup = ctx.reader.read();
  const obsolete = assert.rejects(startup, /变化|changed/);
  ctx.setEntries([initial, custom]);
  const updated = ctx.reader.read();
  release();
  await obsolete;
  const snapshot = await updated;
  assert.deepEqual(snapshot.runtimes.map(item => item.id), ['first', 'declared']);
  assert.equal(snapshot.cliPrograms.declared.status, 'found');
  ctx.setEntries([initial]);
  assert.deepEqual((await ctx.reader.read()).runtimes.map(item => item.id), ['first']);
});
await check('concurrent inventories share probes and bound concurrency to two', async () => {
  let active = 0; let peak = 0;
  const ctx = setup(Array.from({ length: 8 }, (_, index) => entry(`worker-${index}`)), { probe: async (_deps, id) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return result(id); } });
  const [first, second] = await Promise.all([ctx.reader.read(), ctx.reader.read()]);
  assert.deepEqual(first, second); assert.equal(ctx.calls.length, 8); assert.equal(peak, 2);
  first.runtimes[0].label = 'changed'; assert.notEqual(first.runtimes[0].label, second.runtimes[0].label);
});
await check('late probe results cannot expose a newly disabled Worker', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = setup([entry('late')], { probe: async (_deps, id) => { await gate; return result(id); } });
  const pending = ctx.reader.read(); ctx.setEntries([entry('late', { enabled: false })]); release();
  await assert.rejects(pending, /变化|changed/);
  assert.deepEqual((await ctx.reader.read(true)).runtimes, []);
});
await check('failed probes are excluded without removing other available Workers', async () => {
  const ctx = setup([entry('throwing'), entry('good')], { probe: async (_deps, id) => { if (id === 'throwing') throw new Error('fixture failure'); return result(id); } });
  assert.deepEqual((await ctx.reader.read()).runtimes.map(item => item.id), ['good']);
});
await check('a never-settling probe cannot block available Workers or future forced reads', async () => {
  let hanging = true;
  const ctx = setup([entry('hanging'), entry('good')], { probeTimeoutMs: 15, probe: async (_deps, id) => id === 'hanging' && hanging ? new Promise(() => {}) : result(id) });
  assert.deepEqual((await ctx.reader.read()).runtimes.map(item => item.id), ['good']);
  hanging = false;
  assert.deepEqual((await ctx.reader.read(true)).runtimes.map(item => item.id), ['hanging', 'good']);
});
console.log(`runtime availability: ${count} groups passed`);
