import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCommandRuntime } from '../resources/extensions/build-package/command.mjs';

const scripts = { 'build:mac': 'echo mac', 'build:win': 'echo win', 'build:linux': 'echo linux' };
const entered = value => ({ cancelled: false, value });
const picked = label => ({ answers: [{ id: 'platform', selected: [label] }] });
const confirmed = { confirmed: true };

async function fixture(t, { platform = 'darwin', manifest = { version: '1.2.3', scripts }, builder = true, replies = [] } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'muster-build-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const sourceRoot = join(temp, '绑定项目 A');
  await mkdir(sourceRoot);
  const packagePath = join(sourceRoot, 'package.json');
  await writeFile(packagePath, JSON.stringify(manifest));
  if (builder) await mkdir(join(sourceRoot, 'node_modules', 'electron-builder'), { recursive: true });

  const context = {
    workspaceId: 'ws', sourceRoot, sourceRootId: 'project-a', rootsRevision: 7,
    signal: new AbortController().signal
  };
  const calls = [];
  const runtime = createCommandRuntime({ platform, broker: async (method, [name, args], actualContext) => {
    assert.equal(method, 'tool');
    assert.equal(actualContext, context);
    calls.push({ name, args });
    assert.ok(calls.length <= replies.length, `Unexpected broker call: ${name}`);
    const reply = replies[calls.length - 1];
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  } });
  const run = () => runtime.execute({ command: 'build-package', context });
  return { run, calls, context, packagePath };
}

function flow(calls) {
  return calls.map(({ name, args }) => name === 'host.ask' ? args.kind : name);
}

