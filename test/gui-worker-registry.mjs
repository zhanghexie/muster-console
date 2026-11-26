/**
 * GUI runtime registry 自测：内置种子 surface=chat、userData 迁移合并、
 * chat runtime 误走 pty 路径（allocate/resolveLaunch）必须明确抛错。
 * 运行: node test/gui-worker-registry.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-registry-'));
const compile = createSharedCompiler(root, tmp);

// host.ts：node 内建 + type-only './types' + shared/i18n——树式转译自动带上依赖
const hostOut = compile('main/runtime/host.ts');
const sharedOut = compile('shared/types.ts');

const { RuntimeHost } = await import(pathToFileURL(hostOut).href);
const { runtimeSurface } = await import(pathToFileURL(sharedOut).href);

const builtinsDir = path.join(root, 'src/main/runtime/builtins');

// ---------- 种子：pi surface=chat；CLI 三件 surface=pty ----------
{
  const seed = JSON.parse(fs.readFileSync(path.join(builtinsDir, 'registry.json'), 'utf8'));
  const byId = Object.fromEntries(seed.runtimes.map((r) => [r.id, r]));
  assert.equal(byId.pi?.surface, 'chat', 'pi 种子 surface=chat');
  assert.equal(byId.pi?.builtin, true);
  assert.equal(byId.cursor, undefined, 'Cursor chat is registered through the ACP preset');
  assert.equal(byId.claude?.surface, 'chat', 'claude（GUI）种子 surface=chat');
  assert.equal(byId['codex-gui']?.surface, 'chat', 'codex-gui 种子 surface=chat');
  assert.equal(byId.acp?.surface, 'chat', 'acp 种子 surface=chat');
  assert.equal(byId.codex?.surface, 'pty', 'codex（pty）与 codex-gui 是两个 runtime');
  assert.equal(byId['claude-code']?.surface, 'pty', 'claude-code（pty）与 claude（GUI）是两个 runtime');
  for (const cli of ['cursor-cli', 'claude-code', 'opencode']) {
    assert.equal(runtimeSurface(byId[cli]), 'pty', `${cli} 仍为 pty`);
  }
}

// ---------- 全新 userData：ensureSeeded 后可见 + 误走 pty 路径抛错 ----------
{
  const userData = path.join(tmp, 'fresh');
  const host = new RuntimeHost({ userDataDir: userData, builtinsDir });
  await host.ensureSeeded();
  assert.equal(runtimeSurface(host.get('pi')), 'chat');
  assert.equal(host.listEnabled().some((r) => r.id === 'pi'), true, 'pi 默认 enabled');
  await assert.rejects(
    () => host.allocate('pi', path.join(tmp, 'ws')),
    (e) => /chat|GUI/.test(e.message),
    'chat runtime allocate 必须抛错'
  );
  await assert.rejects(
    () => host.resolveLaunch('pi', 'start', 'sid', path.join(tmp, 'ws'), []),
    (e) => /chat|GUI/.test(e.message),
    'chat runtime resolveLaunch 必须抛错'
  );
  assert.throws(() => host.scriptPath('pi'), /chat|GUI/, 'chat runtime 无脚本');
}

// ---------- 旧 userData（3 个 CLI、无 surface 字段）：迁移补 pi、surface 回填 pty ----------
{
  const userData = path.join(tmp, 'legacy');
  const legacyHost = new RuntimeHost({ userDataDir: userData, builtinsDir });
  const regDir = legacyHost.rootDir;
  await legacyHost.ensureSeeded();
  const manifest = legacyHost.prepareManifest({ id: 'my-cli', label: '自定义', terminal: { command: process.execPath, args: [] } });
  legacyHost.registerManifest(manifest);
  const registryFile = path.join(regDir, 'registry.json');
  const registered = JSON.parse(fs.readFileSync(registryFile, 'utf8')).runtimes.find(row => row.id === manifest.id);
  fs.writeFileSync(registryFile, JSON.stringify({
    version: 1,
    runtimes: [
      { id: 'cursor-cli', label: 'Cursor CLI', script: 'cursor-cli.mjs', builtin: true, enabled: true, updatedAt: 123 },
      registered
    ]
  }));

  const host = new RuntimeHost({ userDataDir: userData, builtinsDir });
  await host.ensureSeeded();
  const after = host.list();
  assert.ok(after.some((r) => r.id === 'pi' && runtimeSurface(r) === 'chat'), '迁移补入 pi');
  assert.ok(after.every((r) => r.id !== 'dsh'), 'dsh runtime 不再出现（升级清理）');
  assert.ok(after.some((r) => r.id === 'cursor-cli' && runtimeSurface(r) === 'pty'), '旧条目 surface 回填 pty');
  assert.ok(after.some((r) => r.id === 'my-cli'), '用户自定义 runtime 不丢');
  assert.equal(
    runtimeSurface(after.find((r) => r.id === 'my-cli')),
    'pty',
    '无 surface 字段缺省 pty'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] gui-worker-registry');
