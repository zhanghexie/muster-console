/**
 * 无头 LLM 读屏门控：hash 不变不调、前两路未失效不调、输出只能三档。
 * Run: node test/screen-classify.mjs
 */
import assert from 'node:assert/strict';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-classify-'));

const out = createSharedCompiler(root, tmp)('shared/screenClassify.ts');
const {
  hashScreenText,
  parseScreenClassifyOutput,
  shouldScreenClassify,
  shouldScreenClassifyCheap,
  SCREEN_CLASSIFY_GRACE_MS,
  SCREEN_CLASSIFY_STALE_MS,
  SCREEN_CLASSIFY_MIN_INTERVAL_MS
} = await import(pathToFileURL(out).href);

const NOW = 2_000_000_000_000;
const base = (over = {}) => ({
  now: NOW,
  createdAt: NOW - SCREEN_CLASSIFY_GRACE_MS - 1,
  currentHash: 'aaa',
  ...over
});

assert.equal(parseScreenClassifyOutput('idle'), 'idle');
assert.equal(parseScreenClassifyOutput('needs_you\nextra'), 'needs_you');
assert.equal(parseScreenClassifyOutput('DONE'), 'done');
assert.equal(parseScreenClassifyOutput('working'), 'unknown');
assert.equal(parseScreenClassifyOutput('maybe idle?'), 'unknown');

assert.notEqual(hashScreenText('a'), hashScreenText('b'));
assert.equal(hashScreenText('same'), hashScreenText('same'));

assert.equal(shouldScreenClassify(base({ lifecycle: 'exited' })).ok, false);
assert.equal(shouldScreenClassify(base({ lifecycle: 'exited' })).reason, 'exited');
assert.equal(shouldScreenClassify(base({ inFlight: true })).reason, 'in_flight');
assert.equal(
  shouldScreenClassify(base({ nextAllowedAt: NOW + 1000 })).reason,
  'backoff'
);
assert.equal(
  shouldScreenClassify(base({ lastClassifyAt: NOW - 1000 })).reason,
  'interval'
);

assert.equal(
  shouldScreenClassify(
    base({ activity: { kind: 'blocked', ts: NOW - SCREEN_CLASSIFY_STALE_MS - 1 } })
  ).reason,
  'hook_needs_you'
);
assert.equal(
  shouldScreenClassify(base({ activity: { kind: 'waiting_input', ts: NOW } })).reason,
  'hook_needs_you'
);
assert.equal(
  shouldScreenClassify(base({ activity: { kind: 'active', ts: NOW - 1000 } })).reason,
  'fresh_hook_active'
);

assert.equal(
  shouldScreenClassify(
    base({ phase: { value: 'done', source: 'model', ts: NOW - SCREEN_CLASSIFY_STALE_MS - 1 } })
  ).reason,
  'model_terminal',
  '已有 model done 不准调'
);
assert.equal(
  shouldScreenClassify(base({ phase: { value: 'needs_you', source: 'model', ts: NOW } })).reason,
  'model_terminal'
);

assert.equal(
  shouldScreenClassifyCheap({
    now: NOW,
    createdAt: NOW - 1000,
    lifecycle: 'working'
  }).reason,
  'grace',
  '宽限内无信号不调'
);

const staleHook = {
  activity: { kind: 'active', ts: NOW - SCREEN_CLASSIFY_STALE_MS - 1 }
};
assert.equal(shouldScreenClassify(base(staleHook)).ok, true, '信号过期才调');

assert.equal(
  shouldScreenClassify(base({ lastHash: 'aaa', currentHash: 'aaa', ...staleHook })).reason,
  'hash_unchanged',
  'hash 不变不调'
);
assert.equal(
  shouldScreenClassify(base({ lastHash: 'old', currentHash: 'aaa', ...staleHook })).ok,
  true,
  '内容变了才调'
);

assert.equal(
  shouldScreenClassify(
    base({
      phase: { value: 'idle', source: 'model', ts: NOW - 1000 }
    })
  ).reason,
  'signals_fresh'
);
for (const ts of [NOW, NOW - SCREEN_CLASSIFY_STALE_MS - 1]) {
  assert.equal(shouldScreenClassify(base({ activity: { kind: 'idle', ts } })).reason, 'hook_idle',
    'a confirmed turn end needs no screen classification, even after the freshness window');
}

assert.ok(SCREEN_CLASSIFY_MIN_INTERVAL_MS >= 30_000);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] screen-classify');
