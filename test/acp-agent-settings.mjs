/** Independent ACP product toggles: normalization, cached selection, preflight and transport refusal. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-agent-settings-'));
const compiler = createSharedCompiler(root, path.join(tmp, 'compiled'));
const load = rel => import(pathToFileURL(compiler(rel)));
try {
  // createSharedCompiler installs a complete Electron shim, including ipcMain
  // and the other named exports imported by the main-process graph. Keep it
  // intact so loading the ACP driver uses the same harness surface as the
  // other main-process tests.
  const { ConfigManager } = await load('main/config.ts');
  const manager = new ConfigManager();
  manager.update({ disabledAcpAgents: ['opencode', 'opencode'] });
  assert.deepEqual(new ConfigManager().get().disabledAcpAgents, ['opencode'], 'Real configuration save/load retains product preferences');
  manager.update({ dispatcherAppendPrompt: 'unrelated change' });
  assert.deepEqual(new ConfigManager().get().disabledAcpAgents, ['opencode']);
  const { normalizeDisabledAcpAgents, acpAgentEnabled } = await load('shared/acpAgentSettings.ts');
  assert.deepEqual(normalizeDisabledAcpAgents(['opencode', 'opencode', '../bad', 1, '', 'mimo-code']), ['opencode', 'mimo-code']);
  assert.deepEqual(normalizeDisabledAcpAgents('opencode'), []);
  assert.equal(acpAgentEnabled({}, 'kimi'), true);
  const { RuntimeAvailabilityReader } = await load('main/runtime/availability.ts');
  const { preflightRuntime } = await load('main/runtime/preflight.ts');
  const { AcpRuntimeDriver } = await load('main/agentSession/drivers/acp/driver.ts');
  const acp = { id: 'acp', label: 'ACP', surface: 'chat', enabled: true, builtin: true };
  let config = { workspace: '/fixture', disabledAcpAgents: [] };
  let probes = 0;
  const deps = { runtimes: { list: () => [acp], get: id => id === 'acp' ? acp : undefined }, config: { get: () => config },
    agentSessions: { probeRuntime: async () => ({ status: 'available', problems: [] }) } };
  const reader = new RuntimeAvailabilityReader(deps, { presets: () => [{ id: 'opencode', name: 'OpenCode' }, { id: 'kimi', name: 'Kimi' }],
    probe: async (_deps, id) => { probes++; return { id, status: 'available', ok: true, checkedAt: 1, problems: [] }; } });
  assert.deepEqual((await reader.read()).acpAgents.map(p => p.id), ['opencode', 'kimi']);
  const initialProbes = probes;
  config = { ...config, disabledAcpAgents: ['opencode'] };
  const disabled = await reader.read();
  assert.deepEqual(disabled.acpAgents.map(p => p.id), ['kimi']);
  assert.equal(probes, initialProbes, 'Changing selection must not require a new installation probe');
  assert.equal(disabled.runtimes.length, 1, 'Other ACP products keep their shared runtime');
  assert.equal(disabled.acpPreflights.opencode.status, 'available', 'Installation evidence remains visible for a disabled product');
  const denied = await preflightRuntime(deps, 'acp', { piModeId: 'opencode' });
  assert.equal(denied.status, 'disabled');
  assert.equal((await preflightRuntime(deps, 'acp', { piModeId: 'kimi' })).status, 'available');
  assert.equal((await preflightRuntime(deps, 'acp', { piModeId: 'opencode', inspectDisabledChat: true })).status, 'available');
  config = { ...config, disabledAcpAgents: ['opencode', 'kimi'] };
  assert.equal((await reader.read()).runtimes.length, 0);
  config = { ...config, disabledAcpAgents: [] };
  assert.deepEqual((await reader.read()).acpAgents.map(p => p.id), ['opencode', 'kimi'], 'Re-enabling restores cached available products');
  let launches = 0;
  config = { ...config, disabledAcpAgents: ['opencode'] };
  const driver = new AcpRuntimeDriver({ config: deps.config }, { userDataDir: tmp }, {
    resolveLaunch: () => { launches++; throw new Error('must not launch'); }
  });
  await assert.rejects(driver.connect({ acpAgent: 'opencode', cwd: tmp, log() {} }), /已停用/);
  assert.equal(launches, 0, 'Disabling must be checked before starting a native process');
  console.log('acp-agent-settings: normalization, live cached selection, preflight isolation and connect guard passed');
} finally {
  const resolved = path.resolve(tmp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('acp-agent-settings-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
