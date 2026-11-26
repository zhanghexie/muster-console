import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-manifest-'));
const root = path.resolve(import.meta.dirname, '..');
const builtinsDir = path.join(root, 'src/main/runtime/builtins');
const compile = createSharedCompiler(root, path.join(tmp, 'compile'));
const load = entry => import(pathToFileURL(compile(entry)).href);

try {
  const { RuntimeHost } = await load('main/runtime/host.ts');
  const { confirmRuntimeRegistration } = await load('main/capabilities/hosts/runtimes.ts');
  const { getAcpPresets, resolveAcpLaunch } = await load('main/agentSession/drivers/acp/agents.ts');
  const { manifestLaunch } = await load('main/runtime/manifestLaunch.ts');
  const { extractCliToken } = await load('shared/runtimePreflight.ts');
  const userDataDir = path.join(tmp, 'userdata');
  const open = async () => {
    const host = new RuntimeHost({ userDataDir, builtinsDir });
    await host.ensureSeeded();
    return host;
  };
  let host = await open();
  const manifest = {
    id: 'manifest-fixture', label: 'Fixture Runtime', installUrl: 'https://example.org/install',
    terminal: { command: process.execPath, args: ['--model', 'old', '--fixed'] },
    chat: { transport: 'acp', command: process.execPath, args: ['--acp'] },
    capabilities: { model: true, reasoning: { flag: '--effort', levels: ['high'] } },
  };
  let confirmation = false;
  let reviewCount = 0;
  const context = () => ({ runtimes: host, config: { get: () => ({}) }, ui: {
    confirm: async (title, detail, opts) => {
      reviewCount++;
      assert.equal(opts.dangerous, true);
      assert.match(title, /终端仅启动|terminal can start a new process only/);
      assert.deepEqual(JSON.parse(detail), manifest);
      return confirmation;
    },
  } });
  assert.equal(await confirmRuntimeRegistration(context(), manifest), null);
  assert.equal(host.get(manifest.id), undefined);
  assert.equal(getAcpPresets(userDataDir).some(preset => preset.id === manifest.id), false);
  await assert.rejects(confirmRuntimeRegistration(context(), { ...manifest, scriptSource: 'invalid' }), /unknown fields/);
  await assert.rejects(confirmRuntimeRegistration(context(), { ...manifest, id: 'qwen' }), /qwen/);
  await assert.rejects(confirmRuntimeRegistration(context(), { ...manifest, terminal: { command: path.join(tmp, 'missing.exe') } }), /not found/);
  assert.equal(reviewCount, 1);

  confirmation = true;
  const registered = await confirmRuntimeRegistration(context(), manifest);
  assert.equal(registered.id, manifest.id);
  assert.equal(registered.manifestApproval, undefined);
  host = await open();
  assert.deepEqual(host.get(manifest.id).manifest, manifest);
  assert.throws(() => host.prepareManifest(manifest), /manifest-fixture/);
  await assert.rejects(host.update(manifest.id, { extraArgs: ['--different'] }), /approved manifest/);
  assert.ok(await host.allocate(manifest.id, tmp));
  const terminal = await host.resolveLaunch(manifest.id, 'start', 'test', tmp, [], undefined, false, undefined, { model: 'new', reasoning: 'high' });
  assert.deepEqual(terminal, { command: process.execPath, args: ['--fixed', '--model', 'new', '--effort', 'high'] });
  assert.deepEqual(await host.checkTerminalResume(manifest.id, tmp, 'test'), { status: 'unsupported' });
  assert.deepEqual(await host.resolveLaunch(manifest.id, 'new', 'new-id', tmp, [], undefined, false, undefined, { model: 'new', reasoning: 'high' }), terminal);
  await assert.rejects(host.resolveLaunch(manifest.id, 'resume', 'test', tmp, []), /cannot restore/);
  const presets = getAcpPresets(userDataDir);
  assert.deepEqual(resolveAcpLaunch(manifest.id, undefined, presets).args, ['--acp']);
  const codeBuddy = presets.find(preset => preset.id === 'codebuddy-cli');
  assert.ok(codeBuddy?.manifest);
  assert.equal(codeBuddy.mcpPermissionMetadata?.toolNameKey, 'codebuddy.ai/toolName');
  host.restoreBuiltins();
  assert.ok(host.get(manifest.id));

  const registry = path.join(host.rootDir, 'registry.json');
  const edited = JSON.parse(fs.readFileSync(registry, 'utf8'));
  edited.runtimes.find(entry => entry.id === manifest.id).manifest.chat.args = ['--changed'];
  fs.writeFileSync(registry, JSON.stringify(edited));
  host = await open();
  assert.equal(host.get(manifest.id), undefined);
  assert.equal(getAcpPresets(userDataDir).some(preset => preset.id === manifest.id), false);

  const args = ['--name', 'two words', 'a&b', ''];
  const windows = manifestLaunch('C:\\Agent Tools\\agent.cmd', args, 'win32');
  assert.equal(path.win32.basename(windows.command), 'cmd.exe');
  assert.deepEqual(windows.args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  assert.match(windows.args[4], /"C:\\Agent Tools\\agent\.cmd" --name "two words" "a&b" ""$/);
  assert.equal(extractCliToken(windows), 'C:\\Agent Tools\\agent.cmd');
  assert.equal(windows.windowsVerbatimArguments, true);
  for (const unsupported of ['%PATH%', 'x!x', 'a"b', 'a\nb']) {
    assert.throws(() => manifestLaunch('C:\\agent.cmd', [unsupported], 'win32'), /cannot safely pass/);
  }
  for (const platform of ['darwin', 'linux']) assert.deepEqual(manifestLaunch('/opt/agent', args, platform), { command: '/opt/agent', args });
  console.log('ok: runtime review, persistence, ACP preset, terminal arguments and three-platform launch policies');
} finally {
  assert.equal(path.dirname(tmp), os.tmpdir());
  assert.match(path.basename(tmp), /^runtime-manifest-/);
  fs.rmSync(tmp, { recursive: true, force: true });
}
