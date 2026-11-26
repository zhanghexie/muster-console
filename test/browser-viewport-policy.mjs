/**
 * 视口 clamp 纯逻辑（browser.setViewport / resetViewport，任务 C）：正常值原样、
 * 小数取整、越界 clamp、非法值（NaN/Infinity/非数字）抛错不静默。
 * clampViewportSize 在 main/browser/tabs.ts 顶部导出——tabs.ts 依赖 electron/config
 * 等，测试侧在临时目录种一个 ESM electron stub（模块顶层只声明不调用 electron API，
 * 空实现即可安全加载），再经 createSharedCompiler 转译整个依赖链后导入断言。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-viewport-policy-'));
const compile = createSharedCompiler(root, tmp);

// electron stub（ESM 命名导出）：与 tabs.ts 及其依赖链用到的具名导入对齐
const electronDir = path.join(tmp, 'node_modules', 'electron');
fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(
  path.join(electronDir, 'package.json'),
  JSON.stringify({ name: 'electron', main: 'index.js', type: 'module' })
);
fs.writeFileSync(
  path.join(electronDir, 'index.js'),
  [
    'export const app = {};',
    'export const ipcMain = { on() {} };',
    'export const session = {};',
    'export const webContents = {};',
    'export const protocol = { registerSchemesAsPrivileged() {}, handle() {} };',
    'export const dialog = {};',
    'export const nativeImage = {};',
    'export class BrowserWindow {}',
    ''
  ].join('\n')
);

const {
  clampViewportSize,
  VIEWPORT_MIN_WIDTH,
  VIEWPORT_MAX_WIDTH,
  VIEWPORT_MIN_HEIGHT,
  VIEWPORT_MAX_HEIGHT
} = await import(pathToFileURL(compile('main/browser/tabs.ts')).href);

// 区间常量：320×320 起步，3840×2160 封顶
assert.equal(VIEWPORT_MIN_WIDTH, 320);
assert.equal(VIEWPORT_MAX_WIDTH, 3840);
assert.equal(VIEWPORT_MIN_HEIGHT, 320);
assert.equal(VIEWPORT_MAX_HEIGHT, 2160);

// 正常值原样
assert.deepEqual(clampViewportSize(800, 600), { width: 800, height: 600 });
assert.deepEqual(clampViewportSize(1920, 1080), { width: 1920, height: 1080 });

// 小数取整（Math.round 半值向上）
assert.deepEqual(clampViewportSize(800.4, 599.6), { width: 800, height: 600 });
assert.deepEqual(clampViewportSize(799.5, 600.5), { width: 800, height: 601 });

// 边界值原样（闭区间）
assert.deepEqual(clampViewportSize(320, 320), { width: 320, height: 320 });
assert.deepEqual(clampViewportSize(3840, 2160), { width: 3840, height: 2160 });
assert.deepEqual(clampViewportSize(390, 844), { width: 390, height: 844 });

// 越界 clamp：宽 [320,3840]、高 [320,2160] 各自独立收敛
assert.deepEqual(clampViewportSize(100, 50), { width: 320, height: 320 });
assert.deepEqual(clampViewportSize(9999, 9999), { width: 3840, height: 2160 });
assert.deepEqual(clampViewportSize(-1, 700), { width: 320, height: 700 });
assert.deepEqual(clampViewportSize(5000, 800), { width: 3840, height: 800 });
assert.deepEqual(clampViewportSize(500, 100), { width: 500, height: 320 });

// 非法值直接抛错（NaN/±Infinity/非数字），不静默、不回落默认值
assert.throws(() => clampViewportSize(NaN, 600), /非法视口尺寸/);
assert.throws(() => clampViewportSize(800, NaN), /非法视口尺寸/);
assert.throws(() => clampViewportSize(Infinity, 600), /非法视口尺寸/);
assert.throws(() => clampViewportSize(800, -Infinity), /非法视口尺寸/);
assert.throws(() => clampViewportSize(undefined, 600), /非法视口尺寸/);
assert.throws(() => clampViewportSize('800', 600), /非法视口尺寸/);

console.log('browser-viewport-policy: all assertions passed');
