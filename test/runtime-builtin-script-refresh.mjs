/** builtin runtime 脚本随内置源刷新（ensureSeeded → refreshBuiltinScripts）。
 * 回归锚点：旧逻辑只在 registry.json 缺失时首种脚本——存量 userData 安装永远拿不到
 * builtin 脚本修复（改 src/out 重启也只加载 userData 旧副本）。本用例证明：
 * 二次 ensureSeeded 会把 builtin 脚本刷新到与内置源一致，且不碰用户自定义脚本。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-builtin-refresh-'));
const compile = createSharedCompiler(root, tmp);
const { RuntimeHost } = await import(pathToFileURL(compile('main/runtime/host.ts')).href);

// 构造最小内置源：1 个 builtin pty runtime + 1 个 chat runtime + 内置脚本目录
const builtins = path.join(tmp, 'builtins');
const scripts = path.join(builtins, 'scripts');
fs.mkdirSync(scripts, { recursive: true });
fs.writeFileSync(path.join(scripts, 'fake.mjs'), 'export const v = 1;\n');
fs.writeFileSync(path.join(builtins, 'registry.json'), JSON.stringify({
  version: 1,
  runtimes: [
    { id: 'fake', label: 'Fake', script: 'fake.mjs', builtin: true, enabled: true },
    { id: 'chat-only', label: 'Chat', surface: 'chat', builtin: true, enabled: true }
  ]
}));

const ud = path.join(tmp, 'data');
const host = new RuntimeHost({ userDataDir: ud, builtinsDir: builtins });
await host.ensureSeeded();
const dest = path.join(ud, 'agent-runtimes', 'scripts', 'fake.mjs');
assert.equal(fs.readFileSync(dest, 'utf-8'), 'export const v = 1;\n', '首种写入 builtin 脚本');

// 模拟内置更新（builtin 脚本修复），存量 userData 不重装：二次 ensureSeeded 应刷新
fs.writeFileSync(path.join(scripts, 'fake.mjs'), 'export const v = 2;\n');
await host.ensureSeeded();
assert.equal(fs.readFileSync(dest, 'utf-8'), 'export const v = 2;\n', 'builtin 脚本更新必须传播到存量 userData 副本');

// 内容一致时不重写：mtime 不变（loadModule 靠 mtime 缓存，无谓变更会触发重导入）
const stable = fs.statSync(dest).mtimeMs;
await new Promise((r) => setTimeout(r, 12));
await host.ensureSeeded();
assert.equal(fs.statSync(dest).mtimeMs, stable, '内容一致时不得重写（保 mtime 稳定）');

// 用户自定义 runtime 的脚本不在内置源里：即使 userData registry 里有同名目录也不受影响
const customDir = path.join(ud, 'agent-runtimes', 'scripts');
fs.writeFileSync(path.join(customDir, 'user-custom.mjs'), 'export const mine = true;\n');
const regPath = path.join(ud, 'agent-runtimes', 'registry.json');
const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
reg.runtimes.push({ id: 'user-custom', label: 'User', script: 'user-custom.mjs', builtin: false, enabled: true });
fs.writeFileSync(regPath, JSON.stringify(reg));
await host.ensureSeeded();
assert.equal(fs.readFileSync(path.join(customDir, 'user-custom.mjs'), 'utf-8'), 'export const mine = true;\n', '非 builtin 脚本不被刷新触碰');

// 内置脚本源文件缺失：该条目跳过不抛，保持现有副本（registry 仍可读）
fs.rmSync(path.join(scripts, 'fake.mjs'));
await host.ensureSeeded();
assert.equal(fs.readFileSync(dest, 'utf-8'), 'export const v = 2;\n', '内置脚本源缺失时保持现有副本');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok: builtin runtime 脚本随内置源刷新（传播/幂等/不碰自定义/缺源降级）');
