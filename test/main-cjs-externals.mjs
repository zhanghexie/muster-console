/**
 * 主进程是 CJS bundle：externalizeDepsPlugin 会把 dependencies 变成 require("pkg")。
 * composition 静态 import 的 yaml 必须 exclude 打进 bundle；漏装或漏 exclude 时
 * 安装包一启动就「Cannot find module 'yaml'」。
 * 运行: node test/main-cjs-externals.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const viteCfg = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8');

assert.ok(pkg.dependencies?.yaml, 'yaml 须在 dependencies（打包生产依赖），不能只放 devDependencies');

assert.match(
  viteCfg,
  /externalizeDepsPlugin\(\s*\{[\s\S]*?exclude:\s*\[[^\]]*['"]yaml['"]/,
  'yaml 须从 externalizeDepsPlugin exclude 打进 out/main/index.js；否则安装包 require("yaml") 在漏装/漏打包时启动即崩'
);

let yamlResolved;
try {
  yamlResolved = require.resolve('yaml');
} catch (err) {
  assert.fail(
    `node_modules 里没有 yaml（${err.message.split('\n')[0]}）。先 npm install，否则 electron-vite 无法把它打进 bundle。`
  );
}
assert.ok(yamlResolved, 'yaml 应能 resolve');

function unresolvedFrom(entry, ids) {
  const fromEntry = createRequire(entry);
  return ids.filter(id => { try { fromEntry.resolve(id); return false; } catch { return true; } });
}
// Relative chunks resolve beside the bundle, while a genuinely missing chunk fails.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'main-cjs-externals-'));
try {
  const entry = path.join(fixture, 'index.js');
  fs.writeFileSync(entry, ''); fs.writeFileSync(path.join(fixture, 'chunk.js'), '');
  assert.deepEqual(unresolvedFrom(entry, ['./chunk.js', './missing.js']), ['./missing.js']);
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }

const builtMain = path.join(root, 'out', 'main', 'index.js');
if (fs.existsSync(builtMain)) {
  const src = fs.readFileSync(builtMain, 'utf8');
  const ids = [
    ...new Set([...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]))
  ];
  const thirdParty = ids.filter(
    (id) => !id.startsWith('node:') && id !== 'electron' && id !== 'url'
  );
  assert.ok(
    !thirdParty.includes('yaml'),
    'out/main/index.js 仍 require("yaml")——配置已要求 bundle，请重新 npm run build'
  );
  const missing = unresolvedFrom(builtMain, thirdParty);
  assert.equal(
    missing.length,
    0,
    `主进程 bundle require 不到（打包后即「Cannot find module」）: ${missing.join(', ')}`
  );
}

console.log('main-cjs-externals: all passed');
