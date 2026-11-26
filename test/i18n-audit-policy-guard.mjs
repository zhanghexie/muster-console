import assert from 'node:assert/strict';
import { AUDIT_ACCEPTED_LINES, AUDIT_CATEGORIES } from './i18n-audit-policy.mjs';

assert.ok(AUDIT_ACCEPTED_LINES.length > 0, 'full-source i18n exceptions must be explicit');
const seen = new Set();
for (const item of AUDIT_ACCEPTED_LINES) {
  assert.match(item.file, /^src\/(main|shared)\//, `exception must stay in main/shared: ${item.file}`);
  assert.ok(Number.isInteger(item.line) && item.line > 0, `exception line must be positive: ${item.file}`);
  assert.ok(AUDIT_CATEGORIES.includes(item.category), `unknown i18n exception category: ${item.category}`);
  assert.ok(typeof item.reason === 'string' && item.reason.trim().length >= 12, `exception needs an auditable reason: ${item.file}:${item.line}`);
  const key = `${item.file}:${item.line}`;
  assert.equal(seen.has(key), false, `duplicate i18n exception: ${key}`);
  seen.add(key);
}
console.log(`i18n audit policy: ${AUDIT_ACCEPTED_LINES.length} exact classified main/shared lines`);
