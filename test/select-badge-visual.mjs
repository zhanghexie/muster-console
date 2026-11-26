/** 运行方式下拉：GUI / TUI 必须以右侧胶囊呈现，且胶囊真的看得见。
 * 断言：每个选项带胶囊、不挤压名称（不超出选项右缘）、描边对比度 ≥1.25、文字对比度 ≥4.5。 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireTestLease } from './helpers/lease.mjs';
import { execute } from './helpers/execute.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = acquireTestLease(root);
try {
const result = await execute(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/select-badge.tsx',
  '--scenario', 'test/fixtures/select-badge-scenario.mjs',
  '--target', 'body', '--styles', 'base,settings',
  '--out', '.tmp/ui-captures/select-badge-regression',
  '--themes', 'light,dark', '--widths', '900', '--height', '600'
], { cwd: root, env: process.env, timeoutMs: 55000 });
process.stdout.write(result.out);
if (result.timedOut) throw new Error('Select badge verification timed out; incomplete.');
process.exitCode = result.code;
} finally { release(); }
