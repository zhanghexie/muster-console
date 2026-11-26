/**
 * 转写回合界线：插话用户消息闭合旧回合，其后 assistant 才是当前流。
 * 把修复还原（改回「最后一条非 queued 消息」）时本文件应转红。
 * 运行: node test/chat-turn-split.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-split-'));
const entry = path.join(root, 'src/shared/chatSurface.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'chatSurface.mjs');
fs.writeFileSync(out, outputText, 'utf8');
const { locateStreamingAssistantIndex } = await import(pathToFileURL(out).href);

const u = (queued) => ({ role: 'user', queued });
const a = () => ({ role: 'assistant' });

assert.equal(locateStreamingAssistantIndex([u(), a()], false), -1, '空闲无当前流');
assert.equal(locateStreamingAssistantIndex([u(), a()], true), 1, 'busy 时末条 assistant 是当前流');
assert.equal(
  locateStreamingAssistantIndex([u(), a(), u()], true),
  -1,
  '插话垫底尚无新回复：旧 assistant 不再算当前流'
);
assert.equal(
  locateStreamingAssistantIndex([u(), a(), u(), a()], true),
  3,
  '插话 + 新 assistant = 新回合当前流'
);
assert.equal(
  locateStreamingAssistantIndex([u(), a(), { role: 'user', queued: true }], true),
  1,
  '排队消息不是回合界线'
);
assert.equal(locateStreamingAssistantIndex([], true), -1);
assert.equal(locateStreamingAssistantIndex([u()], true), -1);

// 宿主静默插话（steering:'host'）在回合中途落进消息流，但引擎仍在同一回合里
// 流式——不把它当回合界线，否则当前 assistant 被误判为历史折叠、流式 caret 落空。
// （pi-trajectory-plan v3：透明模式的 host 插话线；还原 m.steering !== 'host' 判断应转红）
{
  const hostSteer = { role: 'user', steering: 'host' };
  assert.equal(
    locateStreamingAssistantIndex([u(), a(), hostSteer], true),
    1,
    'host 插话垫在流式 assistant 之后仍是当前回合'
  );
  assert.equal(
    locateStreamingAssistantIndex([u(), a(), { role: 'user', steering: 'send' }, a()], true),
    3,
    'send 插话之后的 assistant 是当前流'
  );
}

console.log('chat-turn-split: ok');
