import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-cli-'));
const builtinsDir = path.join(repo, 'src/main/runtime/builtins');
const originalPath = process.env.PATH;
const runtimeId = 'qwen-cli';
const cwd = path.join(tmp, 'project with spaces');
const otherCwd = path.join(tmp, 'other project');
const bin = path.join(tmp, 'fixture bin');

try {
  for (const dir of [bin, cwd, otherCwd]) await fs.mkdir(dir);
  const fixture = path.join(bin, 'fake-qwen.cjs');
  await fs.writeFile(fixture, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(process.argv.slice(2), ['sessions', 'list', '--json', '--limit', '10000']);
if (fs.existsSync('lookup-error')) process.exit(1);
if (fs.existsSync('lookup-truncated')) process.stderr.write('Note: 1 sessions shown, more available. Use --limit to show more.\\n');
if (fs.existsSync('sessions.jsonl')) process.stdout.write(fs.readFileSync('sessions.jsonl'));
`);
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(bin, 'qwen.cmd'), `@"${process.execPath}" "${fixture}" %*\r\n`);
  } else {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await fs.writeFile(path.join(bin, 'qwen'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
  }
  process.env.PATH = [bin, originalPath].join(path.delimiter);

  const compile = createSharedCompiler(repo, path.join(tmp, 'compiled'));
  const { RuntimeHost } = await import(pathToFileURL(compile('main/runtime/host.ts')).href);
  const host = new RuntimeHost({ userDataDir: path.join(tmp, 'user-data'), builtinsDir });
  // Existing installations must receive the new script through the seed upgrade.
  const scripts = path.join(host.rootDir, 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  await fs.copyFile(path.join(builtinsDir, 'registry.json'), path.join(host.rootDir, 'registry.json'));
  const registryPath = path.join(host.rootDir, 'registry.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const entry = registry.runtimes.find(item => item.id === runtimeId);
  Object.assign(entry, { builtinScriptVersion: 1, label: 'My Qwen CLI', extraArgs: ['--model', 'fixture-model'] });
  await fs.writeFile(registryPath, JSON.stringify(registry));
  await fs.writeFile(path.join(scripts, entry.script), "export { allocate, resolveLaunch } from './obsolete.mjs';");
  await host.ensureSeeded();
  assert.equal(host.get(runtimeId).label, 'My Qwen CLI');

  const args = host.get(runtimeId).extraArgs;
  const commandArgs = launch => {
    if (process.platform !== 'win32') return launch.args.join(' ');
    assert.equal(launch.command, 'cmd.exe');
    assert.equal(launch.windowsVerbatimArguments, true);
    return launch.args[3].slice(launch.args[3].indexOf('.cmd"') + '.cmd" '.length);
  };
  const probe = await host.resolveLaunch(runtimeId, 'start', '__muster_preflight__', cwd, args, undefined, true);
  assert.equal(commandArgs(probe), '--model fixture-model');
  const first = await host.allocate(runtimeId, cwd);
  const second = await host.allocate(runtimeId, cwd);
  const start = await host.resolveLaunch(runtimeId, 'start', first, cwd, args);
  assert.equal(commandArgs(start), `--session-id ${first} --model fixture-model`);
  assert.equal(await host.canResume(runtimeId, cwd, first), false, 'empty sessions have no saved native history');
  assert.deepEqual(await host.checkTerminalResume(runtimeId, cwd, undefined), { status: 'unbound' });
  assert.deepEqual(await host.checkTerminalResume(runtimeId, cwd, first), { status: 'missing' });
  const records = [second, first].map(sessionId => JSON.stringify({ sessionId })).join('\n');
  await fs.writeFile(path.join(cwd, 'sessions.jsonl'), records);
  assert.equal(await host.canResume(runtimeId, cwd, first), true, 'an older session in the same project is matched by ID');
  assert.deepEqual(await host.checkTerminalResume(runtimeId, cwd, first), { status: 'attempt' });
  assert.equal(await host.canResume(runtimeId, otherCwd, first), false, 'history lookup is scoped to the launch cwd');
  assert.equal(await host.canResume(runtimeId, cwd, randomUUID()), false, 'legacy placeholder IDs match no history');
  const resume = await host.resolveLaunch(runtimeId, 'resume', first, cwd, args);
  assert.equal(commandArgs(resume), `--resume ${first} --model fixture-model`);

  await fs.writeFile(path.join(otherCwd, 'lookup-error'), '');
  assert.equal((await host.checkTerminalResume(runtimeId, otherCwd, first)).status, 'failed');
  await assert.rejects(host.canResume(runtimeId, otherCwd, first), /Could not check saved Qwen CLI sessions/);
  await fs.rm(path.join(otherCwd, 'lookup-error'));
  await fs.writeFile(path.join(otherCwd, 'lookup-truncated'), '');
  await assert.rejects(host.canResume(runtimeId, otherCwd, first), /truncated/);

  const override = ['--resume', second];
  await host.update(runtimeId, { extraArgs: override });
  assert.equal(await host.canResume(runtimeId, otherCwd, first), false, 'manual session selection skips managed lookup');
  assert.deepEqual(await host.checkTerminalResume(runtimeId, cwd, first), { status: 'unsupported' });
  await assert.rejects(host.resolveLaunch(runtimeId, 'resume', first, cwd, override), /Remove the Qwen session/);
  await assert.rejects(host.resolveLaunch(runtimeId, 'new', first, cwd, override), /Remove the Qwen session/);
  const manual = await host.resolveLaunch(runtimeId, 'start', first, cwd, override);
  assert.equal(commandArgs(manual), `--resume ${second}`);
  const literal = await host.resolveLaunch(runtimeId, 'start', first, cwd, ['--', '--resume']);
  assert.equal(commandArgs(literal), `--session-id ${first} -- --resume`);
  console.log('ok: Qwen seed upgrade, native session creation and exact resume, legacy/empty fallback, and lookup failures');
} finally {
  process.env.PATH = originalPath;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
}
