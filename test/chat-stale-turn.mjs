/**
 * 聊天转写「时间衰减」纯函数（R-23 一期）：
 * 阈值判定 / 恰好压线边界 / 缺时间戳与非法值回落「近期可展开」（保守策略）。
 * 运行: node test/chat-stale-turn.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-stale-turn-'));
const compile = createSharedCompiler(root, tmp);

const { isStaleTurn, STALE_TURN_MS } = await import(
  pathToFileURL(compile('shared/chatStaleTurn.ts')).href
);

const now = 1_800_000_000_000;

// 阈值常量：24h
assert.equal(STALE_TURN_MS, 24 * 60 * 60_000);

// 远期（超阈值）→ 已衰减
assert.equal(isStaleTurn(now - STALE_TURN_MS - 1, now), true);
// 近期 → 可展开
assert.equal(isStaleTurn(now - STALE_TURN_MS + 1, now), false);
assert.equal(isStaleTurn(now, now), false);
// 恰好压线 = 已衰减（>= 判定）
assert.equal(isStaleTurn(now - STALE_TURN_MS, now), true);

// 缺时间戳回落「近期」（保守可展开，不静默吞内容）
assert.equal(isStaleTurn(undefined, now), false);
assert.equal(isStaleTurn(null, now), false);
// guiWorker 迁移路径把缺 ts 归一成 0
assert.equal(isStaleTurn(0, now), false);
assert.equal(isStaleTurn(Number.NaN, now), false);
assert.equal(isStaleTurn(-1, now), false);
// 未来时间戳（时钟回拨/漂移）不衰减
assert.equal(isStaleTurn(now + 60_000, now), false);

// 自定义阈值
assert.equal(isStaleTurn(1000, 2000, 500), true);
assert.equal(isStaleTurn(1500, 2000, 500), true); // 恰好压线
assert.equal(isStaleTurn(1501, 2000, 500), false);

console.log('chat-stale-turn: ok');
