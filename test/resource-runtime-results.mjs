import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-results-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { projectResourceToolResult: project } = await load('shared/resourceToolResult.ts');
  const { runtimesHost } = await load('main/capabilities/hosts/runtimes.ts');
  const script = path.join(tmp, 'launch.mjs');
  const longSource = 'export const allocate = () => {}\n' + '// launcher source\n'.repeat(1000);
  fs.writeFileSync(script, longSource);
  const rows = [
    { id: 'legacy', label: 'Legacy', builtin: true, enabled: false, script: 'launch.mjs',
      surface: 'pty', terminalResume: 'by-id', extraArgs: ['--test'], builtinScriptVersion: 3,
      integrations: { future: 'configuration' }, updatedAt: 7, other: 'preserve' },
    { id: 'dual', label: 'Dual', builtin: false, enabled: true, script: '', surface: 'pty',
      manifest: { id: 'dual', terminal: { command: 'cli' }, chat: { command: 'acp' },
        integrations: { data: 'configuration'.repeat(100) } }, updatedAt: 8 },
    { id: 'chat', label: 'Chat', builtin: true, enabled: true, script: '', surface: 'chat',
      integrations: { data: 'chat configuration' }, updatedAt: 9 },
    { id: 'large', label: 'Large manifest', builtin: false, enabled: true, script: '', surface: 'chat',
      manifest: { chat: { command: 'acp', args: ['x'.repeat(13000)] } }, updatedAt: 10 }
  ];
  const ctx = { runtimes: { list: () => structuredClone(rows), get: id => rows.find(row => row.id === id),
    scriptPath: () => script } };
  const raw = runtimesHost['runtimes.list'](ctx);
  const result = project('host.runtimes.run', { action: 'list', params: {} }, raw);
  assert.deepEqual(result.runtimes, [
    rows[0],
    { id: 'dual', label: 'Dual', builtin: false, enabled: true, surface: 'pty', updatedAt: 8, declaredSurfaces: ['pty', 'chat'] },
    { id: 'chat', label: 'Chat', builtin: true, enabled: true, surface: 'chat', updatedAt: 9 },
    rows[3]
  ]);
  assert.ok(raw.runtimes[1].manifest, 'the original host result is not changed');
  assert.ok(JSON.stringify(result).length < JSON.stringify(raw).length);
  const legacyDetail = runtimesHost['runtimes.get'](ctx, { id: 'legacy' });
  assert.equal(legacyDetail.scriptSource, longSource);
  assert.ok(JSON.stringify({ ok: true, result: legacyDetail }).length > 12000,
    'large launcher source can make get unavailable through the result budget');
  assert.deepEqual(runtimesHost['runtimes.get'](ctx, { id: 'dual' }).manifest, rows[1].manifest);
  const annotated = { ...raw, warning: 'keep', error: 'keep', unknown: { also: 'keep' } };
  assert.deepEqual({ warning: project('host.runtimes.run', { action: 'list' }, annotated).warning,
    error: project('host.runtimes.run', { action: 'list' }, annotated).error,
    unknown: project('host.runtimes.run', { action: 'list' }, annotated).unknown },
  { warning: 'keep', error: 'keep', unknown: { also: 'keep' } });
  for (const [name, args, value] of [
    ['host.runtimes.run', { action: 'get' }, raw],
    ['host.runtimes.run', { action: 'list' }, { ...raw, error: 'failed' }],
    ['host.runtimes.run', { action: 'list' }, { runtimes: [{ id: 'incomplete' }], error: 'keep' }],
    ['host.runtimes.run', { action: 'list' }, { runtimes: [{ ...rows[1], manifest: 'unknown' }] }],
    ['host.runtimes.run', { action: 'list' }, { ok: false, error: 'failed' }]
  ]) assert.strictEqual(project(name, args, value), value);

  // The shipped seed itself is larger than the executor budget before projection.
  const seed = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/main/runtime/builtins/registry.json'), 'utf8'));
  const seedRaw = { runtimes: seed.runtimes };
  const seedResult = project('host.runtimes.run', { action: 'list' }, seedRaw);
  assert.ok(JSON.stringify({ ok: true, result: seedResult }).length <= 12000, 'all seeded runtimes fit in a model reply');
  assert.equal(seedResult.runtimes.length, seedRaw.runtimes.length);
  assert.ok(JSON.stringify({ ok: true, result: seedResult }).length < JSON.stringify({ ok: true, result: seedRaw }).length);
  console.log(`resource-runtime-results: ok (seed ${JSON.stringify(seedRaw).length} -> ${JSON.stringify(seedResult).length} chars)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
