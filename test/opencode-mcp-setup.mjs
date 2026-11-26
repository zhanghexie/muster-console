/** OpenCode MCP layouts, JSONC preservation and three-platform paths in isolated files only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { createInboundCompiler } from './helpers/inbound-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mcp-'));
const compile = createInboundCompiler(root, path.join(temporary, 'compiled'));
const load = file => import(pathToFileURL(compile(file)));
const { harnessMcpTargets } = await load('main/harnessIntegration/mcp.ts');
const { openCodeMcpFile } = await load('main/harnessIntegration/opencode.ts');
const { ensureInboundMcpSetup, readInboundMcpSetupStatus } = await load('main/inboundMcp/registrar.ts');
const { normalizeHarnessIntegration } = await load('shared/harnessIntegration.ts');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'src/main/runtime/builtins/registry.json'), 'utf8')).runtimes.find(entry => entry.id === 'opencode');
const launch = { command: process.execPath, args: [path.join(temporary, 'stdio.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
const write = (file, raw) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw); };
try {
  assert.equal(normalizeHarnessIntegration(seed.integrations).mcp.dialect, 'opencode');
  for (const [platform, home, expected] of [['win32', 'C:\\fixture', 'C:\\fixture\\.config\\opencode\\opencode.json'], ['darwin', '/fixture', '/fixture/.config/opencode/opencode.json'], ['linux', '/fixture', '/fixture/.config/opencode/opencode.json']]) {
    assert.equal(openCodeMcpFile({ platform, homeDir: home, env: {} }).path, expected);
    const xdg = platform === 'win32' ? 'C:\\xdg' : '/xdg';
    assert.equal(openCodeMcpFile({ platform, homeDir: home, env: { XDG_CONFIG_HOME: xdg } }).path, (platform === 'win32' ? path.win32 : path.posix).join(xdg, 'opencode/opencode.json'));
    for (const env of [{ XDG_CONFIG_HOME: 'relative' }, { OPENCODE_CONFIG: 'relative.json' }, { OPENCODE_CONFIG_DIR: xdg }, { OPENCODE_CONFIG_CONTENT: '{}' }]) assert.throws(() => openCodeMcpFile({ platform, homeDir: home, env }));
  }
  for (const layout of ['flat', 'nested']) {
    const nested = layout === 'nested';
    const homeDir = path.join(temporary, layout), context = { homeDir, env: {} };
    const file = path.join(homeDir, '.config/opencode/opencode.jsonc');
    const other = '"other":{"type":"remote","url":"https://example.invalid/mcp"}';
    write(file, `// preserve this exact comment\n{ "model": "fixture", "mcp": { ${nested ? '"servers":{' + other + '}, "timeout": 123' : other}, }, }\n`);
    const targets = harnessMcpTargets([seed], context);
    assert.deepEqual(targets.statuses, []); assert.equal(targets.files[0].path, file);
    const options = { files: targets.files, ownershipFile: path.join(homeDir, 'managed.json') };
    assert.equal(ensureInboundMcpSetup(launch, options).ok, true);
    const raw = fs.readFileSync(file, 'utf8'), value = parse(raw), servers = nested ? value.mcp.servers : value.mcp;
    assert.ok(raw.startsWith('// preserve this exact comment\n')); assert.equal(value.model, 'fixture'); assert.equal(servers.other.url, 'https://example.invalid/mcp');
    assert.deepEqual(servers.muster, { type: 'local', command: [launch.command, ...launch.args], environment: launch.env });
    if (nested) assert.equal(value.mcp.timeout, 123);
    assert.equal(fs.existsSync(file.replace(/jsonc$/, 'json')), false);
    const before = fs.statSync(file).mtimeMs;
    assert.equal(ensureInboundMcpSetup(launch, options).ok, true); assert.equal(readInboundMcpSetupStatus(launch, options).ok, true);
    assert.equal(fs.statSync(file).mtimeMs, before); assert.equal(fs.readFileSync(file, 'utf8'), raw);
    const upgraded = { ...launch, args: [path.join(temporary, 'new-stdio.mjs')] };
    assert.equal(ensureInboundMcpSetup(upgraded, options).ok, true); assert.equal(readInboundMcpSetupStatus(upgraded, options).ok, true);
    for (const broken of ['{broken', '{"mcp":[]}', JSON.stringify({ mcp: nested ? { servers: { muster: { type: 'local', command: ['foreign'], disabled: true } } } : { muster: { type: 'local', command: ['foreign'] } } }), JSON.stringify({ mcp: nested ? { old: { type: 'local', command: ['old'] } } : { servers: {} } })]) {
      write(file, broken); assert.equal(ensureInboundMcpSetup(launch, options).ok, false); assert.equal(fs.readFileSync(file, 'utf8'), broken);
    }
    write(file.replace(/jsonc$/, 'json'), '{}');
    assert.equal(harnessMcpTargets([seed], context).statuses[0].state, 'error');
  }
  const custom = path.join(temporary, 'custom.jsonc');
  assert.equal(openCodeMcpFile({ homeDir: temporary, env: { OPENCODE_CONFIG: custom } }).path, custom);
  assert.throws(() => openCodeMcpFile({ homeDir: temporary, env: { XDG_CONFIG_HOME: path.join(temporary, '.muster') } }));
  const missing = harnessMcpTargets([seed], { homeDir: temporary, env: {} });
  assert.deepEqual(missing.files[0].serversKey, ['mcp', 'servers']);
  assert.deepEqual(harnessMcpTargets([seed], { homeDir: temporary, env: {}, defaultOpenCodeLayout: 'flat' }).files[0].serversKey, ['mcp']);
  const customContext = { homeDir: temporary, env: { OPENCODE_CONFIG: custom } };
  write(custom, '{"mcp":{"servers":{"type":"local","command":["fixture"]}}}');
  assert.deepEqual(openCodeMcpFile(customContext).serversKey, ['mcp'], 'a flat server can be named servers');
  write(custom, '{"mcp":{"servers":{},"legacy":{"type":"local","command":["fixture"]}}}');
  assert.throws(() => openCodeMcpFile(customContext), /混用了两种/);
  console.log('opencode-mcp-setup: flat/nested layout, JSONC, three platforms, upgrades and ownership passed without a CLI version');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
