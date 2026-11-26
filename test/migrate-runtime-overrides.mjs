/**
 * migrateRuntimeOverridesToHost 单测（mock host + 剥离 electron 的 config 转译）
 * 运行: node test/migrate-runtime-overrides.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-ro-'));
const compile = createSharedCompiler(root, tmp);

const migrateOut = compile('main/migrateRuntimeOverrides.ts');
const { migrateRuntimeOverridesToHost } = await import(pathToFileURL(migrateOut).href);

// mock host：cursor-cli 已有 seed extraArgs，迁移须用 config overrides 覆盖
const updates = [];
const mockHost = {
  entries: {
    'cursor-cli': {
      id: 'cursor-cli',
      enabled: true,
      extraArgs: ['--model', 'auto', '-f']
    },
    'claude-code': { id: 'claude-code', enabled: true, extraArgs: [] },
    broken: { id: 'broken', enabled: false, extraArgs: [] }
  },
  get(id) {
    return this.entries[id];
  },
  async update(id, patch) {
    updates.push({ id, patch });
    const e = this.entries[id];
    if (e && patch.extraArgs) e.extraArgs = patch.extraArgs;
  },
  listEnabled() {
    return Object.values(this.entries).filter((e) => e.enabled);
  }
};

const cfg = {
  defaultRuntime: 'broken',
  runtimeOverrides: {
    'cursor-cli': { extraArgs: ['--custom', 'flag'] },
    'claude-code': { extraArgs: ['--claude-extra'] }
  }
};

const next = await migrateRuntimeOverridesToHost(cfg, mockHost);
assert.deepEqual(next.runtimeOverrides, {}, '迁移后应清空 runtimeOverrides');
assert.equal(next.defaultRuntime, 'cursor-cli', '失效 defaultRuntime 应回退到首个 enabled');
assert.deepEqual(updates, [
  { id: 'cursor-cli', patch: { extraArgs: ['--custom', 'flag'] } },
  { id: 'claude-code', patch: { extraArgs: ['--claude-extra'] } }
], '非空 overrides.extraArgs 应覆盖 registry（含已有 seed extraArgs）');
console.log('ok: migrateRuntimeOverridesToHost');

// ConfigManager.update：显式 `{}` 须整表替换（树式转译 config.ts，electron 用临时 shim）
const userDataDir = path.join(tmp, 'userdata');
fs.mkdirSync(userDataDir, { recursive: true });
// electron shim：config.ts 只用 app.getPath('userData')；与 i18next shim 同处 tmp/node_modules
const electronDir = path.join(tmp, 'node_modules', 'electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(
  path.join(electronDir, 'package.json'),
  JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' })
);
fs.writeFileSync(
  path.join(electronDir, 'index.mjs'),
  `export const app = { getPath: () => ${JSON.stringify(userDataDir)} };\n`
);

const configEntry = compile('main/config.ts');
const { ConfigManager } = await import(pathToFileURL(configEntry).href);

const seedConfig = {
  openai: { baseUrl: 'https://example.com', apiKey: '', model: 'm' },
  workspace: process.cwd(),
  workspaces: [{ id: 'ws1', path: process.cwd(), name: 'ws', openedAt: 0 }],
  activeWorkspaceId: 'ws1',
  defaultRuntime: 'cursor-cli',
  runtimeOverrides: {
    'cursor-cli': { extraArgs: ['--old'] },
    opencode: { extraArgs: ['--legacy'] }
  },
  mcp: { enabled: true, servers: [] },
  gitExtraReposByWorkspace: {},
  dispatcherAppendPrompt: ''
};
fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify(seedConfig, null, 2));

const mgr = new ConfigManager();
const afterClear = mgr.update({ runtimeOverrides: {} });
assert.deepEqual(afterClear.runtimeOverrides, {}, 'update({ runtimeOverrides: {} }) 应清空全部键');
const persisted = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'));
assert.deepEqual(persisted.runtimeOverrides, {}, '清空 overrides 应落盘');
console.log('ok: ConfigManager.update clears runtimeOverrides');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('migrate-runtime-overrides: all passed');
