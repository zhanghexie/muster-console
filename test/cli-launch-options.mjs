import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-options-'));
try {
  const compile = createSharedCompiler(process.cwd(), tmp);
  const { cliCapabilities, cliArgsForSession, normalizeCliLaunchOptions, effectiveCliLaunchOptions, supportsAutomaticCliPermissions } = await import(pathToFileURL(compile('shared/cliLaunchOptions.ts')).href);
  const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')).href);
  const registry = JSON.parse(fs.readFileSync('src/main/runtime/builtins/registry.json', 'utf8'));
  const expectedModels = ['codex', 'claude-code', 'cursor-cli', 'opencode', 'gemini', 'kimi-cli', 'grok-cli', 'commandcode-cli',
    'cline-cli', 'kilo-cli', 'github-copilot-cli', 'devin-cli', 'hermes-cli', 'pi-external-cli', 'omp-cli', 'muse-cli', 'mimo-code-cli', 'qwen-cli'];
  for (const id of expectedModels) {
    if (['codex', 'claude-code', 'cursor-cli', 'opencode', 'gemini', 'kimi-cli'].includes(id)) assert.ok(registry.runtimes.some(entry => entry.id === id && entry.surface === 'pty'), id);
    assert.equal(cliCapabilities(id).model, true, id);
    assert.deepEqual(cliArgsForSession(id, { model: 'vendor/model-v1.2' }, []), ['--model', 'vendor/model-v1.2'], id);
    for (const option of cliCapabilities(id).permissions ?? []) {
      assert.deepEqual(cliArgsForSession(id, { permission: option.value }, []), [...option.args], `${id}: ${option.value}`);
    }
    for (const option of cliCapabilities(id).modes ?? []) {
      assert.deepEqual(cliArgsForSession(id, { mode: option.value }, []), [...option.args], `${id}: ${option.value}`);
    }
  }
  for (const entry of registry.runtimes.filter(entry => entry.surface === 'pty')) {
    for (const option of cliCapabilities(entry.id).permissions ?? []) {
      assert.deepEqual(cliArgsForSession(entry.id, { permission: option.value }, []), [...option.args], `${entry.id}: ${option.value}`);
    }
    for (const option of cliCapabilities(entry.id).modes ?? []) {
      assert.deepEqual(cliArgsForSession(entry.id, { mode: option.value }, []), [...option.args], `${entry.id}: ${option.value}`);
    }
  }
  assert.deepEqual(cliArgsForSession('codex', { model: 'gpt-5', permission: 'on-request', mode: 'read-only' },
    ['-s', 'workspace-write', '-a', 'untrusted', '-c', 'approval_policy="untrusted"'], undefined, false),
    ['--model', 'gpt-5', '--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(cliArgsForSession('codex', { permission: 'on-request', mode: 'read-only' }, [], undefined, true),
    ['--ask-for-approval', 'on-request', '--sandbox', 'read-only']);
  assert.deepEqual(cliArgsForSession('muse-cli', { permission: 'on-request', mode: 'on' },
    ['--approval-judge', 'on'], undefined, false), ['--yolo']);
  assert.deepEqual(cliArgsForSession('mimo-code-cli', { mode: 'plan', model: 'provider/model' }, [], undefined, false),
    ['--model', 'provider/model', '--yolo', '--agent', 'plan']);
  assert.equal(supportsAutomaticCliPermissions('opencode'), true);
  assert.throws(() => effectiveCliLaunchOptions('claude-code', undefined, undefined, false, 0), /root.*配置权限/);
  assert.deepEqual(effectiveCliLaunchOptions('claude-code', undefined, undefined, false, 1000),
    { permission: 'bypassPermissions' });
  assert.deepEqual(effectiveCliLaunchOptions('claude-code', { permission: 'dontAsk' }, undefined, true, 0),
    { permission: 'dontAsk' });
  assert.equal(supportsAutomaticCliPermissions('kimi-cli'), false);
  assert.equal(supportsAutomaticCliPermissions('kilo-cli'), false);
  assert.deepEqual(cliArgsForSession('kilo-cli', { permission: '--auto', model: 'provider/model' }, [], undefined, false),
    ['--model', 'provider/model']);
  const missingLabels = new Set();
  for (const id of new Set([...expectedModels, 'zcode-cli', ...registry.runtimes.filter(entry => entry.surface === 'pty').map(entry => entry.id)])) {
    for (const option of [...(cliCapabilities(id).permissions ?? []), ...(cliCapabilities(id).modes ?? [])]) {
      if (option.label !== option.value && !Object.hasOwn(en, option.label)) missingLabels.add(option.label);
    }
  }
  assert.deepEqual([...missingLabels].sort(), [], 'CLI permission and mode labels need English translations');
  assert.equal(cliCapabilities('zcode-cli').model, undefined);
  assert.deepEqual(cliArgsForSession('cursor-cli', { model: 'new-model', permission: 'review' },
    ['--model', 'auto', '-f', '--sandbox', 'disabled', '--trust', '--approve-mcps']),
    ['--sandbox', 'disabled', '--trust', '--approve-mcps', '--model', 'new-model', '--auto-review']);
  assert.deepEqual(cliArgsForSession('codex', { model: 'new-model', reasoning: 'high', permission: 'ask' },
    ['-c', 'model=old', '-c', 'model_reasoning_effort=low', '--model=old', '--sandbox=read-only', '--search']),
    ['--sandbox=read-only', '--search', '--model', 'new-model', '--ask-for-approval', 'on-request', '-c', 'model_reasoning_effort=high']);
  assert.deepEqual(cliArgsForSession('codex', undefined, ['--model', 'global']), ['--model', 'global']);
  assert.deepEqual(cliArgsForSession('codex', { permission: 'untrusted', mode: 'workspace-write' }, ['--sandbox=read-only', '-c', 'sandbox_mode="read-only"']),
    ['--ask-for-approval', 'untrusted', '--sandbox', 'workspace-write']);
  assert.throws(() => normalizeCliLaunchOptions('codex', { permission: '--approve-for-me', mode: 'read-only' }), /冲突/);
  assert.deepEqual(cliArgsForSession('muse-cli', { mode: 'off' }, ['--approval-mode', 'on-request', '--approval-judge=on']),
    ['--approval-mode', 'on-request', '--approval-judge', 'off']);
  assert.deepEqual(cliArgsForSession('muse-cli', { permission: 'on-request' }, ['--approval-judge=on']),
    ['--approval-judge=on', '--approval-mode', 'on-request']);
  assert.deepEqual(cliArgsForSession('muse-cli', { permission: 'review' }, []), ['--approval-mode', 'on-request', '--approval-judge', 'on']);
  assert.deepEqual(cliArgsForSession('kimi-cli', { model: 'zhipu/glm-5.3', reasoning: 'low' }, ['--plan']), ['--plan', '--model', 'zhipu/glm-5.3']);
  assert.equal(normalizeCliLaunchOptions('kimi-cli', { reasoning: 'model_specific' }).reasoning, 'model_specific');
  assert.throws(() => normalizeCliLaunchOptions('kimi-cli', { reasoning: 'low;bad' }), /不支持/);
  for (const bad of ['-danger', 'a b', 'a%PATH%', 'a&whoami', 'a\n--yolo', 'a"b']) {
    assert.throws(() => normalizeCliLaunchOptions('codex', { model: bad }), /模型 ID/, bad);
  }
  assert.throws(() => normalizeCliLaunchOptions('codex', { permission: 'unknown' }), /不支持/);
  assert.throws(() => normalizeCliLaunchOptions('codex', { surprise: 'x' }), /未知/);
  assert.throws(() => cliArgsForSession('codex', { model: 'x' }, ['--model']), /缺少值/);
  assert.throws(() => cliArgsForSession('codex', { model: 'x' }, ['--', 'prompt']), /无法安全覆盖/);
  // The same structured options must reach native executables and Windows cmd shims.
  const { cliLaunch } = await import(pathToFileURL(path.resolve('src/main/runtime/builtins/scripts/_native.mjs')));
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const platform of ['win32', 'darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const args = cliArgsForSession('claude-code', { model: 'vendor/model-1', permission: 'edits', reasoning: 'high' }, []);
      const launch = cliLaunch(['claude', ...args], { platform, pathEnv: platform === 'win32' ? 'C:\\bin' : '/bin',
        pathExt: '.CMD', execPath: platform === 'win32' ? 'C:\\app\\electron.exe' : '/app/electron', isExecutable: () => true });
      const kimiAcp = cliLaunch(['kimi', 'acp'], { platform, pathEnv: platform === 'win32' ? 'C:\\bin' : '/bin',
        pathExt: '.CMD', execPath: platform === 'win32' ? 'C:\\app\\electron.exe' : '/app/electron', isExecutable: () => true });
      const kimiTui = cliLaunch(['kimi', '--session', 'session_abc'], { platform, pathEnv: platform === 'win32' ? 'C:\\bin' : '/bin',
        pathExt: '.CMD', execPath: platform === 'win32' ? 'C:\\app\\electron.exe' : '/app/electron', isExecutable: () => true });
      if (platform === 'win32') {
        assert.equal(launch.command, 'cmd.exe');
        for (const part of ['--model', 'vendor/model-1', '--permission-mode', 'acceptEdits', '--effort', 'high']) assert.ok(launch.args[3].includes(part), part);
        assert.ok(kimiAcp.args[3].includes(' acp'));
        assert.ok(kimiTui.args[3].includes('--session session_abc'));
      } else {
        assert.deepEqual(launch.args, args);
        assert.deepEqual(kimiAcp.args, ['acp']);
        assert.deepEqual(kimiTui.args, ['--session', 'session_abc']);
      }
    }
  } finally { Object.defineProperty(process, 'platform', platformDescriptor); }
  console.log('CLI capability mapping, option validation and global argument precedence passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
