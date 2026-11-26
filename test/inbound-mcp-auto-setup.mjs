/** Strict automatic CLI setup: isolated homes only, real filesystem plus deterministic I/O failures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInboundCompiler } from './helpers/inbound-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-mcp-auto-'));
const compile = createInboundCompiler(root, path.join(temporary, 'compiled'));
const { defaultInboundMcpEngineFiles, ensureInboundMcpSetup, readInboundMcpSetupStatus } = await import(pathToFileURL(compile('main/inboundMcp/registrar.ts')));
const { inboundMcpFingerprint } = await import(pathToFileURL(compile('shared/inboundMcp.ts')));
const launch = { command: process.execPath, args: [path.join(temporary, 'host-entry.mjs')] };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); };
const fixture = name => {
  const home = path.join(temporary, name, 'home');
  const options = { files: defaultInboundMcpEngineFiles(home), ownershipFile: path.join(temporary, name, 'userData', 'inbound-mcp-managed.json') };
  fs.mkdirSync(home, { recursive: true }); return options;
};
let checks = 0;
const test = (label, run) => { run(); console.log(`ok ${++checks} - ${label}`); };
try {
  test('status is read-only; startup ensure preserves unrelated settings and is byte/mtime/inode idempotent', () => {
    const options = fixture('normal');
    const other = { command: 'npx', args: ['third-party'], env: { SECRET: 'fixture-value' } };
    for (const file of options.files) write(file.path, { theme: 'user-choice', mcpServers: { keep: other } });
    assert.equal(readInboundMcpSetupStatus(launch, options).ok, false);
    assert.equal(fs.existsSync(options.ownershipFile), false);
    assert.equal(ensureInboundMcpSetup(launch, options).ok, true);
    const before = options.files.map(file => [file.path, fs.readFileSync(file.path, 'utf8'), fs.statSync(file.path)]);
    const ledger = fs.readFileSync(options.ownershipFile, 'utf8');
    assert.equal(readInboundMcpSetupStatus(launch, options).ok, true);
    assert.equal(ensureInboundMcpSetup(launch, options).ok, true);
    for (const [file, bytes, stat] of before) {
      assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs); assert.equal(fs.statSync(file).ino, stat.ino);
      assert.equal(json(file).theme, 'user-choice'); assert.deepEqual(json(file).mcpServers.keep, other);
    }
    assert.equal(fs.readFileSync(options.ownershipFile, 'utf8'), ledger);
  });
  test('invalid JSON and root/server-map schemas preserve exact original bytes, while other engines can configure', () => {
    for (const [name, input] of [['json', '{"secret":"fixture",'], ['array', '[]'], ['null', 'null'], ['servers-array', '{"mcpServers":[]}'], ['servers-null', '{"mcpServers":null}']]) {
      const options = fixture(name); const bad = options.files[2]; write(bad.path, input);
      const result = ensureInboundMcpSetup(launch, options);
      assert.deepEqual(result.engines.map(engine => engine.state), ['configured', 'configured', 'error']);
      assert.equal(fs.readFileSync(bad.path, 'utf8'), input);
      assert.equal(readInboundMcpSetupStatus(launch, options).ok, false);
    }
  });
  test('unknown same-name entries, spoofed script basenames and extra env/flags never authorize overwrite', () => {
    for (const entry of [null, 'invalid', { command: 'unrelated', args: ['/attacker/stdioEntry.mjs'] }, { ...launch, disabled: true }, { ...launch, env: { NODE_OPTIONS: '--require=fixture' } }]) {
      const options = fixture(`conflict-${checks}-${Math.random().toString(16).slice(2)}`); const file = options.files[0].path;
      write(file, { custom: true, mcpServers: { muster: entry } }); const original = fs.readFileSync(file, 'utf8');
      assert.equal(ensureInboundMcpSetup(launch, options).engines[0].state, 'error');
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    }
  });
  test('known Windows/macOS/Linux launch identities upgrade by exact managed history, not path basename', () => {
    for (const [index, command] of ['C:/Program Files/muster/muster.exe', '/Applications/muster.app/Contents/MacOS/muster', '/opt/muster/muster'].entries()) {
      const options = fixture(`platform-${index}`), old = { command, args: [`${command}.old/stdioEntry.mjs`], env: { ELECTRON_RUN_AS_NODE: '1' } };
      assert.equal(ensureInboundMcpSetup(old, options).ok, true);
      const next = { ...old, args: [`${command}.new/stdioEntry.mjs`] };
      assert.equal(readInboundMcpSetupStatus(next, options).ok, false);
      assert.equal(ensureInboundMcpSetup(next, options).ok, true);
      assert.deepEqual(json(options.files[0].path).mcpServers.muster, next);
    }
  });
  test('legacy confirmed fingerprint migrates its exact original shape; unexpected env is still a conflict', () => {
    const old = { command: '/old/trusted-host', args: ['/old/trusted-entry.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    const options = fixture('legacy'); options.legacyTrustedFingerprint = inboundMcpFingerprint(old);
    for (const file of options.files) write(file.path, { mcpServers: { muster: old } });
    assert.equal(ensureInboundMcpSetup(launch, options).ok, true);
    const bad = fixture('legacy-env'); bad.legacyTrustedFingerprint = inboundMcpFingerprint(old);
    write(bad.files[0].path, { mcpServers: { muster: { ...old, env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=evil' } } } });
    assert.equal(ensureInboundMcpSetup(launch, bad).engines[0].state, 'error');
  });
  test('per-engine partial failure retains old ownership for a later path upgrade and retry', () => {
    const options = fixture('partial'); assert.equal(ensureInboundMcpSetup(launch, options).ok, true);
    const next = { ...launch, args: [path.join(temporary, 'entry-2.mjs')] };
    const original = fs.renameSync;
    const blocked = fs.realpathSync(options.files[2].path);
    try {
      fs.renameSync = function (file, target) {
        if (target === blocked) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        return original.call(this, file, target);
      };
      const result = ensureInboundMcpSetup(next, options); assert.deepEqual(result.engines.map(engine => engine.state), ['configured', 'configured', 'error']);
    } finally { fs.renameSync = original; }
    const ledger = json(options.ownershipFile); assert.ok(ledger.engines.gemini.some(item => item.args[0] === launch.args[0]));
    const latest = { ...launch, args: [path.join(temporary, 'entry-3.mjs')] };
    assert.equal(ensureInboundMcpSetup(latest, options).ok, true);
    for (const file of options.files) assert.deepEqual(json(file.path).mcpServers.muster.args, latest.args);
  });
  test('ownership write failure remains visible to subsequent read-only status even when config itself matches', () => {
    const options = fixture('ledger-permission'); assert.equal(ensureInboundMcpSetup(launch, options).ok, true); fs.unlinkSync(options.ownershipFile);
    const original = fs.renameSync;
    const blocked = path.join(fs.realpathSync(path.dirname(options.ownershipFile)), path.basename(options.ownershipFile));
    try {
      fs.renameSync = function (file, target) {
        if (target === blocked) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        return original.call(this, file, target);
      };
      assert.equal(ensureInboundMcpSetup(launch, options).ok, false);
      assert.equal(readInboundMcpSetupStatus(launch, options).ok, false);
    } finally { fs.renameSync = original; }
    assert.equal(ensureInboundMcpSetup(launch, options).ok, true);
  });
  test('external edits made during preparation win over the installer and no owned temp files leak', () => {
    const options = fixture('drift'); const file = options.files[0].path; write(file, { user: 'original' });
    const originalOpen = fs.openSync, originalWrite = fs.writeFileSync; let injected = false;
    const physical = fs.realpathSync(file);
    try {
      fs.openSync = function (target, ...args) { const fd = originalOpen.call(this, target, ...args); if (!injected && String(target).startsWith(physical + '.')) { injected = true; originalWrite(file, '{"user":"external edit"}'); } return fd; };
      assert.equal(ensureInboundMcpSetup(launch, options).engines[0].state, 'error');
    } finally { fs.openSync = originalOpen; }
    assert.equal(fs.readFileSync(file, 'utf8'), '{"user":"external edit"}');
    assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')), false);
  });
  test('directory links are preserved; new POSIX files are private and existing modes survive updates', () => {
    const options = fixture('links'); const target = path.join(temporary, 'linked-config'); fs.mkdirSync(target);
    const logical = path.dirname(options.files.find(file => file.id === 'cursor').path); fs.mkdirSync(path.dirname(logical), { recursive: true });
    fs.symlinkSync(target, logical, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(ensureInboundMcpSetup(launch, options).ok, true); assert.equal(fs.lstatSync(logical).isSymbolicLink(), true);
    assert.ok(fs.existsSync(path.join(target, 'mcp.json')));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(options.files[0].path).mode & 0o777, 0o600);
      fs.chmodSync(options.files[0].path, 0o640);
      assert.equal(ensureInboundMcpSetup({ ...launch, args: ['/new/entry.mjs'] }, options).ok, true);
      assert.equal(fs.statSync(options.files[0].path).mode & 0o777, 0o640);
    }
  });
  test('corrupt ownership never becomes empty trust; missing launch cannot write engine files', () => {
    const options = fixture('bad-ledger'); write(options.ownershipFile, '{broken');
    assert.equal(ensureInboundMcpSetup(launch, options).ok, false); assert.equal(fs.readFileSync(options.ownershipFile, 'utf8'), '{broken');
    assert.ok(options.files.every(file => !fs.existsSync(file.path)));
    const empty = fixture('missing-launch'); assert.equal(ensureInboundMcpSetup(null, empty).ok, false); assert.ok(empty.files.every(file => !fs.existsSync(file.path)));
  });
  console.log(`inbound-mcp-auto-setup: ${checks} fixture groups passed`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
