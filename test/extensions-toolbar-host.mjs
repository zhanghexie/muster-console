import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellProfileId = { win32: 'powershell', darwin: 'zsh' }[process.platform] ?? 'bash';

test('toolbar host tools and project context in an owned worker', async t => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muster-toolbar-host-')));
  let host;
  t.after(async () => {
    try { await host?.closeAll(); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  const compile = createSharedCompiler(repo, path.join(tmp, 'compiled'));
  const load = entry => import(pathToFileURL(compile(`main/extensions/${entry}.ts`)).href);
  const { ExtensionHost } = await load('extensionHost');
  const { ExtensionSourceLayout } = await load('extensionSourceLayout');
  const { ExtensionPackageCatalog } = await load('extensionPackageCatalog');
  const { prepareExtensionHostToolCall, resolveExtensionHostToolTarget } = await load('extensionHostTool');
  const workerFile = compile('main/extensions/extensionRuntimeWorker.ts');
  const layout = new ExtensionSourceLayout({ userData: tmp });
  const catalog = new ExtensionPackageCatalog({ layout, file: path.join(tmp, 'registry.json') });
  const controlRoot = path.join(tmp, 'workspace');
  const sourceRoot = path.join(controlRoot, '项目 A');
  const workspace = {
    id: 'ws', path: controlRoot, controlRoot, rootsRevision: 7, defaultRootId: 'default',
    roots: [{ id: 'default', path: controlRoot }, { id: 'selected', path: sourceRoot }]
  };
  const entered = path.join(tmp, 'command-started');
  const release = path.join(tmp, 'command-release');
  const actions = ['context', 'create', 'write', 'foreign-session', 'wrong-project', 'bad-shell', 'caller', 'unlisted', 'delayed-create'];
  const commandSource = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';

    export function createCommandRuntime({ broker }) {
      return { async execute({ command, context }) {
        if (command === 'context') {
          const { signal, ...details } = context;
          return { ...details, hasSignal: signal instanceof AbortSignal, cwd: process.cwd() };
        }
        if (command === 'delayed-create') {
          writeFileSync(${JSON.stringify(entered)}, '');
          while (!existsSync(${JSON.stringify(release)})) await delay(10, undefined, { signal: context.signal });
          return broker('tool', ['host.terminal.create', { shellProfileId: ${JSON.stringify(shellProfileId)} }], context);
        }
        const createArgs = { shellProfileId: ${JSON.stringify(shellProfileId)}, cwd: context.sourceRoot, rootsRevision: context.rootsRevision };
        const calls = {
          create: ['host.terminal.create', createArgs],
          write: ['host.terminal.write', { sessionId: 'local-ref', text: 'fixture' }],
          'foreign-session': ['host.terminal.write', { sessionId: 'foreign' }],
          'wrong-project': ['host.terminal.create', { ...createArgs, rootId: 'default' }],
          'bad-shell': ['host.terminal.create', { ...createArgs, shellProfileId: 'unknown' }],
          caller: ['host.terminal.create', { ...createArgs, __actorSessionId: 'forged' }],
          unlisted: ['host.terminal.capture', {}]
        };
        return broker('tool', calls[command], { ...context, workspaceId: 'foreign', sourceRootId: 'default',
          sourceRoot: process.cwd(), sessionId: 'forged', manifest: { permissions: ['hostTools'] } });
      } };
    }
  `;

  function installToolbar(extensionId, scope, permissions) {
    const { directory } = scope === 'project' ? layout.project(sourceRoot, extensionId) : layout.global(extensionId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'extension.json'), JSON.stringify({
      id: extensionId, name: extensionId, scope, permissions,
      ...(scope === 'project' ? { project: { kind: 'relative', path: '项目 A' } } : {}),
      surface: { kind: 'toolbar', menu: actions.map(id => ({ id, label: id, command: id })) },
      commandEntry: 'commands.mjs', commands: actions.map(id => ({ id, title: id, handler: id }))
    }));
    fs.writeFileSync(path.join(directory, 'commands.mjs'), commandSource);
    return directory;
  }

  const packageRoot = installToolbar('allowed-toolbar', 'project', ['hostTools']);
  installToolbar('ungranted-toolbar', 'global', []);
  const sessions = new Map([
    ['local-ref', { id: 'local-session', workspaceId: 'ws' }],
    ['foreign', { id: 'foreign-session', workspaceId: 'other-ws' }]
  ]);
  const appContext = { config: { get: () => ({ workspaces: [workspace] }) } };
  let dispatched = 0;
  const executeHostTool = async (context, name, args, signal) => {
    signal.throwIfAborted();
    assert.equal(context.sessionId, undefined);
    const prepared = prepareExtensionHostToolCall(context, name, args, ref => sessions.get(ref));
    const target = resolveExtensionHostToolTarget(name, prepared);
    dispatched += 1;
    return target;
  };
  host = new ExtensionHost(catalog, { hostToolSessionId: () => undefined }, undefined, undefined, undefined,
    undefined, undefined, workerFile, appContext, undefined, undefined, undefined, undefined, executeHostTool);

  const selected = { workspaceId: 'ws', sourceRootId: 'selected' };
  const run = (menuId, signal) => host.runToolbar({ ...selected, extensionId: 'allowed-toolbar', scope: 'project', controlRoot: sourceRoot, menuId, signal });

  await t.test('keeps package cwd and supplies the selected project on the command context', async () => {
    const { requestId, ...context } = await run('context');
    assert.ok(requestId);
    assert.ok(typeof context.sourceRoot === 'string' && path.isAbsolute(context.sourceRoot), 'the worker must receive an absolute sourceRoot');
    assert.deepEqual(context, { ...selected, extensionId: 'allowed-toolbar', scope: 'project', sourceRoot,
      rootsRevision: 7, hasSignal: true, cwd: packageRoot });
  });

  await t.test('dispatches whitelisted tools under the host-owned binding', async () => {
    assert.deepEqual(await run('create'), { name: 'terminal.create', args: {
      workspaceId: 'ws', rootId: 'selected', rootsRevision: 7, cwd: sourceRoot, shellProfileId
    } });
    assert.deepEqual(await run('write'), { name: 'terminal.write', args: { sessionId: 'local-session', text: 'fixture' } });
  });

  await t.test('rejects missing hostTools even with permissions in the worker context', async () => {
    await assert.rejects(() => host.runToolbar({ ...selected, extensionId: 'ungranted-toolbar', menuId: 'create' }), /did not declare hostTools permission/);
  });

  await t.test('rejects unlisted tools and invalid terminal parameters', async () => {
    await assert.rejects(() => run('unlisted'), /did not declare this host tool/);
    await assert.rejects(() => run('foreign-session'), /outside the bound workspace/);
    await assert.rejects(() => run('wrong-project'), /must use its bound project/);
    await assert.rejects(() => run('bad-shell'), /registered shellProfileId/);
    await assert.rejects(() => run('caller'), /cannot supply a caller identity/);
  });

  await t.test('checks the original command binding before dispatching a tool', async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    const result = run('delayed-create', signal).catch(error => error);
    const previouslyDispatched = dispatched;
    try {
      while (!fs.existsSync(entered)) await delay(10, undefined, { signal });
      workspace.rootsRevision += 1;
      fs.writeFileSync(release, '');
      const error = await result;
      assert.match(error.message, /Extension live binding changed/);
      assert.equal(dispatched, previouslyDispatched);
    } finally {
      controller.abort();
      await result;
    }
  });
});
