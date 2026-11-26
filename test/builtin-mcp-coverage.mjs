/** Seed -> engine-specific configuration -> ownership/status, using isolated files on all path platforms. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as jsonc } from 'jsonc-parser';
import { parse as toml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { spawnSync } from 'node:child_process';
import { createInboundCompiler } from './helpers/inbound-compile.mjs';
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-mcp-'));
const compile = createInboundCompiler(root, path.join(tmp, 'compiled'));
const load = relative => import(pathToFileURL(compile(relative)));
const { harnessMcpTargets } = await load('main/harnessIntegration/mcp.ts');
const { builtinMcpFile } = await load('main/harnessIntegration/builtinMcp.ts');
const { ensureInboundMcpSetup, readInboundMcpSetupStatus } = await load('main/inboundMcp/registrar.ts');
const { harnessMcpLaunch, harnessMcpEntry } = await load('main/harnessIntegration/mcpEntry.ts');
const { normalizeHarnessIntegration } = await load('shared/harnessIntegration.ts');
const { builtinHarnessEntries } = await load('main/harnessIntegration/seed.ts');
const entries = builtinHarnessEntries();
const launch = { command: process.execPath, args: [path.join(tmp, 'host entry.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
const write = (file, raw) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw); };
try {
  for (const entry of entries) {
    assert.ok(entry.integrations?.mcp, `${entry.id}: built-in MCP declaration must exist`);
    normalizeHarnessIntegration(entry.integrations);
  }
  for (const platform of ['win32', 'darwin', 'linux']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const homeDir = platform === 'win32' ? 'C:\\fixture' : '/fixture';
    const context = { platform, homeDir, env: {} };
    const targets = harnessMcpTargets(entries, context);
    assert.equal(targets.statuses.some(s => s.state === 'error' || s.state === 'unsupported'), false, JSON.stringify(targets.statuses));
    assert.equal(targets.files.length, entries.filter(entry => entry.integrations.mcp.strategy === 'config-file').length);
    assert.ok(targets.files.every(file => paths.isAbsolute(file.path)));
    assert.equal(targets.files.find(file => file.id === 'cline-cli').entryStyle, platform === 'win32' ? 'cline-shell' : undefined);
    assert.equal(targets.files.find(file => file.id === 'commandcode-cli').entryStyle, platform === 'win32' ? 'stdio-transport-shell' : 'stdio-transport');
    const codebuddy = targets.files.find(file => file.id === 'codebuddy-cli');
    assert.equal(codebuddy.path, paths.join(homeDir, '.codebuddy', '.mcp.json'));
    assert.ok(targets.statuses.filter(s => ['runtime:pi-external-cli', 'runtime:omp-cli', 'runtime:pi-external', 'runtime:omp'].includes(s.id)).every(s => s.state === 'session'));
    const custom = platform === 'win32' ? 'D:\\custom' : '/custom';
    for (const [dialect, variable, suffix] of [['kimi', 'KIMI_CODE_HOME', 'mcp.json'], ['copilot', 'COPILOT_HOME', 'mcp-config.json'], ['hermes', 'HERMES_HOME', 'config.yaml'], ['mimo', 'MIMOCODE_HOME', 'config/mimocode.json'], ['qwen', 'QWEN_HOME', 'settings.json']]) {
      assert.equal(builtinMcpFile(dialect, { ...context, env: { [variable]: custom } }).path, paths.join(custom, suffix));
      assert.throws(() => builtinMcpFile(dialect, { ...context, env: { [variable]: 'relative' } }), /absolute/);
    }
    assert.equal(builtinMcpFile('kimi', { ...context, env: { KIMI_SHARE_DIR: custom } }).path, paths.join(custom, 'mcp.json'));
    assert.match(builtinMcpFile('kimi', context).path, /[\\/]\.kimi-code[\\/]mcp.json$/);
    assert.match(builtinMcpFile('devin', context).path, /[\\/]mcp_config.json$/);
    assert.throws(() => builtinMcpFile('mimo', { ...context, env: { MIMOCODE_CONFIG_CONTENT: '{}' } }), /override/);
  }
  const legacyContext = { homeDir: path.join(tmp, 'legacy-home'), configDir: path.join(tmp, 'legacy-config'), env: {} };
  const oldKimi = path.join(legacyContext.homeDir, '.kimi', 'mcp.json');
  const oldDevin = path.join(legacyContext.configDir, 'devin', 'config.json');
  write(oldKimi, '{}');
  write(oldDevin, '{}');
  assert.equal(builtinMcpFile('kimi', legacyContext).path, oldKimi);
  assert.equal(builtinMcpFile('devin', legacyContext).path, oldDevin);
  const currentDevin = path.join(legacyContext.configDir, 'devin', 'mcp_config.json');
  write(currentDevin, '{}');
  assert.equal(builtinMcpFile('devin', legacyContext).path, currentDevin);
  const context = { homeDir: path.join(tmp, 'home'), env: {} };
  const targets = harnessMcpTargets(entries, context);
  const buddy = entries.find(entry => entry.id === 'codebuddy-cli');
  const legacyBuddy = path.join(context.homeDir, '.codebuddy', 'mcp.json');
  write(legacyBuddy, '// legacy server configuration\n{"mcpServers":{"existing":{"command":"keep"}}}');
  assert.equal(harnessMcpTargets([buddy], context).files[0].path, legacyBuddy);
  for (const file of targets.files) {
    const raw = file.format === 'yaml' ? '# keep yaml comment\nmodel: kept\nmcp_servers:\n  other:\n    command: keep\n'
      : file.format === 'toml' ? 'model = "kept"\n' : '{"model":"kept"}';
    write(file.path, raw);
  }
  const options = { files: targets.files, ownershipFile: path.join(tmp, 'owned.json') };
  const configured = ensureInboundMcpSetup(launch, options);
  assert.equal(configured.ok, true, JSON.stringify(configured));
  assert.equal(readInboundMcpSetupStatus(launch, options).ok, true);
  const stable = targets.files.map(file => [fs.readFileSync(file.path, 'utf8'), fs.statSync(file.path).mtimeMs]);
  assert.equal(ensureInboundMcpSetup(launch, options).ok, true);
  assert.deepEqual(targets.files.map(file => [fs.readFileSync(file.path, 'utf8'), fs.statSync(file.path).mtimeMs]), stable);
  for (const file of targets.files) {
    const raw = fs.readFileSync(file.path, 'utf8');
    const value = file.format === 'toml' ? toml(raw) : file.format === 'yaml' ? parseDocument(raw).toJS() : jsonc(raw);
    let entry;
    {
      assert.equal(value.model, 'kept');
      entry = (file.serversKey ?? ['mcpServers']).reduce((v, k) => v[k], value).muster;
      if (file.format === 'yaml') assert.ok(raw.startsWith('# keep yaml comment'));
    }
    if (!file.entryStyle?.endsWith('shell')) assert.deepEqual(harnessMcpLaunch(entry, file), launch, `${file.id}: exact engine entry round-trip`);
    else { assert.equal(entry.command, 'cmd.exe'); assert.ok(entry.args.at(-1).includes('host entry.mjs')); }
    if (file.requiresMcpEnabled) assert.equal(value.features.mcp, true);
    for (const [key, expected] of Object.entries(file.rootDefaults ?? {})) assert.equal(value[key], expected);
    const corrupt = file.format === 'yaml' ? 'x: [unterminated' : '{broken';
    write(file.path, corrupt);
    assert.equal(ensureInboundMcpSetup(launch, { ...options, files: [file] }).ok, false);
    assert.equal(fs.readFileSync(file.path, 'utf8'), corrupt);
    write(file.path, raw);
  }
  const muse = targets.files.find(file => file.id === 'muse-cli');
  const museValue = JSON.parse(fs.readFileSync(muse.path)); delete museValue.schema_version; write(muse.path, JSON.stringify(museValue));
  assert.equal(readInboundMcpSetupStatus(launch, { ...options, files: [muse] }).ok, false, 'missing Muse document version cannot be reported configured');
  assert.equal(ensureInboundMcpSetup(launch, { ...options, files: [muse] }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(muse.path)).schema_version, 1);
  write(muse.path, '{"schema_version":2,"model":"kept"}');
  assert.equal(ensureInboundMcpSetup(launch, { ...options, files: [muse] }).ok, true);
  const newerMuse = JSON.parse(fs.readFileSync(muse.path, 'utf8'));
  assert.equal(newerMuse.schema_version, 2);
  assert.equal(newerMuse.model, 'kept');
  assert.ok(newerMuse.mcp_servers.muster);
  if (process.platform === 'win32') {
    const directory = path.join(tmp, '中文 with spaces'); fs.mkdirSync(directory);
    const script = path.join(directory, 'MCP entry.mjs'), proof = path.join(directory, 'proof.json');
    write(script, `import fs from 'node:fs';fs.writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));`);
    const native = { command: process.execPath, args: [script, proof, 'kept&literal'] };
    for (const id of ['cline-cli', 'commandcode-cli']) {
      const file = targets.files.find(file => file.id === id);
      const encoded = harnessMcpEntry(native, file);
      // Both vendor Windows clients use shell:true: reproduce their actual launch boundary.
      fs.rmSync(proof, { force: true });
      const result = spawnSync(encoded.command, encoded.args, { shell: true, windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(proof)), ['kept&literal']);
      assert.throws(() => harnessMcpEntry({ ...native, args: ['C:\\bad%path\\entry.mjs'] }, file), /cannot safely/);
      write(file.path, JSON.stringify({ mcpServers: { muster: { command: launch.command, args: launch.args, env: launch.env } } }));
      assert.equal(readInboundMcpSetupStatus(launch, { ...options, files: [file] }).ok, false);
      assert.equal(ensureInboundMcpSetup(launch, { ...options, files: [file] }).ok, true, `upgrade owned plain entry into a quoted ${id} Windows launch`);
      if (id === 'commandcode-cli') {
        write(file.path, JSON.stringify({ mcpServers: { muster: { transport: 'stdio', enabled: true, ...launch } } }));
        assert.equal(readInboundMcpSetupStatus(launch, { ...options, files: [file] }).ok, false);
        assert.equal(ensureInboundMcpSetup(launch, { ...options, files: [file] }).ok, true, 'upgrade the previous owned Command Code transport entry');
      }
    }
  }
  const zcode = targets.files.find(file => file.id === 'zcode-cli');
  const disabled = '{"features":{"mcp":false}}'; write(zcode.path, disabled);
  assert.equal(ensureInboundMcpSetup(launch, { ...options, files: [zcode] }).ok, false);
  assert.equal(fs.readFileSync(zcode.path, 'utf8'), disabled);
  for (const id of ['kilo-cli', 'mimo-code-cli']) {
    const file = targets.files.find(file => file.id === id);
    write(file.path, '{"mcp":{"servers":{"type":"remote","url":"https://example.invalid"}}}');
    assert.equal(ensureInboundMcpSetup(launch, { ...options, files: [file] }).ok, true, 'OpenCode layout checks must not reject another engine server called servers');
  }
  console.log('builtin-mcp-coverage: all built-ins declared; three-platform roots, all active config files, dialects, YAML preservation, idempotence, opt-out and corruption passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
