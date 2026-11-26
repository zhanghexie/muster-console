/** Type check and the requested test scope share one wall-clock budget. */
import path from 'node:path';
import { execute } from '../test/helpers/execute.mjs';
import { acquireTestLease } from '../test/helpers/lease.mjs';
import { suiteBudgetMs, testDeadline } from '../test/helpers/resources.mjs';
import { resolveRunScope } from '../test/helpers/runScope.mjs';

const root = path.resolve(import.meta.dirname, '..');
try { acquireTestLease(root); }
catch (error) { console.error(error.message); process.exit(1); }
const runnerArgs = ['--all', ...process.argv.slice(2)];
const scope = resolveRunScope(runnerArgs, process.env, { hasFilters: runnerArgs.some(arg => !arg.startsWith('-')) });
const deadline = testDeadline(suiteBudgetMs(scope.scope));
const env = { ...process.env, TEST_DEADLINE: String(deadline) };
for (const args of [
  [path.join(root, 'scripts/typecheck.mjs')],
  [path.join(root, 'test/run.mjs'), ...runnerArgs]
]) {
  const left = deadline - Date.now();
  if (left <= 0) { console.error('test:full：时间预算已用完，验证未完成。'); process.exit(1); }
  const result = await execute(process.execPath, args, { cwd: root, env, timeoutMs: left,
    onOutput: data => process.stdout.write(data) });
  if (result.timedOut) console.error('test:full：时间预算已用完，已终止测试进程树，验证未完成。');
  if (result.code !== 0) process.exit(1);
}
