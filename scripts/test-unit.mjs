/** Standalone component suites also have a three-minute ceiling. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { execute } from '../test/helpers/execute.mjs';
import { acquireTestLease } from '../test/helpers/lease.mjs';
import { testDeadline } from '../test/helpers/resources.mjs';
const root = path.resolve(import.meta.dirname, '..');
try { acquireTestLease(root); }
catch (error) { console.error(error.message); process.exit(1); }
const bin = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const deadline = testDeadline(175_000);
const result = await execute(process.execPath, [bin, 'run', ...process.argv.slice(2)], { cwd: root, env: { ...process.env, TEST_DEADLINE: String(deadline) }, timeoutMs: Math.max(1, deadline - Date.now()) });
if (result.out.trim()) console.log(result.out.trimEnd());
if (result.timedOut) console.error('test:unit：三分钟预算已用完，已终止测试进程树，验证未完成。');
process.exit(result.code === 0 ? 0 : 1);
