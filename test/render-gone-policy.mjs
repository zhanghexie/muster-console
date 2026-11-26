/**
 * 渲染进程死亡自动恢复的滑动窗口限频决策。
 * 还原修复（窗口判断改成"次数>上限仍 reload"或旧戳不清理）时本文件应转红。
 * 运行: node test/render-gone-policy.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-gone-'));
const compile = createSharedCompiler(root, tmp);
const { decideRenderGoneReload } = await import(
  pathToFileURL(compile('shared/renderGonePolicy.ts')).href
);

const OPTS = { windowMs: 60_000, maxReloads: 2 };

// 窗口内第 1、2 次死亡：reload，并累计时间戳
let recent = [];
let d = decideRenderGoneReload(recent, 1_000, OPTS);
assert.equal(d.reload, true);
assert.match(d.note, /reload 1\/2/);
recent = d.recent;

d = decideRenderGoneReload(recent, 10_000, OPTS);
assert.equal(d.reload, true);
assert.match(d.note, /reload 2\/2/);
recent = d.recent;

// 窗口内第 3 次：停手，note 说明上限；recent 不再增长
d = decideRenderGoneReload(recent, 20_000, OPTS);
assert.equal(d.reload, false);
assert.match(d.note, /limit reached/);
assert.deepEqual(d.recent, recent);

// 滑出窗口：旧戳被清理，恢复 reload
d = decideRenderGoneReload(recent, 1_000_000, OPTS);
assert.equal(d.reload, true);
assert.match(d.note, /reload 1\/2/);
assert.deepEqual(d.recent, [1_000_000]);

// 边界：恰好等于 windowMs 的旧戳不算窗内（严格小于）
d = decideRenderGoneReload([0], 60_000, OPTS);
assert.equal(d.reload, true);
assert.deepEqual(d.recent, [60_000]);

console.log('render-gone-policy: ok');
