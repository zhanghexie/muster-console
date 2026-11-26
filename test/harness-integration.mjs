/** Brand-free declarations, three-platform paths and JSON/TOML setup; no real CLI files. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { createInboundCompiler } from './helpers/inbound-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-integration-'));
const compile = createInboundCompiler(root, path.join(temporary, 'compiled'));
const load = relative => import(pathToFileURL(compile(relative)));
const { normalizeHarnessIntegration } = await load('shared/harnessIntegration.ts');
const { resolveHarnessPath, getHarnessConfigDir } = await load('main/harnessIntegration/resolve.ts');
const { harnessMcpTargets } = await load('main/harnessIntegration/mcp.ts');
const { ensureInboundMcpSetup, readInboundMcpSetupStatus } = await load('main/inboundMcp/registrar.ts');
const home = path.join(temporary, 'home'); fs.mkdirSync(home);
const entry = (id, mcp) => ({ id, label: `Label ${id}`, enabled: true, integrations: { mcp } });
const launch = { command: process.execPath, args: [path.join(temporary, 'stdio.mjs')] };
const write = (file, raw) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw); };
try {
  for (const child of ['/absolute', '\\network', 'C:\\absolute', 'a/../b', './a', 'a//b', 'a\\..\\b']) {
    assert.throws(() => normalizeHarnessIntegration({ mcp: { strategy: 'config-file', format: 'json', base: 'home', path: child } }));
    assert.throws(() => normalizeHarnessIntegration({ skillDirectories: [{ id: 'd', base: 'home', path: 'safe', platformPaths: { linux: child } }] }));
  }
  assert.throws(() => normalizeHarnessIntegration({ skillTargets: [{ id: 'missing', label: 'Missing', kind: 'cli', skillSupport: 'native-directory', directoryIds: ['absent'] }] }));
  assert.throws(() => normalizeHarnessIntegration({ mcp: { strategy: 'config-file', id: '__proto__', format: 'json', base: 'home', path: 'safe' } }));
  const cases = [
    ['win32', 'C:\\fixture', { APPDATA: 'C:\\roaming' }, 'C:\\roaming', 'C:\\fixture\\win\\skills'],
    ['darwin', '/fixture', {}, '/fixture/Library/Application Support', '/fixture/mac/skills'],
    ['linux', '/fixture', { XDG_CONFIG_HOME: '/xdg' }, '/xdg', '/fixture/linux/skills']
  ];
  for (const [platform, homeDir, env, configDir, expected] of cases) {
    const context = { platform, homeDir, env };
    assert.equal(getHarnessConfigDir(context), configDir);
    assert.equal(resolveHarnessPath({ base: 'home', path: 'fallback', platformPaths: { win32: 'win/skills', darwin: 'mac/skills', linux: 'linux/skills' } }, context), expected);
    assert.throws(() => resolveHarnessPath({ base: 'workspace', path: 'skills' }, context));
  }
  const declarations = [entry('unknown-brand-json', { strategy: 'config-file', format: 'json', base: 'home', path: '.unseen/settings.json', serversKey: ['tools', 'servers'] }), entry('unknown-brand-toml', { strategy: 'config-file', format: 'toml', base: 'config', path: 'unseen/config.toml', serversKey: ['mcp_servers'] }), entry('native-engine', { strategy: 'native' }), entry('session-engine', { strategy: 'session' }), entry('unsupported-engine', { strategy: 'unsupported', reason: 'Fixture unsupported' })];
  const targets = harnessMcpTargets(declarations, { homeDir: home, configDir: path.join(home, '.config') });
  assert.equal(targets.files.length, 2); assert.deepEqual(targets.statuses.map(value => value.state), ['native', 'session', 'unsupported']);
  write(targets.files[0].path, '{"theme":"kept","tools":{"servers":{"other":{"command":"fixture"}}}}');
  write(targets.files[1].path, 'model = "fixture"\n[mcp_servers.other]\ncommand = "fixture-other"\n');
  const options = { files: targets.files, ownershipFile: path.join(temporary, 'userData/managed.json') };
  assert.equal(ensureInboundMcpSetup(launch, options).ok, true);
  const toml = parseToml(fs.readFileSync(targets.files[1].path, 'utf8'));
  assert.equal(toml.model, 'fixture'); assert.equal(toml.mcp_servers.other.command, 'fixture-other'); assert.deepEqual(toml.mcp_servers.muster.args, launch.args);
  const json = JSON.parse(fs.readFileSync(targets.files[0].path, 'utf8')); assert.equal(json.theme, 'kept'); assert.equal(json.tools.servers.other.command, 'fixture');
  const stable = targets.files.map(file => [fs.readFileSync(file.path, 'utf8'), fs.statSync(file.path).mtimeMs]);
  assert.equal(ensureInboundMcpSetup(launch, options).ok, true); assert.equal(readInboundMcpSetupStatus(launch, options).ok, true);
  assert.deepEqual(targets.files.map(file => [fs.readFileSync(file.path, 'utf8'), fs.statSync(file.path).mtimeMs]), stable);
  for (const bad of ['[broken', 'mcp_servers = []\n', '[mcp_servers.muster]\ncommand = "foreign"\nargs = []\n']) {
    write(targets.files[1].path, bad); assert.equal(ensureInboundMcpSetup(launch, options).ok, false); assert.equal(fs.readFileSync(targets.files[1].path, 'utf8'), bad);
  }
  const workspace = entry('multi-root', { strategy: 'config-file', format: 'json', base: 'workspace', path: '.fixture/mcp.json' });
  assert.equal(harnessMcpTargets([workspace], { homeDir: home }).statuses[0].state, 'pending-workspace');
  assert.equal(harnessMcpTargets([workspace], { homeDir: home, workspaceRoots: [{ id: 'a', path: path.join(home, 'a') }, { id: 'b', path: path.join(home, 'b') }] }).files.length, 2);
  const duplicate = harnessMcpTargets([declarations[0], entry('duplicate', declarations[0].integrations.mcp)], { homeDir: home });
  assert.equal(duplicate.statuses[0].state, 'error');
  const privateRoot = path.join(temporary, '.muster'); fs.mkdirSync(privateRoot);
  const alias = path.join(home, 'private-alias'); fs.symlinkSync(privateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(harnessMcpTargets([entry('unsafe', { strategy: 'config-file', format: 'json', base: 'home', path: 'private-alias/settings.json' })], { homeDir: home }).statuses[0].state, 'error');
  assert.deepEqual(fs.readdirSync(privateRoot), []);
  const oldParent = path.join(home, 'old-parent'), newParent = path.join(home, 'new-parent'), moving = path.join(home, 'moving-parent');
  fs.mkdirSync(oldParent); fs.mkdirSync(newParent); fs.symlinkSync(oldParent, moving, process.platform === 'win32' ? 'junction' : 'dir');
  const movingOptions = { files: [{ id: 'moving', label: 'Moving parent', path: path.join(moving, 'settings.json'), format: 'json' }], ownershipFile: path.join(temporary, 'moving-ledger.json') };
  const originalOpen = fs.openSync; let moved = false;
  try {
    fs.openSync = function (file, ...args) {
      if (!moved && String(file).includes('settings.json.') && String(file).endsWith('.tmp')) {
        moved = true; fs.unlinkSync(moving); fs.symlinkSync(newParent, moving, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return originalOpen.call(this, file, ...args);
    };
    assert.equal(ensureInboundMcpSetup(launch, movingOptions).ok, false);
  } finally { fs.openSync = originalOpen; }
  assert.equal(moved, true); assert.deepEqual(fs.readdirSync(oldParent), []); assert.deepEqual(fs.readdirSync(newParent), [], 'retargeting a logical parent cannot redirect even a temporary write');

  console.log('harness-integration: validation, three-platform paths, unknown brands, JSON/TOML preservation, idempotence, conflict/corruption, multi-root and private-alias fixtures passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
