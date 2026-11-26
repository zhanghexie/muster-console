/** Build + Electron E2E share the same three-minute budget, opt-in only. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { execute } from '../test/helpers/execute.mjs';
import { acquireTestLease } from '../test/helpers/lease.mjs';
import { testDeadline } from '../test/helpers/resources.mjs';
import { e2eEnvironment } from '../test/helpers/e2eEnvironment.mjs';

const root = path.resolve(import.meta.dirname, '..');
try { acquireTestLease(root); }
catch (error) { console.error(error.message); process.exit(1); }
const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js');
const playwright = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const deadline = testDeadline(175_000);
const env = e2eEnvironment(process.env, deadline);
for (const args of [[vite, 'build'], [playwright, 'test', ...process.argv.slice(2)]]) {
  const left = deadline - Date.now();
  if (left <= 0) { console.error('test:e2e：三分钟预算已用完，验证未完成。'); process.exit(1); }
  const result = await execute(process.execPath, args, { cwd: root, env, timeoutMs: left });
  if (result.out.trim()) console.log(result.out.trimEnd());
  if (result.timedOut) console.error('test:e2e：三分钟预算已用完，已终止构建/测试进程树，验证未完成。');
  if (result.code !== 0) process.exit(1);
}