test('ships the toolbar action as a project extension bound to the repository root', async () => {
  const manifest = JSON.parse(await readFile(new URL('../resources/extensions/build-package/extension.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scope, 'project');
  assert.deepEqual(manifest.project, { kind: 'relative', path: '.' });
});

test('suggests the next patch from the bound package, and stabilizes prereleases', async t => {
  for (const [version, defaultValue] of [['1.2.3', '1.2.4'], ['0.0.9', '0.0.10'], ['1.2.3-beta.1', '1.2.3']]) {
    await t.test(version, async t => {
      const { run, calls } = await fixture(t, { manifest: { version, scripts }, replies: [{ cancelled: true, value: null }] });
      await run();
      assert.deepEqual(flow(calls), ['text']);
      assert.equal(calls[0].args.defaultValue, defaultValue);
    });
  }
});

test('rejects invalid or unrepresentable versions before asking for a platform', async t => {
  for (const value of ['', '1.2', '01.2.3', '1.2.3-beta.01', '1.2.3+abc', '1.2.9007199254740992', '1.2.3 && echo invalid']) {
    await t.test(JSON.stringify(value), async t => {
      const { run, calls } = await fixture(t, { replies: [entered(value)] });
      await assert.rejects(run, /打包版本号.*有效的版本号/);
      assert.deepEqual(flow(calls), ['text']);
    });
  }
});

test('cancelling or refusing any dialog leaves the project and terminal untouched', async t => {
  const version = entered('1.2.4'), platform = picked('macOS');
  const cases = [
    ['text cancelled', [{ cancelled: true, value: null }], ['text']],
    ['choice cancelled by the host', [version, new Error('Error: Question was aborted before the user answered')], ['text', 'choice']],
    ['choice returned no answer', [version, { answers: [] }], ['text', 'choice']],
    ['confirmation cancelled', [version, platform, { confirmed: false, cancelled: true }], ['text', 'choice', 'confirm']],
    ['confirmation refused', [version, platform, { confirmed: false }], ['text', 'choice', 'confirm']]
  ];
  for (const [name, replies, expected] of cases) {
    await t.test(name, async t => {
      const { run, calls, packagePath } = await fixture(t, { replies });
      const original = await readFile(packagePath, 'utf8');
      await run();
      assert.deepEqual(flow(calls), expected);
      assert.equal(await readFile(packagePath, 'utf8'), original);
    });
  }
});

test('requires a listed platform and propagates unrelated choice failures', async t => {
  const cases = [
    [{ answers: [{ id: 'platform', selected: [], custom: 'macOS' }] }, /请选择列表中的/],
    [new Error('Extension live binding changed'), /live binding changed/]
  ];
  for (const [reply, error] of cases) {
    const { run, calls } = await fixture(t, { replies: [entered('1.2.4'), reply] });
    await assert.rejects(run, error);
    assert.deepEqual(flow(calls), ['text', 'choice']);
  }
});

test('checks for the selected script and electron-builder after confirmation', async t => {
  const cases = [
    ['script missing', { manifest: { version: '1.2.3', scripts: { 'build:mac': 'echo mac' } } }, /缺少 build:linux 脚本/],
    ['electron-builder missing', { builder: false }, /node_modules\/electron-builder.*npm install/]
  ];
  for (const [name, options, error] of cases) {
    await t.test(name, async t => {
      const { run, calls } = await fixture(t, { ...options, replies: [entered('1.2.4'), picked('Linux'), confirmed] });
      await assert.rejects(run, error);
      assert.deepEqual(flow(calls), ['text', 'choice', 'confirm']);
    });
  }
});

test('stops before opening a terminal if the package version changes during confirmation', async t => {
  const replies = [entered('1.2.4'), picked('macOS')];
  const { run, calls, packagePath } = await fixture(t, { replies });
  replies.push(async () => {
    await writeFile(packagePath, JSON.stringify({ version: '1.2.5', scripts }));
    return confirmed;
  });
  await assert.rejects(run, /项目版本发生了变化/);
  assert.deepEqual(flow(calls), ['text', 'choice', 'confirm']);
});

test('maps the target to its build script and opens the bound terminal with the local shell', async t => {
  const cases = [
    ['darwin', 'macOS', 'zsh', 'Windows', 'build:win', { sessionId: 'build-shell' }],
    ['win32', 'Windows', 'powershell', 'Linux', 'build:linux', { sessionId: 'build-shell' }],
    ['linux', 'Linux', 'bash', 'macOS', 'build:mac', { id: 'build-shell' }]
  ];
  for (const [platform, localLabel, shellProfileId, targetLabel, script, session] of cases) {
    await t.test(platform, async t => {
      const version = '1.2.4-beta.1';
      const { run, calls, context } = await fixture(t, {
        platform, replies: [entered(` ${version} `), picked(targetLabel), confirmed, session, { written: true }]
      });
      await run();
      assert.deepEqual(flow(calls), ['text', 'choice', 'confirm', 'host.terminal.create', 'host.terminal.write']);
      const [{ options }] = calls[1].args.questions;
      assert.deepEqual(options[0], { label: localLabel, description: '当前平台（默认）' });
      assert.deepEqual(options.map(option => option.label).sort(), ['Linux', 'Windows', 'macOS']);
      const command = `npm version ${version} --no-git-tag-version && npm run ${script}`;
      assert.equal(calls[2].args.detail, command);
      assert.deepEqual(calls[3].args, {
        name: `一键打包 v${version}`, shellProfileId, cwd: context.sourceRoot,
        rootId: context.sourceRootId, rootsRevision: 7, select: true
      });
      const text = platform === 'win32' ? `cmd.exe /d /s /c "${command}"` : command;
      assert.deepEqual(calls[4].args, { sessionId: 'build-shell', text, submit: true, enterCount: 1 });
    });
  }
});

test('omits npm version for an unchanged version and keeps terminal fields within their limits', async t => {
  const version = `1.2.3-beta.${'x'.repeat(220)}`;
  const { run, calls } = await fixture(t, {
    manifest: { version, scripts }, replies: [entered(version), picked('macOS'), confirmed, { sessionId: 'build-shell' }, { written: true }]
  });
  await run();
  assert.equal(calls[2].args.detail, 'npm run build:mac');
  assert.equal(calls[3].args.name.length, 60);
  assert.equal(calls[4].args.text, 'npm run build:mac');
  assert.ok(Buffer.byteLength(calls[4].args.text, 'utf8') <= 8 * 1024);
});

test('propagates terminal failures without retrying or writing to a different session', async t => {
  const createFailed = new Error('Shell profile unavailable');
  const writeFailed = new Error('Terminal process exited');
  for (const [terminalReplies, error] of [
    [[createFailed], /Shell profile unavailable/],
    [[{}], /未返回打包终端的会话 ID/],
    [[{ sessionId: 'build-shell' }, writeFailed], /Terminal process exited/]
  ]) {
    const { run, calls } = await fixture(t, { replies: [entered('1.2.4'), picked('macOS'), confirmed, ...terminalReplies] });
    await assert.rejects(run, error);
    assert.deepEqual(flow(calls).slice(3), ['host.terminal.create', 'host.terminal.write'].slice(0, terminalReplies.length));
  }
});
