/**
 * R11：额度解析与失败率。
 * 运行: node test/llm-quota.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-quota-'));
const compile = createSharedCompiler(root, tmp);

const { classifyLlmError, computeLlmQuota } = await import(
  pathToFileURL(compile('shared/llmQuota.ts')).href
);

assert.equal(classifyLlmError('HTTP 401 Unauthorized'), 'auth');
assert.equal(classifyLlmError('invalid api key'), 'auth');
assert.equal(classifyLlmError('429 rate_limit_exceeded'), 'rate_limit');
assert.equal(classifyLlmError('insufficient_quota'), 'rate_limit');
assert.equal(classifyLlmError('流错误 connection reset'), 'other');
assert.equal(classifyLlmError(undefined), null);
assert.equal(classifyLlmError('您的账户已达到速率限制'), 'rate_limit');
assert.equal(classifyLlmError('已达到 5 小时的使用上限。您的限额将在 2026-10-18 03:09:56 重置'), 'rate_limit');
const resetAt = Date.parse('2026-10-18T03:09:56+08:00');
const capped = [{ ok: false, startedAt: resetAt - 90 * 60_000, providerId: 'zhipu', error: '已达到 5 小时的使用上限。您的限额将在 2026-10-18 03:09:56 重置' }];
assert.equal(computeLlmQuota(capped, 'zhipu', resetAt - 1000, 15 * 60_000).resetAt, resetAt);
assert.equal(computeLlmQuota(capped, 'zhipu', resetAt - 1000, 15 * 60_000).rateLimited, true);
assert.equal(computeLlmQuota(capped, 'zhipu', resetAt, 15 * 60_000).rateLimited, false);
assert.equal(computeLlmQuota(capped, 'other', resetAt - 1000, 15 * 60_000).rateLimited, false);

const now = 1_000_000;
const windowMs = 15 * 60 * 1000;
const samples = [
  { ok: true, startedAt: now - 1000, providerHint: 'glm-5.3' },
  { ok: false, error: '401 invalid api key', startedAt: now - 2000, providerHint: 'glm-5.3' },
  { ok: false, error: '429 rate_limit', startedAt: now - 3000, providerHint: 'glm-5.3' },
  { ok: false, error: '流错误', startedAt: now - 4000, providerHint: 'glm-5.3' },
  { ok: false, error: '429', startedAt: now - windowMs - 10, providerHint: 'glm-5.3' }
];
const q = computeLlmQuota(samples, 'glm', now, windowMs);
assert.equal(q.remaining, null);
assert.equal(q.remainingSource, 'not-exposed');
assert.equal(q.sampleCount, 4);
assert.equal(q.failCount, 3);
assert.equal(q.classified.auth, 1);
assert.equal(q.classified.rate_limit, 1);
assert.equal(q.classified.other, 1);
assert.equal(q.authFailed, true);
assert.equal(q.rateLimited, true);
assert.ok(Math.abs(q.failRate - 0.75) < 1e-9);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] llm-quota');
