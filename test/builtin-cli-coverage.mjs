import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtinsDir = path.join(root, 'src/main/runtime/builtins');
const seed = JSON.parse(fs.readFileSync(path.join(builtinsDir, 'registry.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src/shared/harnessCatalog.ts'), 'utf8');
assert.equal(seed.runtimes.find(item => item.id === 'pi')?.label, 'Muster Core');
assert.match(source, /id: 'muster-core', name: 'Muster Core'/);
const basicTuiProducts = [
  ['kimi', 'kimi', []], ['grok', 'grok', []],
  ['commandcode', 'command-code', []], ['cline', 'cline', []], ['kilo', 'kilo', []],
  ['github-copilot', 'copilot', []], ['devin', 'devin', []], ['hermes', 'hermes', []],
  ['pi-external', 'pi', []], ['omp', 'omp', []], ['muse', 'muse', []],
  ['zcode', 'zcode', []], ['mimo-code', 'mimo', []]
];
const products = [...basicTuiProducts, ['qwen', 'qwen', []]];
const catalogIds = ['kimi', 'grok', 'commandcode', 'cline', 'kilo',
  'github-copilot', 'devin', 'hermes', 'pi', 'omp', 'muse', 'zcode', 'mimo-code', 'qwen-code'];
for (const [index, [id]] of products.entries()) {
  const entry = seed.runtimes.find(item => item.id === `${id}-cli`);
  assert.ok(entry?.builtin && entry.enabled && entry.surface === 'pty', `${id} seeded and enabled`);
  assert.ok(fs.existsSync(path.join(builtinsDir, 'scripts', entry.script)));
  assert.match(source, new RegExp(`id: '${catalogIds[index]}'[^\\n]*cliRuntimeId: '${id}-cli'`));
}
assert.equal(seed.runtimes.some(item => item.id === 'antigravity-cli'), false);
assert.equal(seed.runtimes.some(item => item.id === 'deepseek-cli'), false, 'dsh has no bundled TUI profile');
assert.match(source, /id: 'deepseek'[^\n]*acpPresetId: 'deepseek'/);
assert.doesNotMatch(source.match(/id: 'deepseek'[^\n]*/)?.[0] ?? '', /cliRuntimeId:/,
  'DeepSeek exposes ACP chat without a native terminal');

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-bin-'));
const oldPath = process.env.PATH;
const oldExt = process.env.PATHEXT;
const suffix = process.platform === 'win32' ? '.cmd' : '';
for (const binary of new Set(products.map(item => item[1]))) {
  const file = path.join(binDir, binary + suffix);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
}
process.env.PATH = binDir + path.delimiter + (oldPath ?? '');
if (process.platform === 'win32') process.env.PATHEXT = '.CMD;.EXE';
try {
  for (const product of products) {
    const [id, binary, expected] = product;
    const mod = await import(pathToFileURL(path.join(builtinsDir, 'scripts', `${id}-cli.mjs`)).href);
    const { sessionId } = await mod.allocate();
    assert.ok(sessionId);
    const launch = await mod.resolveLaunch({ mode: 'start', sessionId, extraArgs: ['--test'] });
    assert.match(JSON.stringify(launch), new RegExp(binary.replace(/[.*+?^$()|[\]{}]/g, '\\$&')));
    for (const arg of [...expected, '--test']) assert.ok(JSON.stringify(launch).includes(arg), `${id} keeps ${arg}`);
    // Native-session behavior has its own contract test in runtime-qwen-cli.mjs.
    if (basicTuiProducts.includes(product)) {
      assert.equal(await mod.appendPrompt({ prompt: 'task', extraArgs: [] }), false);
      assert.equal(await mod.canResume({ sessionId }), false);
      await assert.rejects(mod.resolveLaunch({ mode: 'resume', sessionId }), /cannot restore or fork/);
      await assert.rejects(mod.resolveLaunch({ mode: 'fork', sessionId }), /cannot restore or fork/);
    }
  }
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = oldExt;
}

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-ud-'));
const compile = createSharedCompiler(root, fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-compile-')));
const compiled = compile('main/runtime/host.ts');
const { RuntimeHost } = await import(pathToFileURL(compiled).href);
const host = new RuntimeHost({ userDataDir: ud, builtinsDir });
await host.ensureSeeded();
for (const [id] of products) assert.equal(host.get(`${id}-cli`)?.enabled, true);
const registryFile = path.join(ud, 'agent-runtimes/registry.json');
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
registry.runtimes.push({ id: 'old-custom', label: 'Old', script: 'old-custom.mjs', builtin: false,
  enabled: true, surface: 'pty', updatedAt: 1 });
registry.runtimes = registry.runtimes.map(item => item.id === 'codex'
  ? { ...item, script: 'old-custom.mjs', builtin: false }
  : item);
fs.writeFileSync(registryFile, JSON.stringify(registry));
host.reload();
assert.equal(host.get('old-custom'), undefined);
assert.equal(host.get('codex'), undefined, 'a non-built-in same-id entry cannot shadow the seed');
assert.equal(host.list().some(item => item.id === 'old-custom'), false);
assert.equal(host.listEnabled().some(item => item.id === 'old-custom'), false);
await host.ensureSeeded();
assert.equal(host.get('codex')?.builtin, true, 'startup restores the built-in entry');
assert.equal(JSON.parse(fs.readFileSync(registryFile, 'utf8')).runtimes.some(item => !item.builtin), false,
  'startup removes unsupported runtime entries from the registry');
const spoofed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
spoofed.runtimes.push({ id: 'spoofed', label: 'Spoofed', script: 'spoofed.mjs', builtin: true,
  enabled: true, surface: 'pty', updatedAt: 1 });
spoofed.runtimes.find(item => item.id === 'codex').script = 'spoofed.mjs';
fs.writeFileSync(registryFile, JSON.stringify(spoofed));
host.reload();
assert.equal(host.get('spoofed'), undefined, 'registry flags cannot add a built-in ID');
assert.equal(host.get('codex')?.script, 'codex.mjs', 'launcher identity comes from the application seed');
await host.ensureSeeded();
assert.equal(JSON.parse(fs.readFileSync(registryFile, 'utf8')).runtimes.some(item => item.id === 'spoofed'), false);
assert.equal(typeof host.register, 'undefined', 'script registration API remains removed');
assert.equal(typeof host.publishChat, 'undefined', 'driver registration API remains removed');
const { getAcpPresets, ACP_AGENT_PRESETS } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/agents.ts')).href);
const presets = getAcpPresets(ud);
assert.deepEqual(presets.filter(item => !item.manifest), [...ACP_AGENT_PRESETS]);
assert.deepEqual(presets.filter(item => item.manifest).map(item => item.id), ['codebuddy-cli'], 'only the trusted built-in manifest adds a preset');
console.log('ok: built-in CLI coverage and legacy script/driver registration remains unavailable');
