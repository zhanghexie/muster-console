import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-tool-result-'));
try {
  const compile = createSharedCompiler(root, temp);
  const load = file => import(pathToFileURL(compile(file)));
  const { modelToolResult: project } = await load('shared/modelToolResult.ts');
  const { servicesHost } = await load('main/capabilities/hosts/services.ts');
  const { llmHost } = await load('main/capabilities/hosts/llm.ts');
  const large = '正文\\\"\n'.repeat(5000);
  const fits = value => assert.ok(JSON.stringify({ ok: true, result: value }).length < 12000);
  const task = { id: 'a', name: 'nightly', workspaceId: 'w', runtime: 'pi', prompt: large,
    schedule: { kind: 'once', at: '2026-11-15T00:00:00Z' }, delayMinutes: 60, enabled: true,
    sourceRoot: { rootId: 'root', cwd: '/project' }, nextRunAt: 123, lastError: 'inspect', nativeConfig: { mode: 'plan' } };
  for (const action of ['create', 'update']) {
    const raw = { [action === 'create' ? 'created' : 'updated']: true, task };
    const receipt = project('host.automations.run', { action }, raw);
    assert.deepEqual(receipt.task, Object.fromEntries(Object.entries(task).filter(([k]) => k !== 'prompt')));
    assert.ok(JSON.stringify(raw).length > 12000); fits(receipt); assert.equal(raw.task.prompt, large);
  }
  assert.equal(project('host.automations.run', { action: 'list' }, { automations: [task] }).automations[0], task,
    'list is the only prompt read; do not remove the body without a detail endpoint');
  const entry = { id: 'legacy', label: 'Legacy', enabled: true, builtin: false, surface: 'pty', script: 'launch.mjs',
    extraArgs: [large], integrations: { setup: large }, manifestApproval: 'reviewed-fingerprint' };
  for (const action of ['register', 'update']) {
    const receipt = project('host.runtimes.run', { action }, entry);
    assert.equal(receipt.id, 'legacy'); assert.equal(receipt.manifestApproval, entry.manifestApproval); fits(receipt);
  }
  const manifestEntry = { ...entry, manifest: { terminal: { command: large }, chat: { command: large } } };
  const list = project('host.runtimes.run', { action: 'list' }, { runtimes: [entry, manifestEntry] });
  assert.deepEqual(list.runtimes, [entry, manifestEntry], 'preserve list metadata if a separate get may exceed the wire budget');
  fits(project('host.runtimes.run', { action: 'restoreBuiltins' }, [manifestEntry]));
  assert.equal(project('host.runtimes.run', { action: 'get' }, manifestEntry), manifestEntry);
  const provider = { id: 'p', baseUrl: 'https://api.example/v1', api: 'openai-completions', enabled: true,
    apiKey: '***configured***', models: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, name: large.slice(0, 200) })),
    thinking: { levels: { off: 'none' } }, compat: { supportsDeveloperRole: false } };
  const rawProvider = { created: true, provider, activeProviderId: 'other', warnings: ['thinking inactive'], note: 'saved' };
  const saved = structuredClone(rawProvider);
  const receipt = project('host.llm.run', { action: 'upsertProvider' }, rawProvider);
  assert.ok(JSON.stringify(rawProvider).length > 12000); fits(receipt);
  assert.equal(receipt.provider.modelCount, 150); assert.deepEqual(receipt.warnings, rawProvider.warnings);
  assert.deepEqual(receipt.provider.compat, provider.compat); assert.deepEqual(rawProvider, saved);
  const run = { runId: 'run', status: 'waiting', name: 'build', args: { event: large }, result: large,
    pendingAsk: { askId: 'ask', to: 'scheduler', question: 'Continue?' }, errorDetail: 'diagnosis', sessions: ['worker'] };
  for (const action of ['start', 'list']) {
    const out = project('host.workflow.run', { action }, action === 'start' ? run : { active: [run], workflows: [] });
    const summary = action === 'start' ? out : out.active[0];
    fits(out); assert.deepEqual(summary.pendingAsk, run.pendingAsk); assert.equal(summary.errorDetail, 'diagnosis');
  }
  assert.equal(project('host.workflow.run', { action: 'get' }, run), run);
  const subscription = { id: 'sub', source: 'file', pathPattern: '**/*.ts', startCursor: 42, expiresAt: null };
  assert.deepEqual(project('host.events.subscribe', {}, { ok: true, subscription, subscriptions: Array(100).fill({ query: large }) }), { ok: true, subscription });
  const emitted = { ok: true, fact: { id: 'fact', kind: 'custom:done', summary: 'Done', data: { payload: large }, paths: [large] }, delivered: 2 };
  assert.deepEqual(project('host.events.emit', {}, emitted), { ok: true, fact: { id: 'fact', kind: 'custom:done', summary: 'Done' }, delivered: 2 });
  const failed = { ok: false, task, error: 'partial failure', completed: ['a'] };
  assert.equal(project('host.automations.run', { action: 'update' }, failed), failed);
  for (const name of ['host.memory.get', 'host.feedback.history', 'host.attachments.convert', 'host.web.fetch', 'host.scheduler.policy.set']) {
    const read = { text: 'data', nextOffset: 1, partial: true, warnings: ['review'] };
    assert.equal(project(name, {}, read), read);
  }
  // Exercise the actual producers as well as the public-name dispatcher.
  const automationArgs = { automationId: 'a', prompt: large };
  const updated = await servicesHost['automations.update']({ tasks: { update: (id, patch) => ({ ...task, ...patch, id }) } }, automationArgs);
  const llmConfig = { llm: { providers: [], activeProviderId: '', activeModelId: '' } };
  const stored = llmHost['llm.upsertProvider']({ config: { get: () => llmConfig, update: patch => Object.assign(llmConfig, patch) } },
    { id: 'p', baseUrl: 'https://example.invalid/v1', models: provider.models });
  for (const [name, action, raw] of [['host.automations.run', 'update', updated], ['host.llm.run', 'upsertProvider', stored]]) {
    const receipt = project(name, { action }, raw);
    const size = value => JSON.stringify({ ok: true, result: value }).length;
    assert.ok(size(raw) > 12000); fits(receipt);
    console.log(`${name}/${action} fixture: ${size(raw)} -> ${size(receipt)} chars`);
  }
  assert.equal(stored.provider.models.length, 150);
  console.log('resource tool result projections: passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
