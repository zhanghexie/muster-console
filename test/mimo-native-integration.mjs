/** Native MiMo registration, cross-platform discovery, permission policy and retired preset migration. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-native-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const load = file => import(pathToFileURL(compile(file)));
const { HARNESS_CATALOG } = await load('shared/harnessCatalog.ts');
const { ACP_AGENT_PRESETS, resolveAcpLaunch, mimoInstallCandidates } = await load('main/agentSession/drivers/acp/agents.ts');
const { acpLaunchEnvironment } = await load('main/agentSession/drivers/acp/launchPolicy.ts');
const { RuntimeHost } = await load('main/runtime/host.ts');
const { historicalServiceRuntime, sessionRuntimeLookup } = await load('shared/retiredServiceRuntimes.ts');
const { isChatRuntimeId, getChatCapabilities } = await load('shared/agentRuntimeCapabilities.ts');
const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
try {
  const mimo = HARNESS_CATALOG.find(entry => entry.id === 'mimo-code');
  assert.equal(mimo.runtimeId, 'acp');
  assert.equal(mimo.transport, 'acp');
  assert.equal(mimo.acpPresetId, 'mimo-code');
  assert.ok(!HARNESS_CATALOG.some(entry => entry.id === 'glm' || entry.id === 'mimo'));
  assert.ok(HARNESS_CATALOG.some(entry => entry.id === 'zcode'));
  const preset = ACP_AGENT_PRESETS.find(entry => entry.id === 'mimo-code');
  assert.deepEqual(preset.commands, ['mimo']);
  assert.deepEqual(preset.args, ['acp']);
  assert.deepEqual(mimoInstallCandidates('win32', 'C:\\Users\\fixture'), ['C:\\Users\\fixture\\.mimocode\\bin\\mimo.exe']);
  assert.deepEqual(mimoInstallCandidates('darwin', '/Users/fixture'), ['/Users/fixture/.mimocode/bin/mimo']);
  assert.deepEqual(mimoInstallCandidates('linux', '/home/fixture'), ['/home/fixture/.mimocode/bin/mimo']);
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  const executable = path.join(bin, process.platform === 'win32' ? 'mimo.cmd' : 'mimo');
  fs.writeFileSync(executable, process.platform === 'win32' ? '@echo off\r\necho %*\r\n' : '#!/bin/sh\nprintf "%s" "$1"\n', { mode: 0o755 });
  process.env.PATH = bin; process.env.PATHEXT = '.EXE;.CMD;.BAT';
  const launch = resolveAcpLaunch('mimo-code');
  assert.equal(process.platform === 'win32' ? launch.executable?.toLowerCase() : launch.executable,
    process.platform === 'win32' ? executable.toLowerCase() : executable, 'native MiMo command is resolved, independent of Claude');
  assert.equal(launch.args.at(-1).includes('acp'), true);
  assert.match(resolveAcpLaunch('mimo-code', undefined, [{ ...preset, commands: ['missing-mimo-fixture'] }]).error, /Cannot find MiMo Code/);
  const inherited = { MIMOCODE_CONFIG_CONTENT: JSON.stringify({ provider: { fixture: {} }, agent: { custom: { temperature: 0.4 } } }), MIMOCODE_PERMISSION: '{"*":"allow"}', MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS: 'true' };
  const env = acpLaunchEnvironment('mimo-code', inherited);
  for (const [key, value] of Object.entries(inherited)) assert.equal(env[key], value, key);
  assert.equal(acpLaunchEnvironment('mimo-code', { MIMOCODE_CONFIG_CONTENT: '{broken' }).MIMOCODE_CONFIG_CONTENT, '{broken');
  const userData = path.join(tmp, 'user-data');
  const openHost = () => new RuntimeHost({ userDataDir: userData, builtinsDir: path.join(root, 'src/main/runtime/builtins') });
  let host = openHost();
  await host.ensureSeeded();
  assert.ok(!host.list().some(entry => entry.id === 'glm' || entry.id === 'mimo'));
  const registryFile = path.join(userData, 'agent-runtimes', 'registry.json');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  registry.runtimes.push({ id: 'glm', label: 'GLM Coding Plan', builtin: true, enabled: true, surface: 'chat' });
  registry.runtimes.push({ id: 'mimo', label: 'MiMo Token Plan', builtin: true, enabled: true, surface: 'chat' });
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  const legacyData = path.join(userData, 'agents/claude-services/glm/connection.json');
  fs.mkdirSync(path.dirname(legacyData), { recursive: true }); fs.writeFileSync(legacyData, 'legacy-data-fixture');
  host = openHost();
  await host.ensureSeeded();
  assert.equal(host.get('glm'), undefined, 'old factory service plan is retired on upgrade');
  assert.equal(host.get('mimo'), undefined, 'old MiMo service plan is not rebound to native MiMo');
  assert.equal(isChatRuntimeId('mimo'), true, 'saved MiMo service chat remains readable');
  assert.equal(historicalServiceRuntime('mimo').enabled, false, 'history classification never enables execution');
  assert.equal(getChatCapabilities('mimo').images, false, 'removed engine has no advertised Claude capabilities');
  assert.equal(sessionRuntimeLookup(host.list()).mimo.surface, 'chat', 'center pane renders old transcript as chat');
  assert.equal(historicalServiceRuntime('constructor'), undefined, 'prototype names cannot become runtime identities');
  assert.equal(fs.readFileSync(legacyData, 'utf8'), 'legacy-data-fixture', 'no credential data deletion or reassignment');
  const migrated = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  migrated.runtimes.push({ id: 'mimo', label: 'User custom MiMo', builtin: false, enabled: true, surface: 'pty', script: 'custom.mjs' });
  fs.writeFileSync(registryFile, JSON.stringify(migrated));
  host = openHost();
  await host.ensureSeeded();
  assert.equal(host.get('glm'), undefined, 'retirement remains idempotent');
  assert.equal(host.get('mimo'), undefined, 'legacy scripts cannot activate a reserved runtime ID');
  const custom = host.prepareManifest({ id: 'mimo-custom', label: 'User custom MiMo', terminal: { command: process.execPath, args: [] } });
  host.registerManifest(custom);
  host = openHost();
  await host.ensureSeeded();
  assert.equal(host.get('mimo-custom').builtin, false, 'approved manifest registrations are preserved');
  assert.equal(sessionRuntimeLookup(host.list())['mimo-custom'].surface, 'pty');
  console.log('mimo-native-integration: native ACP identity, three-platform paths, permissions and safe legacy migration passed');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
